import { describe, expect, it } from "vitest";
import { Operation } from "./operation.ts";
import { rawOperation } from "./test-helpers.ts";

const messages = (value: unknown) => {
  const r = Operation.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("Operation", () => {
  it("parses a valid operation", () => {
    expect(messages(rawOperation({ id: "get_item" }))).toEqual([]);
  });

  it("rejects ids that are not tool-safe", () => {
    expect(messages({ ...rawOperation({ id: "x" }), id: "getItem" })).not.toEqual([]);
    expect(messages({ ...rawOperation({ id: "x" }), id: "a".repeat(65) })).not.toEqual([]);
  });

  it("rejects an input property with no binding", () => {
    const op = rawOperation({ id: "get_item" });
    op.input.properties["orphan"] = { type: "string" };
    expect(messages(op)).toContain('input property "orphan" is not bound');
  });

  it("rejects a binding for a property not in the input", () => {
    const op = rawOperation({ id: "get_item" });
    op.mapping.parameters.push({ property: "ghost", in: "query", wireName: "ghost", style: "form", explode: true });
    expect(messages(op)).toContain('bound property "ghost" is not in input.properties');
  });

  it("rejects a property bound twice", () => {
    const op = rawOperation({ id: "get_item" });
    op.mapping.parameters.push({ property: "limit", in: "header", wireName: "X-Limit", style: "simple", explode: false });
    expect(messages(op)).toContain('property "limit" is bound twice');
  });

  it("rejects a path placeholder with no binding", () => {
    const op = rawOperation({ id: "get_item" });
    op.mapping.pathTemplate = "/items/{item_id}/parts/{part_id}";
    expect(messages(op)).toContain("path placeholder {part_id} has no binding");
  });

  it("rejects an optional path parameter", () => {
    const op = rawOperation({ id: "get_item" });
    op.input.required = [];
    expect(messages(op)).toContain('path parameter "item_id" must be required');
  });

  it("rejects external refs in schemas", () => {
    const op = rawOperation({ id: "get_item" });
    op.input.properties["limit"] = { $ref: "#/components/schemas/Limit" };
    expect(messages(op).some((m) => m.startsWith("$ref must start with"))).toBe(true);
  });

  describe("side-effect floor", () => {
    it("rejects a heuristic that rates DELETE as read", () => {
      const op = rawOperation({ id: "delete_item", method: "DELETE" });
      op.sideEffect = { class: "read", basis: "name_heuristic", reason: "looks harmless" };
      expect(messages(op)).toContain('DELETE implies at least "destructive"; only a curated classification may lower it');
    });

    it("allows a curated downgrade", () => {
      const op = rawOperation({ id: "search_items", method: "POST", path: "/items/search" });
      op.sideEffect = { class: "read", basis: "curated", reason: "POST used for search; reviewed" };
      expect(messages(op)).toEqual([]);
    });
  });

  it("reserves confidence 1 for verified operations", () => {
    expect(messages({ ...rawOperation({ id: "get_item" }), confidence: 1 })).toContain(
      "only verified operations may have confidence 1",
    );
    expect(messages({ ...rawOperation({ id: "get_item", provenance: "verified" }), confidence: 1 })).toEqual([]);
  });
});
