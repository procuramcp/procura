import { z } from "zod";

/**
 * Date/time convention (DECISIONS D-010): a point in time is an `Instant`,
 * always UTC, ISO-8601 with a trailing `Z` (e.g. `2026-10-30T18:48:57Z`).
 * Used for audit, ingestion, and credential-expiry timestamps. `core` never
 * reads the clock: callers pass the time in.
 */
export const Instant = z.iso.datetime({ offset: false }).brand<"Instant">();
export type Instant = z.infer<typeof Instant>;
