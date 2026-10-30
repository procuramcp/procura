import { z } from "zod";
import { OperationId } from "./ids.ts";
import { JsonSchema, ObjectJsonSchema, objectPropertyNames, requiredPropertyNames } from "./json-schema.ts";
import {
  HttpMethod,
  httpMethodSideEffect,
  isAtLeast,
  SideEffectClassification,
} from "./side-effect.ts";
import { AuthRequirement } from "./source.ts";

/**
 * How an operation became known:
 * - `spec`: read from a machine-readable description (OpenAPI, Postman, HAR).
 * - `introspection`: read from the live API's own schema (GraphQL).
 * - `inferred`: drafted from prose docs or examples; not yet checked.
 * - `verified`: probed against the real API and the response matched.
 *
 * Toolsets refuse `inferred` operations unless explicitly allowed.
 */
export const Provenance = z.enum(["spec", "introspection", "inferred", "verified"]);
export type Provenance = z.infer<typeof Provenance>;

export const ParameterLocation = z.enum(["path", "query", "header", "cookie"]);
export type ParameterLocation = z.infer<typeof ParameterLocation>;

/** Serialization style (OpenAPI terms). Defaults are made explicit on ingest. */
export const ParameterStyle = z.enum([
  "simple",
  "form",
  "label",
  "matrix",
  "spaceDelimited",
  "pipeDelimited",
  "deepObject",
]);

/** Maps one property of the tool input to one HTTP request parameter. */
export const ParameterBinding = z.object({
  /** Property name in `Operation.input`. */
  property: z.string().min(1),
  in: ParameterLocation,
  /** Name on the wire, which may differ from the property name. */
  wireName: z.string().min(1),
  style: ParameterStyle,
  explode: z.boolean(),
});
export type ParameterBinding = z.infer<typeof ParameterBinding>;

/** Maps one property of the tool input to the request body. */
export const BodyBinding = z.object({
  property: z.string().min(1),
  mediaType: z.string().min(1),
});
export type BodyBinding = z.infer<typeof BodyBinding>;

/**
 * How to read the response:
 * - `json`, `text`, `binary`: decode as such.
 * - `none`: no body expected (e.g. 204).
 * - `auto`: the description did not say; decide from the Content-Type header.
 */
export const ResponseDecode = z.enum(["json", "text", "binary", "none", "auto"]);

export const ResponseMapping = z.object({
  /** Status code or range this mapping is for: `200`, `2XX`, or `default`. */
  status: z.string().regex(/^(?:[1-5](?:\d\d|XX)|default)$/),
  /** Media type as declared, which may be a wildcard like `*\/*`. */
  mediaType: z.string().optional(),
  decode: ResponseDecode,
});
export type ResponseMapping = z.infer<typeof ResponseMapping>;

export const HttpMapping = z.object({
  kind: z.literal("http"),
  method: HttpMethod,
  /** Relative to `Source.baseUrl`, starting with `/`, with `{name}` placeholders. */
  pathTemplate: z.string().regex(/^\/[^?#]*$/, "must start with / and contain no query or fragment"),
  parameters: z.array(ParameterBinding),
  /**
   * Query parameters always sent with fixed values, not supplied by the agent.
   * Comes from specs that put a literal query in the path key (OpenAI uses
   * `/responses?beta=true`).
   */
  fixedQuery: z.record(z.string().min(1), z.string()).optional(),
  body: BodyBinding.optional(),
  response: ResponseMapping,
});
export type HttpMapping = z.infer<typeof HttpMapping>;

/** Transport mapping. A discriminated union so GraphQL can be added as a sibling (milestone 4). */
export const Mapping = z.discriminatedUnion("kind", [HttpMapping]);
export type Mapping = z.infer<typeof Mapping>;

export const OperationProvenance = z.object({
  kind: Provenance,
  /** Where in the source document it came from (JSON Pointer for OpenAPI). */
  sourceRef: z.string().optional(),
  /** The id the source used, e.g. OpenAPI `operationId`. */
  originalId: z.string().optional(),
});

export const Operation = z
  .object({
    id: OperationId,
    /** Short human-readable label. */
    title: z.string().min(1).max(200),
    /** Agent-facing description, as ingested. Toolsets may override it. */
    description: z.string().min(1).max(10_000),
    tags: z.array(z.string()),
    deprecated: z.boolean(),
    /** Tool input. Root is an object; one property per parameter, plus the body. */
    input: ObjectJsonSchema,
    /** Schema of the successful response, if the description gives one. */
    output: JsonSchema.optional(),
    mapping: Mapping,
    sideEffect: SideEffectClassification,
    /** Overrides `Source.defaultAuth` when present. */
    auth: AuthRequirement.optional(),
    provenance: OperationProvenance,
    /**
     * 0 to 1: how likely the IR matches what the real API does.
     * Only `verified` operations can reach 1. Each ingestor documents its rubric.
     */
    confidence: z.number().min(0).max(1),
  })
  .superRefine((op, ctx) => {
    checkBindings(op, ctx);
    checkSideEffectFloor(op, ctx);
    if (op.confidence === 1 && op.provenance.kind !== "verified") {
      ctx.addIssue({ code: "custom", path: ["confidence"], message: "only verified operations may have confidence 1" });
    }
  });
export type Operation = z.infer<typeof Operation>;

type OperationShape = {
  input: JsonSchema;
  mapping: Mapping;
  sideEffect: SideEffectClassification;
};

/** Every input property is bound exactly once, and path placeholders match path bindings. */
function checkBindings(op: OperationShape, ctx: z.RefinementCtx): void {
  const mapping = op.mapping;
  const declared = new Set(objectPropertyNames(op.input));
  const required = new Set(requiredPropertyNames(op.input));
  const bound = [...mapping.parameters.map((p) => p.property), ...(mapping.body ? [mapping.body.property] : [])];

  const seen = new Set<string>();
  for (const name of bound) {
    if (seen.has(name)) ctx.addIssue({ code: "custom", path: ["mapping"], message: `property "${name}" is bound twice` });
    seen.add(name);
    if (!declared.has(name)) {
      ctx.addIssue({ code: "custom", path: ["mapping"], message: `bound property "${name}" is not in input.properties` });
    }
  }
  for (const name of declared) {
    if (!seen.has(name)) ctx.addIssue({ code: "custom", path: ["input"], message: `input property "${name}" is not bound` });
  }

  for (const p of mapping.parameters) {
    if (p.in === "query" && mapping.fixedQuery && Object.hasOwn(mapping.fixedQuery, p.wireName)) {
      ctx.addIssue({ code: "custom", path: ["mapping"], message: `query parameter "${p.wireName}" is both fixed and bound` });
    }
  }

  const placeholders = [...mapping.pathTemplate.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? "");
  const pathParams = mapping.parameters.filter((p) => p.in === "path");
  const pathWireNames = new Set(pathParams.map((p) => p.wireName));
  for (const ph of placeholders) {
    if (!pathWireNames.has(ph)) ctx.addIssue({ code: "custom", path: ["mapping"], message: `path placeholder {${ph}} has no binding` });
  }
  for (const p of pathParams) {
    if (!placeholders.includes(p.wireName)) {
      ctx.addIssue({ code: "custom", path: ["mapping"], message: `path binding "${p.wireName}" has no placeholder` });
    }
    if (!required.has(p.property)) {
      ctx.addIssue({ code: "custom", path: ["input"], message: `path parameter "${p.property}" must be required` });
    }
  }
}

/** Heuristics may escalate a classification; only a human may rate it below the protocol default. */
function checkSideEffectFloor(op: OperationShape, ctx: z.RefinementCtx): void {
  const floor = httpMethodSideEffect(op.mapping.method);
  if (op.sideEffect.basis !== "curated" && !isAtLeast(op.sideEffect.class, floor)) {
    ctx.addIssue({
      code: "custom",
      path: ["sideEffect"],
      message: `${op.mapping.method} implies at least "${floor}"; only a curated classification may lower it`,
    });
  }
}
