import { describe, expect, it } from "vitest";
import { Instant } from "./time.ts";

describe("time convention", () => {
  it("Instant requires UTC with Z", () => {
    expect(Instant.safeParse("2026-10-30T18:48:57Z").success).toBe(true);
    expect(Instant.safeParse("2026-10-30T18:48:57.123Z").success).toBe(true);
    expect(Instant.safeParse("2026-10-30T18:48:57+02:00").success).toBe(false);
    expect(Instant.safeParse("2026-10-30").success).toBe(false);
  });
});
