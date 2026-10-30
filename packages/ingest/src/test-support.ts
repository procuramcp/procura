// Shared helpers for ingest tests. Not exported from the package index.
import { Ajv2020 } from "ajv/dist/2020.js";

/**
 * A strict JSON Schema 2020-12 validator. Strict mode rejects unknown
 * keywords, so any OpenAPI-only keyword that leaks through fails the tests.
 * Formats like `int32` are annotations only, so format validation is off.
 */
export function strictAjv() {
  return new Ajv2020({ strict: true, validateFormats: false, allowUnionTypes: true, allErrors: true });
}
