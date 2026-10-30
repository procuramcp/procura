// Builders for tests. Not exported from the package index.
import { IR_VERSION, type IrDocument } from "./document.ts";
import { Operation } from "./operation.ts";
import type { HttpMethod } from "./side-effect.ts";
import { classifyHttpOperation } from "./side-effect.ts";

type OpInput = {
  id: string;
  method?: HttpMethod;
  path?: string;
  provenance?: "spec" | "introspection" | "inferred" | "verified";
};

/** A valid operation: `GET /items/{item_id}` with a path param and an optional query param. */
export function rawOperation({ id, method = "GET", path = "/items/{item_id}", provenance = "spec" }: OpInput) {
  const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? "");
  const properties: Record<string, unknown> = { limit: { type: "integer" } };
  for (const p of pathParams) properties[p] = { type: "string" };
  return {
    id,
    title: id,
    description: `Does ${id}.`,
    tags: [],
    deprecated: false,
    input: {
      type: "object",
      properties,
      required: pathParams,
      additionalProperties: false,
    },
    mapping: {
      kind: "http",
      method,
      pathTemplate: path,
      parameters: [
        ...pathParams.map((p) => ({ property: p, in: "path", wireName: p, style: "simple", explode: false })),
        { property: "limit", in: "query", wireName: "limit", style: "form", explode: true },
      ],
      response: { status: "200", mediaType: "application/json", decode: "json" },
    },
    sideEffect: classifyHttpOperation({ method, name: id, pathTemplate: path }),
    provenance: { kind: provenance },
    confidence: 0.9,
  };
}

export function operation(input: OpInput): Operation {
  return Operation.parse(rawOperation(input));
}

export function rawSource() {
  return {
    id: "example",
    name: "Example API",
    baseUrl: "https://api.example.com/v1",
    authSchemes: [{ id: "key", type: "http_bearer" }],
    defaultAuth: [[{ schemeId: "key", scopes: [] }]],
    rateLimits: [],
    derivation: { ingestor: "openapi", ingestorVersion: "test" },
  };
}

export function rawDocument(ops: object[]) {
  return { irVersion: IR_VERSION, source: rawSource(), operations: ops };
}

export type { IrDocument };
