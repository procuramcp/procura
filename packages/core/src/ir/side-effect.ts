import { z } from "zod";

export const SideEffect = z.enum(["read", "write", "destructive"]);
export type SideEffect = z.infer<typeof SideEffect>;

export const HttpMethod = z.enum(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
export type HttpMethod = z.infer<typeof HttpMethod>;

/**
 * Where a classification came from. Only `curated` (a human decision) may
 * rate an operation as less dangerous than its protocol default.
 */
export const ClassificationBasis = z.enum(["http_method", "graphql_operation", "name_heuristic", "curated"]);
export type ClassificationBasis = z.infer<typeof ClassificationBasis>;

const AutomaticClassification = z.object({
  class: SideEffect,
  basis: ClassificationBasis.exclude(["curated"]),
  reason: z.string().min(1).max(300),
});

export const SideEffectClassification = z.object({
  class: SideEffect,
  basis: ClassificationBasis,
  /** One short sentence a reviewer can check, e.g. `name contains "delete"`. */
  reason: z.string().min(1).max(300),
  /** On a `curated` classification: what ingest said, so it can be shown and restored (D-043). */
  automatic: AutomaticClassification.optional(),
});
export type SideEffectClassification = z.infer<typeof SideEffectClassification>;

const RANK: Record<SideEffect, number> = { read: 0, write: 1, destructive: 2 };

export function sideEffectRank(effect: SideEffect): number {
  return RANK[effect];
}

export function isAtLeast(effect: SideEffect, floor: SideEffect): boolean {
  return RANK[effect] >= RANK[floor];
}

export type SideEffectCounts = { total: number } & Record<SideEffect, number>;

/** How many operations read, write, or destroy: the summary every source view shows. */
export function countBySideEffect(operations: readonly { sideEffect: { class: SideEffect } }[]): SideEffectCounts {
  const counts: SideEffectCounts = { total: operations.length, read: 0, write: 0, destructive: 0 };
  for (const op of operations) counts[op.sideEffect.class] += 1;
  return counts;
}

/** What HTTP semantics alone imply about a method. */
export function httpMethodSideEffect(method: HttpMethod): SideEffect {
  switch (method) {
    case "GET":
    case "HEAD":
    case "OPTIONS":
      return "read";
    case "POST":
    case "PUT":
    case "PATCH":
      return "write";
    case "DELETE":
      return "destructive";
  }
}

// Words that suggest data loss. Matched against whole words of the operation
// name and path, so "deleted_items" or "undelete" do not match by accident
// (see the tests for the exact rules).
const DESTRUCTIVE_WORDS = new Set([
  "delete",
  "remove",
  "destroy",
  "purge",
  "wipe",
  "erase",
  "truncate",
  "drop",
  "reset",
  "clear",
]);

// Words that suggest a state change even when the method is GET.
const WRITE_WORDS = new Set(["create", "update", "set", "save", "upload", "import", "apply", "send", "trigger"]);

/**
 * Classify an HTTP operation. Starts from the method default and only ever
 * escalates based on words in the name or path: a heuristic can make an
 * operation look more dangerous, never less. Downgrades need a human
 * (`basis: "curated"`).
 *
 * Example: `PUT /activity/{id}/delete-intervals` is a write by method, but
 * escalated to destructive because the path says "delete".
 */
export function classifyHttpOperation(input: {
  method: HttpMethod;
  name: string;
  pathTemplate: string;
}): SideEffectClassification {
  const base = httpMethodSideEffect(input.method);
  const words = new Set([...splitWords(input.name), ...splitWords(stripPathParams(input.pathTemplate))]);

  const destructiveHit = [...words].find((w) => DESTRUCTIVE_WORDS.has(w));
  if (destructiveHit !== undefined && base !== "destructive") {
    return {
      class: "destructive",
      basis: "name_heuristic",
      reason: `${input.method} escalated: name or path contains "${destructiveHit}"`,
    };
  }

  const writeHit = [...words].find((w) => WRITE_WORDS.has(w));
  if (writeHit !== undefined && base === "read") {
    return {
      class: "write",
      basis: "name_heuristic",
      reason: `${input.method} escalated: name or path contains "${writeHit}"`,
    };
  }

  return { class: base, basis: "http_method", reason: `default for ${input.method}` };
}

/** Lowercase words from camelCase, snake_case, kebab-case, and path segments. */
export function splitWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

function stripPathParams(pathTemplate: string): string {
  return pathTemplate.replace(/\{[^}]*\}/g, " ");
}

/**
 * A person's classification of an operation (D-005: only people may rate one below its method
 * default). `"automatic"` restores what ingest said. Setting the automatic class again also
 * restores it, so a curated label always means a person disagreed with ingest.
 */
export function curateSideEffect(current: SideEffectClassification, effect: SideEffect | "automatic", reason?: string): SideEffectClassification {
  const automatic = current.basis === "curated" ? current.automatic : current;
  if (effect === "automatic") return automatic ?? current;
  if (automatic && automatic.class === effect) return automatic;
  return {
    class: effect,
    basis: "curated",
    reason: reason?.trim() || `marked ${effect} in the console`,
    ...(automatic ? { automatic: { class: automatic.class, basis: automatic.basis as Exclude<ClassificationBasis, "curated">, reason: automatic.reason } } : {}),
  };
}

// Verbs that name a lookup when an RPC-style API (Plaid: POST /accounts/get) uses POST for reads.
const READ_WORDS = new Set(["get", "list", "search", "query", "find", "lookup", "fetch", "retrieve", "read", "describe"]);

/**
 * Whether a POST looks like a read, for a person to confirm (D-043). Never applied on its own:
 * heuristics only escalate (D-005). Suggests only when the method default is the whole story
 * (no escalation) and the path ends in, or the name starts with, a lookup verb, with no
 * word that suggests a change anywhere.
 */
export function suggestRead(input: { method: HttpMethod; name: string; pathTemplate: string; sideEffect: SideEffectClassification }): string | undefined {
  if (input.method !== "POST" || input.sideEffect.basis !== "http_method" || input.sideEffect.class !== "write") return undefined;
  const pathWords = splitWords(stripPathParams(input.pathTemplate));
  const nameWords = splitWords(input.name);
  const all = [...pathWords, ...nameWords];
  if (all.some((w) => WRITE_WORDS.has(w) || DESTRUCTIVE_WORDS.has(w))) return undefined;
  // The name's last word is often a noun (Stripe's PostRadarValueListsValueList updates a list).
  const hit = [pathWords.at(-1), nameWords[0]].find((w) => w !== undefined && READ_WORDS.has(w));
  return hit ? `POST, but ${pathWords.at(-1) === hit ? "the path ends in" : "the name has"} "${hit}"` : undefined;
}
