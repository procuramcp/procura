import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { mapOpenApi, type MapOpenApiOptions, type MapOpenApiResult } from "./map-openapi.ts";

/** Largest description document accepted, in bytes. Large real-world specs are a few MB. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/**
 * Parse an OpenAPI document from text (JSON or YAML), record its hash, and map it.
 * Fetching the text is the caller's job (and goes through egress controls).
 */
export function ingestOpenApiText(text: string, options: Omit<MapOpenApiOptions, "documentSha256"> = {}): MapOpenApiResult {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      diagnostics: [{ severity: "error", code: "document_too_large", message: `document is ${bytes} bytes; limit is ${MAX_DOCUMENT_BYTES}` }],
    };
  }
  let raw: unknown;
  try {
    raw = text.trimStart().startsWith("{") ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 100 });
  } catch (e) {
    return {
      ok: false,
      diagnostics: [{ severity: "error", code: "unparseable_document", message: `not valid JSON or YAML: ${e instanceof Error ? e.message : String(e)}` }],
    };
  }
  const documentSha256 = createHash("sha256").update(text, "utf8").digest("hex");
  return mapOpenApi(raw, { ...options, documentSha256 });
}
