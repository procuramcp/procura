import { z } from "zod";

/**
 * Date/time convention for all of cairnmcp (see docs/DECISIONS.md, D-010).
 *
 * - `Instant`: a point in time, always UTC, ISO-8601 with a trailing `Z`
 *   (e.g. `2026-10-30T18:48:57Z`). Used for audit timestamps, ingestion times,
 *   and raw activity start times.
 * - `LocalDate`: a calendar day in the athlete's own time zone (`YYYY-MM-DD`).
 *   Training load, baselines, and dated settings are keyed by `LocalDate`,
 *   because an 11pm Tuesday ride belongs to Tuesday for the athlete.
 *
 * The two are distinct branded types, so passing one where the other is
 * expected is a compile error. `core` never reads the clock: callers pass
 * "now" or an as-of date in.
 */
export const Instant = z.iso.datetime({ offset: false }).brand<"Instant">();
export type Instant = z.infer<typeof Instant>;

export const LocalDate = z.iso.date().brand<"LocalDate">();
export type LocalDate = z.infer<typeof LocalDate>;
