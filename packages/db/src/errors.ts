/** Postgres error codes the app reacts to (https://www.postgresql.org/docs/current/errcodes-appendix.html). */
export const PG = {
  /** A row points at one that doesn't exist (e.g. a user who never signed in). */
  FOREIGN_KEY_VIOLATION: "23503",
  /** The row already exists. */
  UNIQUE_VIOLATION: "23505",
} as const;

/** The Postgres error code, also when a library wraps the error (Drizzle puts it on `cause`). */
export function pgErrorCode(e: unknown): string | undefined {
  for (let c: unknown = e; c !== null && typeof c === "object"; c = (c as { cause?: unknown }).cause) {
    const code = (c as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}
