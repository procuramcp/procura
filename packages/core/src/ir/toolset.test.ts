import { describe, expect, it } from "vitest";
import { IrDocument } from "./document.ts";
import { rawDocument, rawOperation } from "./test-helpers.ts";
import { resolveToolset, Toolset, ToolsetPolicy } from "./toolset.ts";

const ir = IrDocument.parse(
  rawDocument([
    rawOperation({ id: "get_item" }),
    rawOperation({ id: "update_item", method: "PUT" }),
    rawOperation({ id: "create_item", method: "POST", path: "/items" }),
    rawOperation({ id: "delete_item", method: "DELETE" }),
    rawOperation({ id: "guess_item", provenance: "inferred" }),
  ]),
);

const tool = (operationId: string, extra: Record<string, unknown> = {}) => ({
  operationId,
  name: operationId,
  description: `Tool for ${operationId}.`,
  ...extra,
});

const toolset = (tools: unknown[], policy?: unknown) =>
  Toolset.parse({ id: "demo", sourceId: "example", name: "Demo", tools, ...(policy ? { policy } : {}) });

const issueCodes = (ts: Toolset) => {
  const r = resolveToolset(ts, ir);
  return r.ok ? [] : r.issues.map((i) => i.code);
};

describe("ToolsetPolicy", () => {
  it("defaults to read-only, no destructive, no unverified", () => {
    expect(toolset([]).policy).toEqual({ allowWrites: false, allowDestructive: false, allowUnverified: false });
  });

  it("does not allow destructive without writes", () => {
    expect(ToolsetPolicy.safeParse({ allowDestructive: true }).success).toBe(false);
  });
});

describe("Toolset", () => {
  it("rejects duplicate tool names", () => {
    const r = Toolset.safeParse({
      id: "demo",
      sourceId: "example",
      name: "Demo",
      tools: [tool("get_item"), tool("update_item", { name: "get_item" })],
    });
    expect(r.success).toBe(false);
  });
});

describe("resolveToolset", () => {
  it("serves read tools under the default policy", () => {
    const r = resolveToolset(toolset([tool("get_item")]), ir);
    expect(r.ok).toBe(true);
  });

  it("refuses writes unless allowed", () => {
    expect(issueCodes(toolset([tool("update_item")]))).toEqual(["writes_not_allowed"]);
    expect(issueCodes(toolset([tool("update_item")], { allowWrites: true }))).toEqual([]);
  });

  it("refuses destructive operations unless explicitly allowed", () => {
    expect(issueCodes(toolset([tool("delete_item")], { allowWrites: true }))).toEqual(["destructive_not_allowed"]);
    expect(issueCodes(toolset([tool("delete_item")], { allowWrites: true, allowDestructive: true }))).toEqual([]);
  });

  it("refuses inferred operations unless allowed", () => {
    expect(issueCodes(toolset([tool("guess_item")]))).toEqual(["unverified_not_allowed"]);
    expect(issueCodes(toolset([tool("guess_item")], { allowUnverified: true }))).toEqual([]);
  });

  it("skips disabled tools, so a disabled write needs no opt-in", () => {
    const r = resolveToolset(toolset([tool("get_item"), tool("delete_item", { enabled: false })]), ir);
    expect(r.ok && r.tools.map((t) => t.name)).toEqual(["get_item"]);
  });

  it("fails the whole toolset on any issue", () => {
    const r = resolveToolset(toolset([tool("get_item"), tool("missing_op")]), ir);
    expect(r).toMatchObject({ ok: false, issues: [{ code: "unknown_operation", toolName: "missing_op" }] });
  });

  it("refuses a toolset for another source", () => {
    const ts = Toolset.parse({ id: "demo", sourceId: "other", name: "Demo", tools: [] });
    expect(issueCodes(ts)).toEqual(["source_mismatch"]);
  });

  it("hides pinned inputs from the agent-facing schema", () => {
    const r = resolveToolset(toolset([tool("get_item", { pinnedInputs: { item_id: "0" } })]), ir);
    if (!r.ok) throw new Error("expected ok");
    const t = r.tools[0]!;
    expect(Object.keys(t.inputSchema["properties"] as object)).toEqual(["limit"]);
    expect(t.inputSchema["required"]).toEqual([]);
    expect(t.pinnedInputs).toEqual({ item_id: "0" });
    // The operation's own schema is untouched.
    expect(Object.keys(t.operation.input["properties"] as object).sort()).toEqual(["item_id", "limit"]);
  });

  it("rejects pins for inputs that do not exist", () => {
    expect(issueCodes(toolset([tool("get_item", { pinnedInputs: { nope: 1 } })]))).toEqual(["unknown_pinned_input"]);
  });

  it("derives MCP annotations, always setting destructiveHint", () => {
    const r = resolveToolset(
      toolset(
        [tool("get_item"), tool("update_item"), tool("create_item"), tool("delete_item")],
        { allowWrites: true, allowDestructive: true },
      ),
      ir,
    );
    if (!r.ok) throw new Error("expected ok");
    const hints = Object.fromEntries(
      r.tools.map((t) => [t.name, [t.annotations.readOnlyHint, t.annotations.destructiveHint, t.annotations.idempotentHint]]),
    );
    expect(hints).toEqual({
      get_item: [true, false, true],
      update_item: [false, false, true],
      create_item: [false, false, false],
      delete_item: [false, true, true],
    });
  });
});
