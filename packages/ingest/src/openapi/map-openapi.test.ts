import { readFileSync } from "node:fs";
import type { Operation } from "@cairnmcp/core";
import { describe, expect, it } from "vitest";
import { strictAjv } from "../test-support.ts";
import { ingestOpenApiText } from "./ingest.ts";
import { mapOpenApi, OPENAPI_CONFIDENCE, splitPathKey } from "./map-openapi.ts";

const minimal = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  openapi: "3.0.3",
  info: { title: "Mini API", version: "1" },
  servers: [{ url: "https://api.example.com/" }],
  paths,
  ...extra,
});

function mapOk(doc: unknown) {
  const r = mapOpenApi(doc);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics, null, 2));
  return r;
}

const opById = (ops: Operation[], id: string) => {
  const op = ops.find((o) => o.id === id);
  if (!op) throw new Error(`no op ${id}`);
  return op;
};

describe("mapOpenApi: document level", () => {
  it("rejects Swagger 2.0", () => {
    const r = mapOpenApi({ swagger: "2.0", info: {}, paths: {} });
    expect(r).toMatchObject({ ok: false, diagnostics: [{ code: "unsupported_version" }] });
  });

  it("rejects documents that are not OpenAPI", () => {
    expect(mapOpenApi({ hello: "world" })).toMatchObject({ ok: false, diagnostics: [{ code: "invalid_document" }] });
  });

  it("refuses non-https base URLs", () => {
    const r = mapOpenApi(minimal({}, { servers: [{ url: "http://api.example.com" }] }));
    expect(r).toMatchObject({ ok: false, diagnostics: [{ code: "invalid_base_url" }] });
  });

  it("needs a documentUrl to resolve a relative server URL", () => {
    const doc = minimal({}, { servers: [{ url: "/v1" }] });
    expect(mapOpenApi(doc)).toMatchObject({ ok: false, diagnostics: [{ code: "no_base_url" }] });
    const r = mapOpenApi(doc, { documentUrl: "https://docs.example.com/openapi.json" });
    expect(r.ok && r.ir.source.baseUrl).toBe("https://docs.example.com/v1");
  });

  it("lets the caller override the base URL", () => {
    const r = mapOpenApi(minimal({}), { baseUrl: "https://sandbox.example.com/" });
    expect(r.ok && r.ir.source.baseUrl).toBe("https://sandbox.example.com");
  });

  it("slugs the source id from the title unless given", () => {
    expect(mapOk(minimal({})).ir.source.id).toBe("mini-api");
    const r = mapOpenApi(minimal({}), { sourceId: "custom" });
    expect(r.ok && r.ir.source.id).toBe("custom");
  });

  it("skips a broken operation but keeps the rest", () => {
    const r = mapOk(
      minimal({
        "/good": { get: { operationId: "good", responses: { "200": { description: "ok" } } } },
        "/bad": { get: { operationId: "bad", parameters: [{ $ref: "#/components/parameters/Missing" }], responses: {} } },
      }),
    );
    expect(r.ir.operations.map((o) => o.id)).toEqual(["good"]);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ severity: "error", code: "unresolved_ref" }));
  });

  it("reports external refs instead of fetching them", () => {
    const r = mapOk(
      minimal({
        "/x": {
          get: { operationId: "x", responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "https://evil.example.com/s.json" } } } } } },
        },
      }),
    );
    expect(r.ir.operations).toEqual([]);
    expect(r.diagnostics[0]).toMatchObject({ code: "external_ref" });
  });
});

describe("mapOpenApi: operations", () => {
  it("synthesizes a missing path parameter and lowers confidence", () => {
    const r = mapOk(minimal({ "/items/{itemId}": { get: { operationId: "getItem", responses: { "200": { description: "ok" } } } } }));
    const op = opById(r.ir.operations, "get_item");
    expect(op.input["required"]).toEqual(["itemId"]);
    expect(r.diagnostics.map((d) => d.code)).toContain("missing_path_parameter");
    expect(op.confidence).toBeLessThan(OPENAPI_CONFIDENCE.base);
  });

  it("dedupes colliding operation ids", () => {
    const r = mapOk(
      minimal({
        "/a": { get: { operationId: "list", responses: { "200": { description: "ok" } } } },
        "/b": { get: { operationId: "list", responses: { "200": { description: "ok" } } } },
      }),
    );
    expect(r.ir.operations.map((o) => o.id)).toEqual(["list", "list_2"]);
  });

  it("prefers JSON request bodies and warns on multipart-only bodies", () => {
    const r = mapOk(
      minimal({
        "/both": {
          post: {
            operationId: "both",
            requestBody: { content: { "multipart/form-data": { schema: { type: "object" } }, "application/json": { schema: { type: "object" } } } },
            responses: { "200": { description: "ok" } },
          },
        },
        "/upload": {
          post: {
            operationId: "upload",
            requestBody: { content: { "multipart/form-data": { schema: { type: "object" } } } },
            responses: { "200": { description: "ok" } },
          },
        },
      }),
    );
    expect(opById(r.ir.operations, "both").mapping.body?.mediaType).toBe("application/json");
    expect(opById(r.ir.operations, "upload").mapping.body?.mediaType).toBe("multipart/form-data");
    expect(r.diagnostics.filter((d) => d.code === "binary_request_body").map((d) => d.operationId)).toEqual(["upload"]);
  });

  it("keeps a form body's non-default field encodings (Stripe)", () => {
    const r = mapOk(
      minimal({
        "/customers": {
          post: {
            operationId: "createCustomer",
            requestBody: {
              content: {
                "application/x-www-form-urlencoded": {
                  schema: { type: "object", properties: { email: { type: "string" }, metadata: { type: "object" } } },
                  encoding: {
                    email: { style: "form", explode: true },
                    metadata: { style: "deepObject", explode: true },
                    ids: { style: "form", explode: false },
                    weird: { style: "matrix" },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      }),
    );
    expect(opById(r.ir.operations, "create_customer").mapping.body).toEqual({
      property: "body",
      mediaType: "application/x-www-form-urlencoded",
      encoding: { metadata: { style: "deepObject", explode: true }, ids: { style: "form", explode: false } },
    });
    expect(r.diagnostics.map((d) => d.code)).toContain("unsupported_body_encoding");
  });

  it("leaves deep types open in a huge response schema instead of repeating them (Stripe)", () => {
    // A chain of components, each with a large description, so the full schema is too big.
    const big = "x".repeat(20_000);
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i < 8; i++) {
      schemas[`T${i}`] = { type: "object", description: `T${i} ${big}`, properties: { next: { $ref: `#/components/schemas/T${i + 1}` } } };
    }
    schemas["T8"] = { type: "string" };
    const r = mapOk(
      minimal(
        { "/t": { get: { operationId: "getT", responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/T0" } } } } } } } },
        { components: { schemas } },
      ),
    );
    const output = opById(r.ir.operations, "get_t").output as { $defs: Record<string, Record<string, unknown>> };
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(64 * 1024);
    expect(output.$defs["T0"]?.["properties"]).toBeDefined();
    const open = Object.entries(output.$defs).filter(([, s]) => s["properties"] === undefined).map(([k]) => k);
    expect(open).toHaveLength(1);
    expect(output.$defs[open[0]!]).toEqual({ type: "object", description: expect.stringMatching(/^T\d /) });
    expect(r.diagnostics.find((d) => d.code === "output_schema_trimmed")).toMatchObject({ severity: "info" });
    expect(strictAjv().validateSchema(output)).toBe(true);
    expect(strictAjv().compile(output)({ next: { next: { next: { next: "anything" } } } })).toBe(true);
  });

  it("leaves the output untyped when even the outer level is too big", () => {
    const schema = { type: "object", description: "y".repeat(70_000) };
    const r = mapOk(minimal({ "/u": { get: { operationId: "getU", responses: { "200": { description: "ok", content: { "application/json": { schema } } } } } } }));
    expect(opById(r.ir.operations, "get_u").output).toBeUndefined();
    expect(r.diagnostics.map((d) => d.code)).toContain("output_schema_too_large");
  });

  it("assumes JSON for a wildcard media type with a schema, and warns", () => {
    const r = mapOk(
      minimal({
        "/x": { get: { operationId: "x", responses: { "200": { description: "ok", content: { "*/*": { schema: { type: "object" } } } } } } },
      }),
    );
    const op = opById(r.ir.operations, "x");
    expect(op.mapping.response).toEqual({ status: "200", mediaType: "*/*", decode: "json" });
    expect(op.confidence).toBe(0.8);
    expect(r.diagnostics.map((d) => d.code)).toEqual(["wildcard_media_type"]);
  });

  it("uses default as the success response when there is no 2xx", () => {
    const r = mapOk(
      minimal({
        "/x": { get: { operationId: "x", responses: { default: { description: "ok", content: { "application/json": { schema: { type: "object" } } } } } } },
      }),
    );
    expect(opById(r.ir.operations, "x").mapping.response.status).toBe("default");
  });
});

describe("path keys with a query or fragment (seen in OpenAI and Box specs)", () => {
  it("splits a path key", () => {
    expect(splitPathKey("/responses?beta=true")).toEqual({ template: "/responses", fixedQuery: { beta: "true" } });
    expect(splitPathKey("/files/{file_id}#add_shared_link")).toEqual({ template: "/files/{file_id}", fragment: "add_shared_link" });
    expect(splitPathKey("/a?x=1&y=two%20words#v2")).toEqual({ template: "/a", fixedQuery: { x: "1", y: "two words" }, fragment: "v2" });
    expect(splitPathKey("/plain/{id}")).toEqual({ template: "/plain/{id}" });
  });

  const r = mapOk(
    minimal({
      "/responses": { post: { operationId: "createResponse", responses: { "200": { description: "ok" } } } },
      "/responses?beta=true": {
        post: {
          operationId: "beta_createResponse",
          parameters: [{ name: "beta", in: "query", schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
      "/files/{file_id}#get_shared_link": {
        get: {
          operationId: "get_files_id#get_shared_link",
          parameters: [{ name: "file_id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
      "/files/{file_id}#remove_shared_link": {
        put: {
          operationId: "updateFile",
          parameters: [{ name: "file_id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
    }),
  );

  it("keeps every operation", () => {
    expect(r.ir.operations.map((o) => [o.id, o.mapping.pathTemplate])).toEqual([
      ["create_response", "/responses"],
      ["beta_create_response", "/responses"],
      ["get_files_id_get_shared_link", "/files/{file_id}"],
      ["update_file", "/files/{file_id}"],
    ]);
  });

  it("sends a literal query as fixed values, not agent input", () => {
    const op = opById(r.ir.operations, "beta_create_response");
    expect(op.mapping.fixedQuery).toEqual({ beta: "true" });
    expect(op.mapping.parameters).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(["path_key_query", "fixed_query_parameter", "path_key_fragment"]));
  });

  it("uses the fragment as a naming hint for side effects", () => {
    expect(opById(r.ir.operations, "update_file").sideEffect).toMatchObject({ class: "destructive", basis: "name_heuristic" });
  });
});

describe("ingestOpenApiText: synthetic 3.1 YAML", () => {
  const text = readFileSync(new URL("../../fixtures/synthetic/petstore-3.1.yaml", import.meta.url), "utf8");
  const r = ingestOpenApiText(text, { derivedAt: "2026-10-30T12:00:00Z" });
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  const { ir } = r;

  it("resolves server variables and records derivation", () => {
    expect(ir.source.baseUrl).toBe("https://eu.pets.example.com/v2");
    expect(ir.source.derivation).toMatchObject({ ingestor: "openapi", formatVersion: "3.1.0", apiVersion: "2.0", derivedAt: "2026-10-30T12:00:00Z" });
    expect(ir.source.derivation.documentSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("maps operation-level security and scopes", () => {
    expect(ir.source.defaultAuth).toEqual([[{ schemeId: "oauth", scopes: ["pets:read"] }]]);
    expect(opById(ir.operations, "create_pet").auth).toEqual([[{ schemeId: "oauth", scopes: ["pets:write"] }]]);
  });

  it("merges path-level parameter refs and renames colliding properties", () => {
    const op = opById(ir.operations, "get_pet");
    expect(op.mapping.parameters.map((p) => [p.property, p.in, p.wireName])).toEqual([
      ["petId", "path", "petId"],
      ["query_petId", "query", "petId"],
    ]);
  });

  it("ignores reserved headers", () => {
    expect(opById(ir.operations, "list_pets").mapping.parameters.map((p) => p.wireName)).toEqual(["limit"]);
  });

  it("drops readOnly properties from request bodies only", () => {
    const create = opById(ir.operations, "create_pet");
    const inputPet = (create.input["$defs"] as Record<string, Record<string, unknown>>)["Pet"]!;
    const outputPet = (create.output!["$defs"] as Record<string, Record<string, unknown>>)["Pet"]!;
    expect(Object.keys(inputPet["properties"] as object)).not.toContain("id");
    expect(inputPet["required"]).toEqual(["name"]);
    expect(Object.keys(outputPet["properties"] as object)).toContain("id");
  });

  it("keeps 3.1 $ref siblings", () => {
    const pet = (opById(ir.operations, "get_pet").output!["$defs"] as Record<string, Record<string, Record<string, unknown>>>)["Pet"]!;
    expect(pet["properties"]!["parent"]).toEqual({ $ref: "#/$defs/Pet", description: "The parent pet, if known" });
  });

  it("maps 204 to no body and DELETE to destructive", () => {
    const op = opById(ir.operations, "delete_pet");
    expect(op.mapping.response).toEqual({ status: "204", decode: "none" });
    expect(op.sideEffect).toMatchObject({ class: "destructive", basis: "http_method" });
  });

  it("produces schemas a strict 2020-12 validator accepts, with working semantics", () => {
    const ajv = strictAjv();
    for (const op of ir.operations) {
      ajv.compile(op.input);
      if (op.output) ajv.compile(op.output);
    }
    const validate = ajv.compile(opById(ir.operations, "create_pet").input);
    expect(validate({ body: { name: "Rex" } })).toBe(true);
    expect(validate({})).toBe(false); // body is required
    expect(validate({ body: { name: "Rex" }, extra: 1 })).toBe(false); // no unknown inputs
  });
});

describe("ingestOpenApiText: input handling", () => {
  it("rejects text that is neither JSON nor YAML", () => {
    expect(ingestOpenApiText("{ not json")).toMatchObject({ ok: false, diagnostics: [{ code: "unparseable_document" }] });
  });
});
