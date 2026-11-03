import { isRecord as isPlainObject, type BodyBinding, type Operation, type ParameterBinding } from "@cairnmcp/core";
import { fail } from "./errors.ts";

/** A request ready for auth and sending. Pure data; no secrets yet. */
export type RequestPlan = {
  method: string;
  /** Path plus query, relative to the source base URL. */
  pathAndQuery: string;
  headers: Record<string, string>;
  cookies: string[];
  body?: string;
};

/**
 * Turn validated tool input into an HTTP request using the operation's IR
 * mapping. Pure. Serialization follows OpenAPI `style`/`explode` rules for the
 * styles agents realistically send (simple, label, matrix, form, space- and
 * pipe-delimited, deepObject).
 */
export function buildRequest(op: Operation, input: Record<string, unknown>): RequestPlan {
  const mapping = op.mapping;
  const query: string[] = [];
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  let path = mapping.pathTemplate;

  for (const binding of mapping.parameters) {
    const value = input[binding.property];
    if (value === undefined) continue;
    switch (binding.in) {
      case "path":
        path = path.replace(`{${binding.wireName}}`, () => pathValue(binding, value));
        break;
      case "query":
        query.push(...queryPairs(binding, value));
        break;
      case "header":
        headers[binding.wireName] = headerValue(binding, value);
        break;
      case "cookie":
        cookies.push(`${binding.wireName}=${encodeURIComponent(scalarList(value, binding).join(","))}`);
        break;
    }
  }
  for (const [name, value] of Object.entries(mapping.fixedQuery ?? {})) {
    query.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  }

  const plan: RequestPlan = {
    method: mapping.method,
    pathAndQuery: query.length > 0 ? `${path}?${query.join("&")}` : path,
    headers,
    cookies,
  };
  plan.headers["accept"] = mapping.response.decode === "json" ? "application/json" : "*/*";

  if (mapping.body) {
    const value = input[mapping.body.property];
    if (value !== undefined) {
      const { body, contentType } = encodeBody(mapping.body, value);
      plan.body = body;
      plan.headers["content-type"] = contentType;
    }
  }
  return plan;
}

function pathValue(binding: ParameterBinding, value: unknown): string {
  const parts = scalarList(value, binding);
  // A path segment of "." or ".." would let input climb to a different path on the same host.
  if (parts.some((p) => p === "." || p === "..")) {
    fail("invalid_input", `"${binding.property}" cannot be "." or ".."`);
  }
  const encoded = isPlainObject(value) && binding.explode
    ? Object.entries(value).map(([k, v]) => `${enc(k)}=${enc(scalar(v, binding))}`)
    : parts.map(enc);
  switch (binding.style) {
    case "label":
      return `.${encoded.join(binding.explode ? "." : ",")}`;
    case "matrix":
      return binding.explode && Array.isArray(value)
        ? encoded.map((e) => `;${enc(binding.wireName)}=${e}`).join("")
        : `;${enc(binding.wireName)}=${encoded.join(",")}`;
    default:
      return encoded.join(",");
  }
}

function queryPairs(binding: ParameterBinding, value: unknown): string[] {
  const name = enc(binding.wireName);
  if (binding.style === "deepObject") {
    if (!isPlainObject(value)) fail("invalid_input", `"${binding.property}" must be an object`);
    return Object.entries(value).map(([k, v]) => `${name}%5B${enc(k)}%5D=${enc(scalar(v, binding))}`);
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => enc(scalar(v, binding)));
    if (binding.style === "spaceDelimited") return [`${name}=${items.join("%20")}`];
    if (binding.style === "pipeDelimited") return [`${name}=${items.join("%7C")}`];
    return binding.explode ? items.map((i) => `${name}=${i}`) : [`${name}=${items.join(",")}`];
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).map(([k, v]) => [enc(k), enc(scalar(v, binding))] as const);
    return binding.explode ? entries.map(([k, v]) => `${k}=${v}`) : [`${name}=${entries.flat().join(",")}`];
  }
  return [`${name}=${enc(scalar(value, binding))}`];
}

function headerValue(binding: ParameterBinding, value: unknown): string {
  const out = isPlainObject(value)
    ? Object.entries(value).map(([k, v]) => (binding.explode ? `${k}=${scalar(v, binding)}` : `${k},${scalar(v, binding)}`)).join(",")
    : scalarList(value, binding).join(",");
  if (/[\r\n]/.test(out)) fail("invalid_input", `"${binding.property}" cannot contain line breaks`);
  return out;
}

function scalarList(value: unknown, binding: ParameterBinding): string[] {
  if (Array.isArray(value)) return value.map((v) => scalar(v, binding));
  if (isPlainObject(value)) return Object.entries(value).flatMap(([k, v]) => [k, scalar(v, binding)]);
  return [scalar(value, binding)];
}

function scalar(value: unknown, binding: ParameterBinding): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fail("invalid_input", `"${binding.property}" has a nested value that cannot be sent as ${binding.in} parameter`);
}

function encodeBody(binding: BodyBinding, value: unknown): { body: string; contentType: string } {
  const mediaType = binding.mediaType;
  const base = mediaType.split(";")[0]!.trim().toLowerCase();
  if (base === "application/json" || base.endsWith("+json")) return { body: JSON.stringify(value), contentType: mediaType };
  if (base === "application/x-www-form-urlencoded") {
    if (!isPlainObject(value)) fail("invalid_input", "form body must be an object");
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      const encoding = binding.encoding?.[k];
      if (encoding?.style === "deepObject") appendNested(params, k, v);
      else if (Array.isArray(v) && encoding && !encoding.explode) {
        params.append(k, v.map(formScalar).join(DELIMITERS[encoding.style]));
      } else if (Array.isArray(v)) v.forEach((item) => params.append(k, formScalar(item)));
      else params.append(k, formScalar(v));
    }
    return { body: params.toString(), contentType: mediaType };
  }
  if (base.startsWith("text/")) {
    if (typeof value !== "string") fail("invalid_input", `body must be a string for ${base}`);
    return { body: value, contentType: mediaType };
  }
  return fail("unsupported", `request bodies of type ${base} are not supported yet`, { retryable: false });
}

const DELIMITERS = { form: ",", spaceDelimited: " ", pipeDelimited: "|", deepObject: "," } as const;

/** Bracket nesting for deepObject form fields: `a[b]=1`, `a[0][c]=2`. */
function appendNested(params: URLSearchParams, key: string, value: unknown): void {
  if (Array.isArray(value)) value.forEach((item, i) => appendNested(params, `${key}[${i}]`, item));
  else if (isPlainObject(value)) for (const [k, v] of Object.entries(value)) appendNested(params, `${key}[${k}]`, v);
  else if (value !== undefined) params.append(key, formScalar(value));
}

function formScalar(v: unknown): string {
  if (v === null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
