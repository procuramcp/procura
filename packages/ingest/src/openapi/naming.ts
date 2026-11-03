import { splitWords } from "@procura/core";

const MAX_ID = 64;

/** `getActivity` → `get_activity`; `GET /api/v1/athlete/{id}` → `get_api_v1_athlete_by_id`. */
export function operationIdFrom(operationId: string | undefined, method: string, path: string): string {
  const text =
    operationId !== undefined && splitWords(operationId).length > 0
      ? operationId
      : `${method} ${path.replace(/\{([^}]+)\}/g, " by $1 ")}`;
  let id = splitWords(text).join("_");
  if (!/^[a-z]/.test(id)) id = `op_${id}`;
  return id.slice(0, MAX_ID).replace(/_+$/, "");
}

/** Make `base` unique within `used` by appending `_2`, `_3`, ... (and record it). */
export function uniqueName(base: string, used: Set<string>, max = MAX_ID): string {
  let name = base;
  for (let n = 2; used.has(name); n++) {
    const suffix = `_${n}`;
    name = `${base.slice(0, max - suffix.length)}${suffix}`;
  }
  used.add(name);
  return name;
}

/** Input property name for a wire name: keep it if safe, else replace unsafe characters. */
export function propertyNameFrom(wireName: string): string {
  const safe = wireName.replace(/[^A-Za-z0-9_.-]/g, "_");
  return safe.length > 0 ? safe : "param";
}

/** `get_activity` → `Get activity`. */
export function humanize(id: string): string {
  const words = id.split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
