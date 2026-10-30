import { describe, expect, it } from "vitest";
import { Instant, LocalDate } from "./time.ts";

describe("time convention", () => {
  it("Instant requires UTC with Z", () => {
    expect(Instant.safeParse("2026-10-30T18:48:57Z").success).toBe(true);
    expect(Instant.safeParse("2026-10-30T18:48:57+02:00").success).toBe(false);
    expect(Instant.safeParse("2026-10-30").success).toBe(false);
  });

  it("LocalDate is a calendar day only", () => {
    expect(LocalDate.safeParse("2026-10-30").success).toBe(true);
    expect(LocalDate.safeParse("2026-10-30T00:00:00Z").success).toBe(false);
    expect(LocalDate.safeParse("2026-02-30").success).toBe(false);
  });
});
