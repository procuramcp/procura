import { describe, expect, it } from "vitest";
import { SchemaConverter, type Direction } from "./schema.ts";

const doc = (schemas: Record<string, unknown>) => ({ components: { schemas } });

function convert(schema: unknown, opts: { schemas?: Record<string, unknown>; dialect?: "3.0" | "3.1"; direction?: Direction } = {}) {
  const c = new SchemaConverter(doc(opts.schemas ?? {}), opts.dialect ?? "3.0");
  const refs = new Set<string>();
  const direction = opts.direction ?? "output";
  const root = c.convert(schema, direction, "#/test", refs);
  return { root, refs, bundled: typeof root === "object" ? c.bundle(root, direction, refs) : root };
}

describe("SchemaConverter (OpenAPI 3.0 → JSON Schema 2020-12)", () => {
  it("turns nullable into a null type", () => {
    expect(convert({ type: "string", nullable: true }).root).toEqual({ type: ["string", "null"] });
    expect(convert({ type: "string", enum: ["a"], nullable: true }).root).toEqual({ type: ["string", "null"], enum: ["a", null] });
    expect(convert({ allOf: [{ type: "object" }], nullable: true }).root).toEqual({
      anyOf: [{ allOf: [{ type: "object" }] }, { type: "null" }],
    });
  });

  it("turns example into examples", () => {
    expect(convert({ type: "integer", example: 3 }).root).toEqual({ type: "integer", examples: [3] });
  });

  it("converts boolean exclusive bounds", () => {
    expect(convert({ type: "number", minimum: 0, exclusiveMinimum: true }).root).toEqual({ type: "number", exclusiveMinimum: 0 });
    expect(convert({ type: "number", maximum: 5, exclusiveMaximum: false }).root).toEqual({ type: "number", maximum: 5 });
  });

  it("drops OpenAPI-only keywords and extensions", () => {
    expect(convert({ type: "object", discriminator: { propertyName: "k" }, xml: {}, "x-internal": true }).root).toEqual({ type: "object" });
  });

  it("rewrites component refs and bundles the transitive closure", () => {
    const { bundled, refs } = convert(
      { type: "array", items: { $ref: "#/components/schemas/A" } },
      { schemas: { A: { type: "object", properties: { b: { $ref: "#/components/schemas/B" } } }, B: { type: "string" }, Unused: {} } },
    );
    expect([...refs]).toEqual(["A"]);
    expect(bundled).toEqual({
      type: "array",
      items: { $ref: "#/$defs/A" },
      $defs: { A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } }, B: { type: "string" } },
    });
  });

  it("handles recursive components without inlining", () => {
    const { bundled } = convert(
      { $ref: "#/components/schemas/Node" },
      { schemas: { Node: { type: "object", properties: { children: { type: "array", items: { $ref: "#/components/schemas/Node" } } } } } },
    );
    expect(bundled).toEqual({
      $ref: "#/$defs/Node",
      $defs: { Node: { type: "object", properties: { children: { type: "array", items: { $ref: "#/$defs/Node" } } } } },
    });
  });

  it("ignores $ref siblings in 3.0 but keeps them in 3.1", () => {
    const schemas = { A: { type: "string" } };
    expect(convert({ $ref: "#/components/schemas/A", description: "x" }, { schemas }).root).toEqual({ $ref: "#/$defs/A" });
    expect(convert({ $ref: "#/components/schemas/A", description: "x" }, { schemas, dialect: "3.1" }).root).toEqual({
      $ref: "#/$defs/A",
      description: "x",
    });
  });

  it("inlines local refs that do not point at a whole component", () => {
    const schemas = { A: { type: "object", properties: { id: { type: "integer" } } } };
    expect(convert({ $ref: "#/components/schemas/A/properties/id" }, { schemas }).root).toEqual({ type: "integer" });
  });

  it("drops readOnly properties from input and writeOnly from output", () => {
    const schema = {
      type: "object",
      required: ["id", "password", "name"],
      properties: { id: { type: "string", readOnly: true }, password: { type: "string", writeOnly: true }, name: { type: "string" } },
    };
    const input = convert(schema, { direction: "input" }).root as Record<string, unknown>;
    const output = convert(schema, { direction: "output" }).root as Record<string, unknown>;
    expect(Object.keys(input["properties"] as object)).toEqual(["password", "name"]);
    expect(input["required"]).toEqual(["password", "name"]);
    expect(Object.keys(output["properties"] as object)).toEqual(["id", "name"]);
  });

  it("does not treat property names that look like keywords as keywords", () => {
    const { root } = convert({ type: "object", properties: { example: { type: "string" }, nullable: { type: "boolean" } } });
    expect(Object.keys((root as Record<string, object>)["properties"]!)).toEqual(["example", "nullable"]);
  });

  it("rejects external and unresolved refs", () => {
    expect(() => convert({ $ref: "other.yaml#/X" })).toThrow(/external \$ref/);
    expect(() => convert({ $ref: "#/components/schemas/Missing" })).toThrow(/not found/);
  });

  it("drops keywords that are not JSON Schema and reports each once", () => {
    const notes: string[] = [];
    const c = new SchemaConverter(doc({}), "3.0", (code, message) => notes.push(`${code}: ${message}`));
    const out = c.convert(
      { type: "object", optional: true, properties: { a: { type: "string", optional: true }, b: { $id: "x", type: "string" } } },
      "output",
      "#/test",
      new Set(),
    );
    expect(out).toEqual({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } } });
    expect(notes).toEqual([
      'unknown_schema_keyword: "optional" is not a JSON Schema 2020-12 keyword; dropped (first seen here)',
      'unknown_schema_keyword: "$id" is not a JSON Schema 2020-12 keyword; dropped (first seen here)',
    ]);
  });

  it("drops an empty enum, which would accept nothing", () => {
    const notes: string[] = [];
    const c = new SchemaConverter(doc({ Status: { type: "string", enum: ["a", "b"] } }), "3.1", (code) => notes.push(code));
    const out = c.convert({ type: "string", enum: [], allOf: [{ $ref: "#/components/schemas/Status" }] }, "input", "#/test", new Set());
    expect(out).toEqual({ type: "string", allOf: [{ $ref: "#/$defs/Status" }] });
    expect(notes).toEqual(["empty_enum"]);
  });

  it("converts contentSchema as a schema", () => {
    expect(convert({ type: "string", contentMediaType: "application/json", contentSchema: { type: "object", nullable: true } }).root).toEqual({
      type: "string",
      contentMediaType: "application/json",
      contentSchema: { type: ["object", "null"] },
    });
  });
});
