import {
  BaseUrl,
  classifyHttpOperation,
  IR_VERSION,
  IrDocument,
  isRecord,
  omitUndefined,
  Operation,
  slugify,
  truncate,
  type AuthRequirement,
  type BodyBinding,
  type BodyFieldEncoding,
  type Diagnostic,
  type HttpMethod,
  type JsonSchema,
} from "@procura/core";
import { z } from "zod";
import {
  HTTP_METHODS,
  OaOperation,
  OaParameter,
  OaRequestBody,
  OaResponse,
  OpenApiDocument,
  PathItem,
} from "./document.ts";
import { humanize, operationIdFrom, propertyNameFrom, uniqueName } from "./naming.ts";
import { deref, escapePointerToken, MappingError } from "./refs.ts";
import { SchemaConverter, type OasDialect } from "./schema.ts";
import { mapSecurityRequirement, mapSecuritySchemes } from "./security.ts";

export const OPENAPI_INGESTOR_VERSION = "0.2.0";

/**
 * Confidence rubric for spec-derived operations. A spec can be wrong, so it
 * never reaches 1; only the verification loop (probing the real API) can.
 * Each penalty applies at most once per operation.
 */
export const OPENAPI_CONFIDENCE = {
  base: 0.9,
  floor: 0.3,
  penalties: {
    /** No schema for the success response: the agent gets untyped data. */
    noOutputSchema: 0.1,
    /** Media type was a wildcard like `*\/*`; JSON was assumed. */
    wildcardMediaType: 0.1,
    /** A parameter's schema was missing or synthesized. */
    assumedParameter: 0.1,
    /** Multipart or binary request body: hard for an agent to supply. */
    binaryBody: 0.2,
  },
} as const;
type Penalty = keyof typeof OPENAPI_CONFIDENCE.penalties;

export type MapOpenApiOptions = {
  /** Slug for the source. Defaults to a slug of `info.title`. */
  sourceId?: string;
  /** Overrides the document's `servers`. */
  baseUrl?: string;
  /** Where the document was fetched from; also used to resolve relative server URLs. */
  documentUrl?: string;
  documentSha256?: string;
  /** Ingestion time (UTC instant). Core never reads the clock, so pass it in. */
  derivedAt?: string;
};

export type MapOpenApiResult =
  | { ok: true; ir: IrDocument; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Output schemas larger than this keep their outer levels and leave deeper types open (D-042).
 * Stripe's responses reference most of its API (about 1 MB per operation in full).
 */
export const MAX_OUTPUT_SCHEMA_CHARS = 64 * 1024;

// Header parameters OpenAPI says must be ignored: the runtime owns these.
const RESERVED_HEADERS = new Set(["accept", "content-type", "authorization"]);

/**
 * Map an OpenAPI 3.0/3.1 document (already parsed from JSON/YAML) to the IR.
 * Pure: no I/O. Operations that cannot be mapped are skipped with an error
 * diagnostic; the rest still map. Whole-document problems return `ok: false`.
 */
export function mapOpenApi(raw: unknown, options: MapOpenApiOptions = {}): MapOpenApiResult {
  const diagnostics: Diagnostic[] = [];
  const fatal = (code: string, message: string, pointer?: string): MapOpenApiResult => {
    diagnostics.push({ severity: "error", code, message, ...(pointer !== undefined ? { pointer } : {}) });
    return { ok: false, diagnostics };
  };

  if (isRecord(raw) && typeof raw["swagger"] === "string") {
    return fatal("unsupported_version", `Swagger ${raw["swagger"]} is not supported; convert to OpenAPI 3 first`);
  }
  const parsed = OpenApiDocument.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fatal("invalid_document", `not a supported OpenAPI document: ${issue?.path.join(".")} ${issue?.message}`);
  }
  const doc = parsed.data;
  const dialect: OasDialect = doc.openapi.startsWith("3.1") ? "3.1" : "3.0";

  const baseUrl = resolveBaseUrl(doc, options, diagnostics);
  if (baseUrl === undefined) return { ok: false, diagnostics };

  const schemes = mapSecuritySchemes(doc.components?.securitySchemes, baseUrl, diagnostics);
  const defaultAuth = mapSecurityRequirement(doc.security ?? [], schemes, "#/security", diagnostics);

  const sourceId = options.sourceId ?? slugify(doc.info.title) ?? "api";
  const converter = new SchemaConverter(doc, dialect, (code, message, pointer) =>
    diagnostics.push({ severity: "warning", code, message, pointer }),
  );
  const usedIds = new Set<string>();
  const operations: Operation[] = [];

  for (const [path, rawItem] of Object.entries(doc.paths ?? {})) {
    const itemPointer = `#/paths/${escapePointerToken(path)}`;
    let item: Record<string, unknown>;
    try {
      item = deref(doc, rawItem, PathItem, itemPointer).value;
    } catch (e) {
      diagnostics.push(errorDiagnostic(e, itemPointer));
      continue;
    }
    for (const method of HTTP_METHODS) {
      if (item[method] === undefined) continue;
      const pointer = `${itemPointer}/${method}`;
      if (method === "trace") {
        diagnostics.push({ severity: "info", code: "unsupported_method", message: "TRACE operations are skipped", pointer });
        continue;
      }
      try {
        const op = mapOperation({
          doc,
          converter,
          schemes,
          diagnostics,
          usedIds,
          path,
          method: method.toUpperCase() as HttpMethod,
          pathItem: item,
          raw: item[method],
          pointer,
        });
        const checked = Operation.safeParse(op);
        if (checked.success) operations.push(checked.data);
        else {
          diagnostics.push({
            severity: "error",
            code: "ir_validation_failed",
            message: `mapped operation failed IR validation: ${checked.error.issues.map((i) => i.message).join("; ")}`,
            pointer,
            operationId: op.id,
          });
        }
      } catch (e) {
        diagnostics.push(errorDiagnostic(e, pointer));
      }
    }
  }

  // Long API introductions (DigitalOcean's runs past 10,000 characters) are cut, not refused.
  if ((doc.info.description?.length ?? 0) > 10_000) {
    diagnostics.push({ severity: "info", code: "description_truncated", message: "the API's description is over 10,000 characters; cut to fit", pointer: "#/info/description" });
  }
  const candidate = {
    irVersion: IR_VERSION,
    source: {
      id: sourceId,
      name: truncate(doc.info.title.trim() || sourceId, 200),
      ...(doc.info.description ? { description: truncate(doc.info.description, 10_000) } : {}),
      baseUrl,
      authSchemes: [...schemes.values()],
      defaultAuth,
      rateLimits: [],
      derivation: omitUndefined({
        ingestor: "openapi",
        ingestorVersion: OPENAPI_INGESTOR_VERSION,
        documentUrl: options.documentUrl,
        documentSha256: options.documentSha256,
        formatVersion: doc.openapi,
        apiVersion: doc.info.version,
        derivedAt: options.derivedAt,
      }),
    },
    operations,
  };
  const ir = IrDocument.safeParse(candidate);
  if (!ir.success) {
    return fatal("ir_validation_failed", `IR validation failed: ${z.prettifyError(ir.error)}`);
  }
  return { ok: true, ir: ir.data, diagnostics };
}

type OperationContext = {
  doc: OpenApiDocument;
  converter: SchemaConverter;
  schemes: ReturnType<typeof mapSecuritySchemes>;
  diagnostics: Diagnostic[];
  usedIds: Set<string>;
  path: string;
  method: HttpMethod;
  pathItem: Record<string, unknown>;
  raw: unknown;
  pointer: string;
};

function mapOperation(ctx: OperationContext) {
  const { doc, converter, method, pointer } = ctx;
  const op = deref(doc, ctx.raw, OaOperation, pointer).value;
  const key = splitPathKey(ctx.path);
  const path = key.template;
  const id = uniqueName(operationIdFrom(op.operationId, method, ctx.path), ctx.usedIds);
  const penalties = new Set<Penalty>();
  const note = (severity: Diagnostic["severity"], code: string, message: string, at = pointer) =>
    ctx.diagnostics.push({ severity, code, message, pointer: at, operationId: id });

  if (key.fragment !== undefined) {
    note("info", "path_key_fragment", `path key "${ctx.path}" has a fragment (#${key.fragment}); it is a label only and is not sent`);
  }
  if (key.fixedQuery !== undefined) {
    note("warning", "path_key_query", `path key "${ctx.path}" contains a query; sent as fixed query parameters ${JSON.stringify(key.fixedQuery)}`);
  }

  // Parameters: path-item level first, overridden by operation level (same name + location).
  const merged = new Map<string, { param: OaParameter; pointer: string }>();
  const collect = (list: unknown[] | undefined, base: string) =>
    (list ?? []).forEach((p, i) => {
      const resolved = deref(doc, p, OaParameter, `${base}/parameters/${i}`);
      merged.set(`${resolved.value.in}:${resolved.value.name}`, { param: resolved.value, pointer: resolved.pointer });
    });
  collect(PathItem.parse(ctx.pathItem).parameters, pointer.slice(0, pointer.lastIndexOf("/")));
  collect(op.parameters, pointer);

  const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? "");
  for (const ph of placeholders) {
    if (!merged.has(`path:${ph}`)) {
      note("warning", "missing_path_parameter", `path placeholder {${ph}} has no parameter definition; assumed a required string`);
      merged.set(`path:${ph}`, { param: { name: ph, in: "path", required: true, schema: { type: "string" } }, pointer });
      penalties.add("assumedParameter");
    }
  }

  const inputRefs = new Set<string>();
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const usedProps = new Set<string>();
  const parameters = [];

  for (const { param, pointer: pp } of merged.values()) {
    if (param.in === "header" && RESERVED_HEADERS.has(param.name.toLowerCase())) {
      note("info", "reserved_header_ignored", `header parameter "${param.name}" is managed by the runtime and ignored`, pp);
      continue;
    }
    if (param.in === "path" && !placeholders.includes(param.name)) {
      note("warning", "unused_path_parameter", `path parameter "${param.name}" is not in the path template; dropped`, pp);
      continue;
    }
    if (param.in === "query" && key.fixedQuery && Object.hasOwn(key.fixedQuery, param.name)) {
      note("warning", "fixed_query_parameter", `query parameter "${param.name}" is fixed by the path key; not exposed as input`, pp);
      continue;
    }
    let base = propertyNameFrom(param.name);
    if (usedProps.has(base)) base = `${param.in}_${base}`;
    const property = uniqueName(base, usedProps, 128);

    let rawSchema = param.schema;
    if (rawSchema === undefined && param.content) {
      const first = Object.values(param.content)[0];
      rawSchema = first?.schema;
      note("warning", "parameter_content_serialization", `parameter "${param.name}" uses "content"; serialized as plain style`, pp);
      penalties.add("assumedParameter");
    }
    if (rawSchema === undefined) {
      note("warning", "parameter_without_schema", `parameter "${param.name}" has no schema; any value accepted`, pp);
      penalties.add("assumedParameter");
    }
    const converted = converter.convert(rawSchema ?? {}, "input", `${pp}/schema`, inputRefs);
    properties[property] = withAnnotations(converted, param.description, param.deprecated);

    const isRequired = param.in === "path" || param.required === true;
    if (param.in === "path" && param.required !== true) {
      note("warning", "path_parameter_not_required", `path parameter "${param.name}" was not marked required; treated as required`, pp);
    }
    if (isRequired) required.push(property);

    const style = param.style ?? (param.in === "query" || param.in === "cookie" ? "form" : "simple");
    parameters.push({ property, in: param.in, wireName: param.name, style, explode: param.explode ?? style === "form" });
  }

  let body: BodyBinding | undefined;
  if (op.requestBody !== undefined) {
    const rb = deref(doc, op.requestBody, OaRequestBody, `${pointer}/requestBody`);
    const mediaType = pickRequestMediaType(Object.keys(rb.value.content));
    if (mediaType === undefined) {
      note("warning", "empty_request_body", "request body declares no media types; body omitted", rb.pointer);
    } else {
      if (/^multipart\/|^application\/octet-stream$/.test(mediaType)) {
        note("warning", "binary_request_body", `request body is ${mediaType}; agents usually cannot supply this`, rb.pointer);
        penalties.add("binaryBody");
      }
      const property = uniqueName(usedProps.has("body") ? "request_body" : "body", usedProps, 128);
      const mt = rb.value.content[mediaType];
      const bodyPointer = `${rb.pointer}/content/${escapePointerToken(mediaType)}/schema`;
      const schema = converter.convert(mt?.schema ?? {}, "input", bodyPointer, inputRefs);
      properties[property] = withAnnotations(schema, rb.value.description, undefined);
      if (rb.value.required === true) required.push(property);
      const encoding = formEncoding(mediaType, mt?.encoding, note, `${rb.pointer}/content/${escapePointerToken(mediaType)}/encoding`);
      body = encoding ? { property, mediaType, encoding } : { property, mediaType };
    }
  }

  const response = mapResponse(ctx, op, note, penalties);

  const input = converter.bundle({ type: "object", properties, required, additionalProperties: false }, "input", inputRefs);
  const description = [op.summary, op.description]
    .map((s) => s?.trim())
    .filter((s, i, all): s is string => !!s && all.indexOf(s) === i)
    .join("\n\n");

  let confidence: number = OPENAPI_CONFIDENCE.base;
  for (const p of penalties) confidence -= OPENAPI_CONFIDENCE.penalties[p];
  confidence = Math.max(OPENAPI_CONFIDENCE.floor, Math.round(confidence * 100) / 100);

  const auth: AuthRequirement | undefined =
    op.security !== undefined
      ? mapSecurityRequirement(op.security, ctx.schemes, `${pointer}/security`, ctx.diagnostics, id)
      : undefined;

  return {
    id,
    title: truncate(op.summary?.trim() || humanize(id), 200),
    description: truncate(description || `${method} ${path}`, 10_000),
    tags: op.tags ?? [],
    deprecated: op.deprecated ?? false,
    input,
    ...(response.output !== undefined ? { output: response.output } : {}),
    mapping: {
      kind: "http" as const,
      method,
      pathTemplate: path,
      parameters,
      ...(key.fixedQuery ? { fixedQuery: key.fixedQuery } : {}),
      ...(body ? { body } : {}),
      response: response.mapping,
    },
    // The fragment (e.g. Box's "#remove_shared_link") often names the action, so it counts as a name hint.
    sideEffect: classifyHttpOperation({ method, name: [op.operationId ?? id, key.fragment ?? ""].join(" "), pathTemplate: path }),
    ...(auth !== undefined ? { auth } : {}),
    provenance: { kind: "spec" as const, sourceRef: pointer, ...(op.operationId ? { originalId: op.operationId } : {}) },
    confidence,
  };
}

function mapResponse(
  ctx: OperationContext,
  op: OaOperation,
  note: (severity: Diagnostic["severity"], code: string, message: string, at?: string) => void,
  penalties: Set<Penalty>,
): { output: JsonSchema | undefined; mapping: { status: string; mediaType?: string; decode: "json" | "text" | "binary" | "none" | "auto" } } {
  const codes = Object.keys(op.responses ?? {});
  const status =
    codes.filter((c) => /^2\d\d$/.test(c)).sort()[0] ?? codes.find((c) => c.toUpperCase() === "2XX") ?? codes.find((c) => c === "default");
  if (status === undefined) {
    note("warning", "no_success_response", "no 2xx or default response declared; output unknown");
    penalties.add("noOutputSchema");
    return { output: undefined, mapping: { status: "default", decode: "auto" } };
  }
  const responsePointer = `${ctx.pointer}/responses/${escapePointerToken(status)}`;
  const resp = deref(ctx.doc, op.responses?.[status], OaResponse, responsePointer);
  const normalizedStatus = status.toUpperCase() === "2XX" ? "2XX" : status;
  const content = resp.value.content ?? {};
  const mediaType = pickResponseMediaType(Object.keys(content));

  if (mediaType === undefined) {
    if (status === "204") return { output: undefined, mapping: { status, decode: "none" } };
    note("warning", "response_media_type_unspecified", `response ${status} declares no content; decoded by Content-Type at runtime`, resp.pointer);
    penalties.add("noOutputSchema");
    return { output: undefined, mapping: { status: normalizedStatus, decode: "auto" } };
  }

  const rawSchema = content[mediaType]?.schema;
  const refs = new Set<string>();
  const schemaPointer = `${resp.pointer}/content/${escapePointerToken(mediaType)}/schema`;
  const converted = rawSchema !== undefined ? ctx.converter.convert(rawSchema, "output", schemaPointer, refs) : undefined;
  let output: JsonSchema | undefined;
  if (isRecord(converted)) {
    const bounded = ctx.converter.bundleWithin(converted, "output", refs, MAX_OUTPUT_SCHEMA_CHARS);
    if (bounded === undefined) {
      note("warning", "output_schema_too_large", `response schema is over ${MAX_OUTPUT_SCHEMA_CHARS / 1024} KB even with nested types left open; output left untyped`, schemaPointer);
    } else if (bounded.openAt !== undefined) {
      note("info", "output_schema_trimmed", `response schema is over ${MAX_OUTPUT_SCHEMA_CHARS / 1024} KB; types nested ${bounded.openAt} or more levels deep are left open`, schemaPointer);
    }
    output = bounded?.schema;
  }
  if (output === undefined) penalties.add("noOutputSchema");

  let decode: "json" | "text" | "binary" | "auto";
  if (isJsonMediaType(mediaType)) decode = "json";
  else if (mediaType.startsWith("text/")) decode = "text";
  else if (mediaType === "*/*" || mediaType.endsWith("/*")) {
    const binary = isRecord(rawSchema) && rawSchema["format"] === "binary";
    decode = output !== undefined && !binary ? "json" : "auto";
    note(
      "warning",
      "wildcard_media_type",
      decode === "json"
        ? `response media type is "${mediaType}" with a schema; assumed JSON`
        : `response media type is "${mediaType}"; decoded by Content-Type at runtime`,
      resp.pointer,
    );
    penalties.add("wildcardMediaType");
  } else decode = "binary";

  return { output, mapping: { status: normalizedStatus, mediaType, decode } };
}

function resolveBaseUrl(doc: OpenApiDocument, options: MapOpenApiOptions, diagnostics: Diagnostic[]): string | undefined {
  const error = (code: string, message: string) => {
    diagnostics.push({ severity: "error", code, message, pointer: "#/servers" });
    return undefined;
  };
  let url = options.baseUrl;
  if (url === undefined) {
    const servers = doc.servers ?? [];
    if (servers.length > 1) {
      diagnostics.push({ severity: "info", code: "multiple_servers", message: `using the first of ${servers.length} servers`, pointer: "#/servers" });
    }
    const server = servers[0] ?? { url: "/" };
    url = server.url.replace(/\{([^}]+)\}/g, (_m, name: string) => server.variables?.[name]?.default ?? `{${name}}`);
    if (/\{[^}]+\}/.test(url)) return error("unresolved_server_variable", `server URL has variables without defaults: ${url}`);
    if (!URL.canParse(url)) {
      if (options.documentUrl === undefined || !URL.canParse(url, options.documentUrl)) {
        return error("no_base_url", `server URL "${url}" is relative and no documentUrl or baseUrl was given`);
      }
      url = new URL(url, options.documentUrl).toString();
    }
  }
  url = url.replace(/\/+$/, "");
  const checked = BaseUrl.safeParse(url);
  if (!checked.success) return error("invalid_base_url", `base URL "${url}" is not allowed: ${checked.error.issues.map((i) => i.message).join(", ")}`);
  return checked.data;
}

/**
 * OpenAPI path keys may not contain a query or fragment, but real specs do:
 * Box labels variants of one endpoint with `#fragment`, OpenAI adds `?beta=true`.
 * The fragment is never sent; literal query pairs become fixed query parameters.
 */
export function splitPathKey(key: string): { template: string; fixedQuery?: Record<string, string>; fragment?: string } {
  const hashAt = key.indexOf("#");
  const fragment = hashAt >= 0 ? key.slice(hashAt + 1) : undefined;
  const withoutFragment = hashAt >= 0 ? key.slice(0, hashAt) : key;
  const queryAt = withoutFragment.indexOf("?");
  const template = queryAt >= 0 ? withoutFragment.slice(0, queryAt) : withoutFragment;
  const result: { template: string; fixedQuery?: Record<string, string>; fragment?: string } = { template: template || "/" };
  if (queryAt >= 0) {
    const pairs = [...new URLSearchParams(withoutFragment.slice(queryAt + 1))];
    if (pairs.length > 0) result.fixedQuery = Object.fromEntries(pairs);
  }
  if (fragment) result.fragment = fragment;
  return result;
}

const FORM_BODY_STYLES = new Set(["form", "spaceDelimited", "pipeDelimited", "deepObject"]);

/**
 * The non-default field encodings of a form body. Without them Stripe-style nested fields
 * (`metadata[key]=v`) would go out as JSON text, which such APIs reject.
 */
function formEncoding(
  mediaType: string,
  encoding: Record<string, { style?: string | undefined; explode?: boolean | undefined }> | undefined,
  note: (severity: Diagnostic["severity"], code: string, message: string, at?: string) => void,
  pointer: string,
): Record<string, BodyFieldEncoding> | undefined {
  if (encoding === undefined || mediaType.split(";")[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") return undefined;
  const out: Record<string, BodyFieldEncoding> = {};
  for (const [field, e] of Object.entries(encoding)) {
    const style = e.style ?? "form";
    if (!FORM_BODY_STYLES.has(style)) {
      note("warning", "unsupported_body_encoding", `form field "${field}" uses style "${style}", which form bodies don't support; sent as form`, `${pointer}/${escapePointerToken(field)}`);
      continue;
    }
    const explode = e.explode ?? style === "form";
    if (style === "form" && explode) continue;
    out[field] = { style: style as BodyFieldEncoding["style"], explode };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function pickRequestMediaType(types: string[]): string | undefined {
  return (
    types.find((t) => t === "application/json") ??
    types.find(isJsonMediaType) ??
    types.find((t) => t === "application/x-www-form-urlencoded") ??
    types.find((t) => t.startsWith("multipart/")) ??
    types[0]
  );
}

function pickResponseMediaType(types: string[]): string | undefined {
  return types.find((t) => t === "application/json") ?? types.find(isJsonMediaType) ?? types.find((t) => t.startsWith("text/")) ?? types[0];
}

function isJsonMediaType(type: string): boolean {
  const base = type.split(";")[0]?.trim().toLowerCase() ?? "";
  return base === "application/json" || base.endsWith("+json");
}

/** Add a description/deprecated flag next to a converted schema (valid next to $ref in 2020-12). */
function withAnnotations(schema: unknown, description: string | undefined, deprecated: boolean | undefined): unknown {
  if (typeof schema === "boolean") return schema;
  const out = { ...(schema as Record<string, unknown>) };
  if (description?.trim() && out["description"] === undefined) out["description"] = description.trim();
  if (deprecated === true) out["deprecated"] = true;
  return out;
}

function errorDiagnostic(e: unknown, pointer: string): Diagnostic {
  if (e instanceof MappingError) return { severity: "error", code: e.code, message: e.message, pointer: e.pointer ?? pointer };
  return { severity: "error", code: "unexpected_error", message: e instanceof Error ? e.message : String(e), pointer };
}
