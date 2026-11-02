import type { JsonValue } from "./api";

/** Text from an input field to the JSON value its schema type expects; anything unparseable stays a string. */
export function parseValue(text: string, type: string): JsonValue {
  if (type === "string") return text;
  if ((type === "integer" || type === "number") && text.trim() !== "" && Number.isFinite(Number(text))) return Number(text);
  if (type === "boolean" && (text === "true" || text === "false")) return text === "true";
  if (type === "array" || type === "object" || type === "any") {
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return text;
    }
  }
  return text;
}

export function display(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
