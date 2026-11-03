import { describe, expect, it } from "vitest";
import { AccessProfile } from "./access.ts";
import { IrDocument } from "./ir/document.ts";
import { curateSideEffect } from "./ir/side-effect.ts";
import { rawDocument, rawOperation } from "./ir/test-helpers.ts";
import { defaultToolset, resolveToolset, Toolset } from "./ir/toolset.ts";
import { planSourceUpdate } from "./source-update.ts";

type RawOp = ReturnType<typeof rawOperation>;
const doc = (ops: RawOp[], source: Record<string, unknown> = {}) => {
  const raw = rawDocument(ops);
  return IrDocument.parse({ ...raw, source: { ...raw.source, ...source } });
};
/** Adds query inputs (each needs a parameter binding to be valid IR). */
const withInput = (op: RawOp, props: Record<string, unknown>, required: string[] = op.input.required): RawOp => ({
  ...op,
  input: { ...op.input, properties: { ...op.input.properties, ...props }, required },
  mapping: { ...op.mapping, parameters: [...op.mapping.parameters, ...Object.keys(props).map((p) => ({ property: p, in: "query", wireName: p, style: "form", explode: true }))] },
});
const curated = (ir: IrDocument, id: string, effect: "read" | "write" | "destructive") =>
  IrDocument.parse({ ...ir, operations: ir.operations.map((op) => (op.id === id ? { ...op, sideEffect: curateSideEffect(op.sideEffect, effect, "it only looks things up") } : op)) });

const current = doc([
  rawOperation({ id: "get_item" }),
  rawOperation({ id: "list_items", path: "/items" }),
  rawOperation({ id: "search_items", method: "POST", path: "/items/search" }),
  rawOperation({ id: "delete_item", method: "DELETE" }),
]);

const plan = (next: IrDocument, toolsets: Toolset[] = [], profiles: AccessProfile[] = [], from = current) =>
  planSourceUpdate({ current: from, next, toolsets, profiles, baseUrl: "current" });

describe("planSourceUpdate: the diff", () => {
  it("finds added, removed, changed, and unchanged operations", () => {
    const next = doc([
      rawOperation({ id: "get_item" }),
      withInput(rawOperation({ id: "list_items", path: "/items" }), { cursor: { type: "string" } }),
      rawOperation({ id: "search_items", method: "POST", path: "/items/search" }),
      rawOperation({ id: "create_item", method: "POST", path: "/items" }),
    ]);
    const { diff } = plan(next);
    expect(diff.added.map((o) => o.id)).toEqual(["create_item"]);
    expect(diff.removed.map((o) => o.id)).toEqual(["delete_item"]);
    expect(diff.changed).toEqual([expect.objectContaining({ id: "list_items", kinds: ["inputs"], details: ["new inputs: cursor"] })]);
    expect(diff.unchanged).toBe(2);
  });

  it("treats a new id at the same method and path as a rename", () => {
    const next = doc([rawOperation({ id: "fetch_item" }), rawOperation({ id: "list_items", path: "/items" }), rawOperation({ id: "search_items", method: "POST", path: "/items/search" }), rawOperation({ id: "delete_item", method: "DELETE" })]);
    const { diff } = plan(next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([expect.objectContaining({ id: "fetch_item", renamedFrom: "get_item" })]);
  });

  it("names removed inputs and inputs that became required", () => {
    const old = doc([withInput(rawOperation({ id: "list_items", path: "/items" }), { since: { type: "string" }, sort: { type: "string" } })]);
    const next = doc([withInput(rawOperation({ id: "list_items", path: "/items" }), { since: { type: "string" } }, ["since"])]);
    expect(plan(next, [], [], old).diff.changed[0]!.details).toEqual(["removed inputs: sort", "now required: since"]);
  });
});

describe("planSourceUpdate: people's classifications (D-043)", () => {
  it("keeps a curated class on an operation that still exists, and drops it for a removed one", () => {
    const from = curated(curated(current, "search_items", "read"), "delete_item", "write");
    const next = doc([rawOperation({ id: "get_item" }), rawOperation({ id: "search_items", method: "POST", path: "/items/search" })]);
    const result = plan(next, [], [], from);
    expect(result.ir.operations.find((o) => o.id === "search_items")!.sideEffect).toMatchObject({ class: "read", basis: "curated", reason: "it only looks things up" });
    expect(result.diff.classifications.kept).toEqual([{ id: "search_items", class: "read" }]);
    expect(result.diff.classifications.dropped).toEqual([{ id: "delete_item", class: "write" }]);
    expect(result.diff.changed).toEqual([]);
  });

  it("lets go of a curated class the new version agrees with, and reports ingest's own changes", () => {
    const from = curated(current, "search_items", "read");
    // The API now uses GET for search: ingest says read too.
    const next = doc([rawOperation({ id: "get_item" }), rawOperation({ id: "list_items", path: "/items" }), rawOperation({ id: "search_items", path: "/items/search" }), rawOperation({ id: "delete_item", method: "DELETE" })]);
    const { diff, ir } = plan(next, [], [], from);
    expect(ir.operations.find((o) => o.id === "search_items")!.sideEffect.basis).toBe("http_method");
    expect(diff.classifications.nowAutomatic).toEqual([{ id: "search_items", class: "read" }]);
    expect(diff.classifications.automaticChanged).toEqual([{ id: "search_items", from: "write", to: "read", curated: "read" }]);
  });
});

describe("planSourceUpdate: toolsets keep working", () => {
  const toolset = () => {
    const ts = defaultToolset(current, { id: "main", name: "Main" });
    return Toolset.parse({
      ...ts,
      tools: ts.tools.map((t) =>
        t.operationId === "get_item"
          ? { ...t, enabled: true, pinnedInputs: { item_id: "42" } }
          : t.operationId === "list_items"
            ? { ...t, enabled: true, description: "Edited by a person." }
            : { ...t, enabled: true },
      ),
    });
  };

  it("drops tools for removed operations, so the toolset still resolves (D-015)", () => {
    const next = doc([rawOperation({ id: "get_item" }), rawOperation({ id: "list_items", path: "/items" }), rawOperation({ id: "search_items", method: "POST", path: "/items/search" })]);
    expect(resolveToolset(toolset(), next).ok).toBe(false); // what storing the new version alone would do
    const result = plan(next, [toolset()]);
    expect(result.effects.toolsets[0]!.removedTools).toEqual([{ name: "delete_item", operationId: "delete_item", enabled: true }]);
    expect(result.toolsets).toHaveLength(1);
    expect(resolveToolset(result.toolsets[0]!, result.ir).ok).toBe(true);
    expect(result.effects.toolsets[0]!.issues).toEqual([]);
  });

  it("turns off a tool whose pinned input is gone, keeping the pin, instead of handing that input to agents", () => {
    // The path parameter was renamed: item_id is no longer an input.
    const next = doc([rawOperation({ id: "get_item", path: "/items/{id}" }), rawOperation({ id: "list_items", path: "/items" }), rawOperation({ id: "search_items", method: "POST", path: "/items/search" }), rawOperation({ id: "delete_item", method: "DELETE" })]);
    const result = plan(next, [toolset()]);
    const tool = result.toolsets[0]!.tools.find((t) => t.operationId === "get_item")!;
    expect(tool).toMatchObject({ enabled: false, pinnedInputs: { item_id: "42" } });
    expect(result.effects.toolsets[0]!.disabledTools).toEqual([{ name: "get_item", operationId: "get_item", pins: ["item_id"] }]);
  });

  it("follows renames, updates text nobody edited, and keeps edited text", () => {
    const next = doc([
      { ...rawOperation({ id: "fetch_item" }), description: "Fetches one item." },
      { ...rawOperation({ id: "list_items", path: "/items" }), description: "Lists items, newest first." },
      rawOperation({ id: "search_items", method: "POST", path: "/items/search" }),
      rawOperation({ id: "delete_item", method: "DELETE" }),
    ]);
    const result = plan(next, [toolset()]);
    const tools = result.toolsets[0]!.tools;
    expect(tools.find((t) => t.name === "get_item")).toMatchObject({ operationId: "fetch_item", description: "Fetches one item.", pinnedInputs: { item_id: "42" } });
    expect(tools.find((t) => t.name === "list_items")!.description).toBe("Edited by a person.");
    expect(result.effects.toolsets[0]).toMatchObject({ renamedTools: [{ name: "get_item", from: "get_item", to: "fetch_item" }], refreshedTexts: 1 });
  });

  it("flags enabled tools whose class changes, since that changes who may call them", () => {
    const next = doc([rawOperation({ id: "get_item" }), rawOperation({ id: "list_items", path: "/items", method: "POST" }), rawOperation({ id: "search_items", method: "POST", path: "/items/search" }), rawOperation({ id: "delete_item", method: "DELETE" })]);
    expect(plan(next, [toolset()]).effects.toolsets[0]!.sideEffectChanged).toEqual([{ name: "list_items", operationId: "list_items", from: "read", to: "write" }]);
  });

  it("leaves other sources' toolsets alone, and stores nothing for a toolset that doesn't change", () => {
    const other = Toolset.parse({ id: "other", sourceId: "elsewhere", name: "Other", tools: [] });
    const result = plan(current, [toolset(), other]);
    expect(result.toolsets).toEqual([]);
    expect(result.effects.toolsets.map((e) => e.toolsetId)).toEqual(["main"]);
  });
});

describe("planSourceUpdate: plans and source settings", () => {
  it("drops removed operations from plan rules, and rules left with none", () => {
    const toolsets = [defaultToolset(current, { id: "main", name: "Main" })];
    const profiles = [
      AccessProfile.parse({ id: "basic", name: "Basic", rules: [{ toolsetId: "main", level: "use", operations: ["get_item", "delete_item"] }] }),
      AccessProfile.parse({ id: "delete-only", name: "Deleters", rules: [{ toolsetId: "main", level: "use_writes", operations: ["delete_item"] }] }),
      AccessProfile.parse({ id: "all", name: "All", rules: [{ toolsetId: "main", level: "use" }] }),
    ];
    const next = doc([rawOperation({ id: "get_item" }), rawOperation({ id: "list_items", path: "/items" }), rawOperation({ id: "search_items", method: "POST", path: "/items/search" })]);
    const result = plan(next, toolsets, profiles);
    expect(result.profiles.map((p) => [p.id, p.rules])).toEqual([
      ["basic", [{ toolsetId: "main", level: "use", operations: ["get_item"] }]],
      ["delete-only", []],
    ]);
    expect(result.effects.profiles).toEqual([
      { profileId: "basic", name: "Basic", removedOperations: [{ toolsetId: "main", operationId: "delete_item" }], removedRules: [] },
      { profileId: "delete-only", name: "Deleters", removedOperations: [{ toolsetId: "main", operationId: "delete_item" }], removedRules: ["main"] },
    ]);
  });

  it("keeps the current base URL unless asked, and fixed usernames from the old version", () => {
    const from = doc([rawOperation({ id: "get_item" })], { baseUrl: "https://api.example.com/v1", authSchemes: [{ id: "key", type: "http_basic", fixedUsername: "API_KEY" }], defaultAuth: [[{ schemeId: "key", scopes: [] }]] });
    const next = doc([rawOperation({ id: "get_item" })], { baseUrl: "https://api.example.com/v2", authSchemes: [{ id: "key", type: "http_basic" }, { id: "token", type: "http_bearer" }], defaultAuth: [[{ schemeId: "key", scopes: [] }]] });
    const kept = planSourceUpdate({ current: from, next, toolsets: [], profiles: [], baseUrl: "current" });
    expect(kept.ir.source.baseUrl).toBe("https://api.example.com/v1");
    expect(kept.diff.baseUrl).toEqual({ current: "https://api.example.com/v1", document: "https://api.example.com/v2", used: "current" });
    expect(kept.ir.source.authSchemes[0]).toEqual({ id: "key", type: "http_basic", fixedUsername: "API_KEY" });
    expect(kept.diff.authSchemes).toEqual({ added: ["token"], removed: [], changed: [] });
    expect(planSourceUpdate({ current: from, next, toolsets: [], profiles: [], baseUrl: "document" }).ir.source.baseUrl).toBe("https://api.example.com/v2");
    expect(() => IrDocument.parse(kept.ir)).not.toThrow();
  });

  it("refuses a different source", () => {
    expect(() => planSourceUpdate({ current, next: doc([], { id: "other" }), toolsets: [], profiles: [], baseUrl: "current" })).toThrow(/source ids differ/);
  });
});
