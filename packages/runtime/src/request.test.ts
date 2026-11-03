import { classifyHttpOperation, Operation, type HttpMethod } from "@cairnmcp/core";
import { describe, expect, it } from "vitest";
import { RuntimeFailure } from "./errors.ts";
import { buildRequest } from "./request.ts";

type Param = { property: string; in: "path" | "query" | "header" | "cookie"; style: string; explode: boolean; wireName?: string };

function op(path: string, params: Param[], extra: Record<string, unknown> = {}) {
  const properties = Object.fromEntries(params.map((p) => [p.property, {}]));
  const mapping = (extra["mapping"] as Record<string, unknown> | undefined) ?? {};
  const body = mapping["body"] as { property: string } | undefined;
  if (body) properties[body.property] = {};
  const method = ((mapping["method"] as HttpMethod | undefined) ?? "GET");
  return Operation.parse({
    id: "test_op",
    title: "t",
    description: "t",
    tags: [],
    deprecated: false,
    input: { type: "object", properties, required: params.filter((p) => p.in === "path").map((p) => p.property) },
    mapping: {
      kind: "http",
      method: "GET",
      pathTemplate: path,
      parameters: params.map((p) => ({ wireName: p.property, ...p })),
      response: { status: "200", decode: "json" },
      ...mapping,
    },
    sideEffect: classifyHttpOperation({ method, name: "test", pathTemplate: path }),
    provenance: { kind: "spec" },
    confidence: 0.9,
  });
}

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof RuntimeFailure) return e.error;
    throw e;
  }
  throw new Error("expected failure");
};

describe("buildRequest", () => {
  it("encodes path values so they cannot add segments", () => {
    const o = op("/files/{id}", [{ property: "id", in: "path", style: "simple", explode: false }]);
    expect(buildRequest(o, { id: "a/b?c#d e" }).pathAndQuery).toBe("/files/a%2Fb%3Fc%23d%20e");
  });

  it.each([".", ".."])("rejects %s as a path value (would climb the path)", (v) => {
    const o = op("/athlete/{id}/activities", [{ property: "id", in: "path", style: "simple", explode: false }]);
    expect(errorOf(() => buildRequest(o, { id: v })).kind).toBe("invalid_input");
  });

  it.each([
    ["simple", false, [1, 2], "/x/1,2"],
    ["label", false, [1, 2], "/x/.1,2"],
    ["label", true, [1, 2], "/x/.1.2"],
    ["matrix", false, [1, 2], "/x/;id=1,2"],
    ["matrix", true, [1, 2], "/x/;id=1;id=2"],
  ])("path style %s explode=%s", (style, explode, value, expected) => {
    const o = op("/x/{id}", [{ property: "id", in: "path", style, explode }]);
    expect(buildRequest(o, { id: value }).pathAndQuery).toBe(expected);
  });

  it.each([
    ["form", true, ["a", "b"], "q=a&q=b"],
    ["form", false, ["a", "b"], "q=a,b"],
    ["spaceDelimited", false, ["a", "b"], "q=a%20b"],
    ["pipeDelimited", false, ["a", "b"], "q=a%7Cb"],
    ["form", true, { x: "1", y: "2" }, "x=1&y=2"],
    ["form", false, { x: "1", y: "2" }, "q=x,1,y,2"],
    ["deepObject", true, { x: "1" }, "q%5Bx%5D=1"],
    ["form", true, "a&b=c", "q=a%26b%3Dc"],
    ["form", true, true, "q=true"],
  ])("query style %s explode=%s %j", (style, explode, value, expected) => {
    const o = op("/x", [{ property: "q", in: "query", style, explode }]);
    expect(buildRequest(o, { q: value }).pathAndQuery).toBe(`/x?${expected}`);
  });

  it("omits absent optional parameters", () => {
    const o = op("/x", [{ property: "q", in: "query", style: "form", explode: true }]);
    expect(buildRequest(o, {}).pathAndQuery).toBe("/x");
  });

  it("appends fixed query values", () => {
    const o = op("/responses", [{ property: "q", in: "query", style: "form", explode: true }], {
      mapping: { fixedQuery: { beta: "true" } },
    });
    expect(buildRequest(o, { q: "1" }).pathAndQuery).toBe("/responses?q=1&beta=true");
  });

  it("rejects header values with line breaks (header injection)", () => {
    const o = op("/x", [{ property: "h", in: "header", style: "simple", explode: false, wireName: "X-Trace" }]);
    expect(errorOf(() => buildRequest(o, { h: "a\r\nAuthorization: Bearer evil" })).kind).toBe("invalid_input");
  });

  it("encodes JSON and form bodies", () => {
    const jsonOp = op("/x", [], { mapping: { method: "POST", body: { property: "body", mediaType: "application/json" } } });
    expect(buildRequest(jsonOp, { body: { a: 1 } })).toMatchObject({ body: '{"a":1}', headers: { "content-type": "application/json" } });
    const formOp = op("/x", [], { mapping: { method: "POST", body: { property: "body", mediaType: "application/x-www-form-urlencoded" } } });
    expect(buildRequest(formOp, { body: { a: "x y", tags: ["p", "q"] } }).body).toBe("a=x+y&tags=p&tags=q");
  });

  it("nests deepObject form fields with brackets and joins unexploded arrays", () => {
    const encoding = {
      metadata: { style: "deepObject", explode: true },
      line_items: { style: "deepObject", explode: true },
      ids: { style: "form", explode: false },
      codes: { style: "pipeDelimited", explode: false },
    } as const;
    const o = op("/x", [], { mapping: { method: "POST", body: { property: "body", mediaType: "application/x-www-form-urlencoded", encoding } } });
    const body = buildRequest(o, {
      body: { email: "a@b.c", metadata: { order: "7" }, line_items: [{ price: "p_1", quantity: 2 }], ids: ["a", "b"], codes: ["x", "y"], tags: ["t"] },
    }).body;
    expect(new URLSearchParams(body).toString()).toBe(body);
    expect([...new URLSearchParams(body)]).toEqual([
      ["email", "a@b.c"],
      ["metadata[order]", "7"],
      ["line_items[0][price]", "p_1"],
      ["line_items[0][quantity]", "2"],
      ["ids", "a,b"],
      ["codes", "x|y"],
      ["tags", "t"],
    ]);
  });

  it("refuses body types it cannot encode yet", () => {
    const o = op("/x", [], { mapping: { method: "POST", body: { property: "body", mediaType: "multipart/form-data" } } });
    expect(errorOf(() => buildRequest(o, { body: {} })).kind).toBe("unsupported");
  });
});
