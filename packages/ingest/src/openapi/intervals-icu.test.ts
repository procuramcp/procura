// Validates the OpenAPI mapper against the real Intervals.icu API description.
// See fixtures/intervals-icu/PROVENANCE.md for where the fixture came from.
import { readFileSync } from "node:fs";
import { defaultToolset, IrDocument, resolveToolset, Toolset, type Operation } from "@procura/core";
import { beforeAll, describe, expect, it } from "vitest";
import { strictAjv } from "../test-support.ts";
import { ingestOpenApiText } from "./ingest.ts";
import type { MapOpenApiResult } from "./map-openapi.ts";

const FIXTURE = new URL("../../fixtures/intervals-icu/openapi.json", import.meta.url);

let result: Extract<MapOpenApiResult, { ok: true }>;
let ops: Map<string, Operation>;

beforeAll(() => {
  const r = ingestOpenApiText(readFileSync(FIXTURE, "utf8"), { sourceId: "intervals-icu", documentUrl: "https://intervals.icu/api/v1/docs" });
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics, null, 2));
  result = r;
  ops = new Map(r.ir.operations.map((o) => [o.id, o]));
});

const op = (id: string) => {
  const o = ops.get(id);
  if (!o) throw new Error(`missing operation ${id}`);
  return o;
};

describe("Intervals.icu OpenAPI → IR", () => {
  it("maps every operation with no errors", () => {
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ir.operations).toHaveLength(148);
  });

  it("only raises the expected kinds of warnings", () => {
    const counts: Record<string, number> = {};
    for (const d of result.diagnostics) counts[d.code] = (counts[d.code] ?? 0) + 1;
    expect(counts).toEqual({
      auth_conjunction_unsatisfiable: 1, // "APIKey AND AccessToken" → either one
      wildcard_media_type: 131, // every JSON response is declared as */*
      response_media_type_unspecified: 17, // file downloads and some writes
    });
  });

  it("describes the source", () => {
    expect(result.ir.source).toMatchObject({
      id: "intervals-icu",
      name: "Intervals.icu API",
      baseUrl: "https://intervals.icu",
      authSchemes: [
        { id: "APIKey", type: "http_basic" },
        { id: "AccessToken", type: "http_bearer" },
      ],
      defaultAuth: [[{ schemeId: "APIKey", scopes: [] }], [{ schemeId: "AccessToken", scopes: [] }]],
      derivation: { ingestor: "openapi", formatVersion: "3.0.1", apiVersion: "v1.0.0" },
    });
  });

  it("is valid IR and survives a JSON round trip (as stored in Postgres jsonb)", () => {
    const roundTripped = IrDocument.parse(JSON.parse(JSON.stringify(result.ir)));
    expect(roundTripped).toEqual(result.ir);
  });

  it("produces only schemas a strict JSON Schema 2020-12 validator accepts", () => {
    const ajv = strictAjv();
    const failures: string[] = [];
    for (const o of result.ir.operations) {
      for (const [kind, schema] of [["input", o.input], ["output", o.output]] as const) {
        if (!schema) continue;
        try {
          ajv.compile(schema);
        } catch (e) {
          failures.push(`${o.id} ${kind}: ${(e as Error).message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("maps list_activities parameters and validates real-shaped input", () => {
    const o = op("list_activities");
    expect(o.mapping).toMatchObject({ method: "GET", pathTemplate: "/api/v1/athlete/{id}/activities" });
    expect(o.input["required"]).toEqual(["id", "oldest"]);
    const validate = strictAjv().compile(o.input);
    expect(validate({ id: "0", oldest: "2026-10-01", limit: 20 })).toBe(true);
    expect(validate({ id: "0" })).toBe(false);
    expect(validate({ id: "0", oldest: "2026-10-01", limit: "twenty" })).toBe(false);
    expect(validate({ id: "0", oldest: "2026-10-01", api_key: "x" })).toBe(false);
  });

  it("validates a synthetic activity list against the output schema", () => {
    const validate = strictAjv().compile(op("list_activities").output!);
    const synthetic = [{ id: "i0001", start_date_local: "2026-10-01T07:30:00", type: "Ride", moving_time: 3600, icu_training_load: 55 }];
    expect(validate(synthetic)).toBe(true);
    expect(validate([{ id: "i0001", moving_time: "an hour" }])).toBe(false);
  });

  describe("side-effect classification", () => {
    it.each([
      ["get_activity", "read"],
      ["list_activities", "read"],
      ["list_wellness_records", "read"],
      ["get_record", "read"], // the single wellness day; a name only curation can fix
      ["update_activity", "write"],
      ["create_event", "write"],
      ["delete_activity", "destructive"],
      ["delete_events", "destructive"],
      // PUT by method, but deletes data: escalated by name.
      ["delete_intervals", "destructive"],
      ["delete_events_bulk", "destructive"],
    ])("%s is %s", (id, cls) => {
      expect(op(id).sideEffect.class).toBe(cls);
    });

    it("escalates nothing else by name", () => {
      const escalated = result.ir.operations.filter((o) => o.sideEffect.basis === "name_heuristic").map((o) => o.id);
      expect(escalated).toEqual(["delete_intervals", "delete_events_bulk"]);
    });

    it("counts", () => {
      const counts = { read: 0, write: 0, destructive: 0 };
      for (const o of result.ir.operations) counts[o.sideEffect.class]++;
      expect(counts).toEqual({ read: 79, write: 55, destructive: 14 });
    });
  });

  it("the default toolset enables the 79 read tools and resolves", () => {
    const ts = defaultToolset(result.ir, { id: "intervals-default", name: "Intervals.icu" });
    expect(ts.tools).toHaveLength(148);
    const r = resolveToolset(ts, result.ir);
    expect(r.ok && r.tools.length).toBe(79);
    expect(r.ok && r.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });

  it("a user-curated toolset can pin the athlete id and enable writes", () => {
    const toolset = Toolset.parse({
      id: "intervals-mine",
      sourceId: "intervals-icu",
      name: "Intervals.icu",
      tools: [
        { operationId: "list_activities", name: "list_activities", description: "List my activities between two dates.", pinnedInputs: { id: "0" } },
        // The activity id is a real input here, so it is not pinned.
        { operationId: "update_activity", name: "update_activity", description: "Update one of my activities by id." },
      ],
    });
    const r = resolveToolset(toolset, result.ir);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.tools.map((t) => [t.name, t.annotations.readOnlyHint])).toEqual([
      ["list_activities", true],
      ["update_activity", false],
    ]);
    expect(Object.keys(r.tools[0]!.inputSchema["properties"] as object)).not.toContain("id");
  });

  it("matches the reviewed operation summary", async () => {
    const lines = result.ir.operations.map((o) => {
      const props = o.mapping.parameters.map((p) => `${p.property}${(o.input["required"] as string[]).includes(p.property) ? "" : "?"}`);
      if (o.mapping.body) props.push(`${o.mapping.body.property}:${o.mapping.body.mediaType}`);
      const effect = `${o.sideEffect.class}${o.sideEffect.basis === "http_method" ? "" : "*"}`;
      return `${o.mapping.method.padEnd(6)} ${o.mapping.pathTemplate}\n       ${o.id} [${effect}] (${props.join(", ")}) → ${o.output ? "schema" : "untyped"}/${o.mapping.response.decode} c=${o.confidence}`;
    });
    await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot("__snapshots__/intervals-icu.summary.txt");
  });
});
