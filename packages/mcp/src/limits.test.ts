import { describe, expect, it } from "vitest";
import { duration } from "./limits.ts";

describe("duration", () => {
  it("reads like a person would say it", () => {
    expect([40, 180, 3600, 18_720, 90_000, 172_800].map(duration)).toEqual(["40s", "3m", "1h", "5h 12m", "1d 1h", "2d"]);
  });
});
