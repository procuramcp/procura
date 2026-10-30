import { describe, expect, it } from "vitest";
import { JsonSchema, ObjectJsonSchema, findRefProblems } from "./json-schema.ts";

describe("JsonSchema", () => {
  it("accepts a self-contained schema with $defs refs, including cycles", () => {
    const schema = {
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: { Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } } },
    };
    expect(JsonSchema.safeParse(schema).success).toBe(true);
  });

  it("rejects refs that leave the document", () => {
    expect(findRefProblems({ $ref: "#/components/schemas/X" })).toHaveLength(1);
    expect(findRefProblems({ $ref: "https://example.com/s.json" })).toHaveLength(1);
  });

  it("rejects refs to missing $defs", () => {
    expect(findRefProblems({ properties: { a: { $ref: "#/$defs/Missing" } } })).toEqual([
      "$ref target is missing from $defs: #/$defs/Missing",
    ]);
  });

  it("does not treat data under const/enum/default/examples as schemas", () => {
    expect(findRefProblems({ type: "object", default: { $ref: "not a schema" }, examples: [{ $ref: "x" }] })).toEqual([]);
  });

  it("rejects non-JSON values", () => {
    expect(JsonSchema.safeParse({ type: "string", default: () => 1 }).success).toBe(false);
  });

  it("requires an object root for tool input", () => {
    expect(ObjectJsonSchema.safeParse({ type: "object" }).success).toBe(true);
    expect(ObjectJsonSchema.safeParse({ type: "array" }).success).toBe(false);
  });
});
