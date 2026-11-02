import { z } from "zod";
import { isRecord } from "../util.ts";

/** Every schema in the IR uses this dialect. OpenAPI 3.0 schemas are converted to it on ingest. */
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

export const JsonValue = z.json();
export type JsonValue = z.infer<typeof JsonValue>;

/**
 * A JSON Schema (2020-12) object. Zod checks only that it is a JSON object and
 * self-contained; keyword-level validity is checked by a JSON Schema validator
 * in the ingest tests.
 */
export const JsonSchema = z
  .record(z.string(), z.json())
  .superRefine((schema, ctx) => {
    for (const problem of findRefProblems(schema)) {
      ctx.addIssue({ code: "custom", message: problem });
    }
  });
export type JsonSchema = z.infer<typeof JsonSchema>;

/** A JSON Schema whose root is `type: "object"`, as MCP requires for tool input. */
export const ObjectJsonSchema = JsonSchema.refine((s) => s["type"] === "object", {
  message: 'root schema must have type "object"',
});

const LOCAL_DEF_PREFIX = "#/$defs/";

/**
 * IR schemas must be self-contained: every `$ref` points into the root `$defs`
 * and the target exists. This lets runtime and MCP layers use a schema without
 * the original API description.
 */
export function findRefProblems(schema: Record<string, unknown>): string[] {
  const defs = isRecord(schema["$defs"]) ? schema["$defs"] : {};
  const problems: string[] = [];
  walk(schema, (node) => {
    const ref = node["$ref"];
    if (ref === undefined) return;
    if (typeof ref !== "string" || !ref.startsWith(LOCAL_DEF_PREFIX)) {
      problems.push(`$ref must start with "${LOCAL_DEF_PREFIX}": ${String(ref)}`);
      return;
    }
    const name = decodePointerToken(ref.slice(LOCAL_DEF_PREFIX.length));
    if (!(name in defs)) problems.push(`$ref target is missing from $defs: ${ref}`);
  });
  return problems;
}

/** Top-level property names of an object schema. */
export function objectPropertyNames(schema: JsonSchema): string[] {
  const props = schema["properties"];
  return isRecord(props) ? Object.keys(props) : [];
}

export function requiredPropertyNames(schema: JsonSchema): string[] {
  const req = schema["required"];
  return Array.isArray(req) ? req.filter((x): x is string => typeof x === "string") : [];
}

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
  } else if (isRecord(node)) {
    visit(node);
    for (const [key, value] of Object.entries(node)) {
      // `const`, `default`, `enum`, and `examples` hold data, not schemas.
      if (key === "const" || key === "default" || key === "enum" || key === "examples") continue;
      walk(value, visit);
    }
  }
}

function decodePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}
