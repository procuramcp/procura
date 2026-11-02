// Small pure helpers shared by every package. Check here before writing a local copy.

/** A plain object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keys whose value is `undefined` removed, so the result fits optional
 * properties under `exactOptionalPropertyTypes`. Replaces the
 * `...(x !== undefined ? { x } : {})` pattern.
 */
export function omitUndefined<T extends Record<string, unknown>>(obj: T): OmitUndefined<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as OmitUndefined<T>;
}

export type OmitUndefined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** A lowercase slug (`My API v2` → `my-api-v2`), at most 64 characters, or undefined if nothing is left. */
export function slugify(text: string): string | undefined {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug || undefined;
}

/** `text` cut to `max` characters, with an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
