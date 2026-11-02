import { describe, expect, it } from "vitest";
import { callLimits, canCall, hasTeamRole, PlanLimits } from "./access.ts";

describe("canCall", () => {
  it("allows nothing without access", () => {
    for (const effect of ["read", "write", "destructive"] as const) expect(canCall(undefined, effect)).toBe(false);
  });

  it("allows only reads with use", () => {
    expect(canCall("use", "read")).toBe(true);
    expect(canCall("use", "write")).toBe(false);
    expect(canCall("use", "destructive")).toBe(false);
  });

  it("allows everything with use_writes", () => {
    for (const effect of ["read", "write", "destructive"] as const) expect(canCall("use_writes", effect)).toBe(true);
  });

  it("fails closed on an unknown level", () => {
    expect(canCall("admin" as never, "read")).toBe(false);
  });
});

describe("hasTeamRole (D-038)", () => {
  it("ranks the team owner > admin > editor > viewer", () => {
    expect(hasTeamRole("owner", "admin")).toBe(true);
    expect(hasTeamRole("admin", "admin")).toBe(true);
    expect(hasTeamRole("editor", "admin")).toBe(false);
    expect(hasTeamRole("editor", "viewer")).toBe(true);
    expect(hasTeamRole("viewer", "editor")).toBe(false);
  });

  it("never lets customers or non-members into the console", () => {
    expect(hasTeamRole("customer", "viewer")).toBe(false);
    expect(hasTeamRole(undefined, "viewer")).toBe(false);
  });
});

describe("callLimits (D-039)", () => {
  const free = { level: "use" as const, limits: { requestsPerMinute: 10, perDay: 100, upgradeUrl: "https://example.com/pricing" } };
  const pro = { level: "use_writes" as const, limits: { requestsPerMinute: 60, perDay: 5000, perMonth: 100_000 } };

  it("takes the most generous limit of the rules that allow the call", () => {
    expect(callLimits({ rules: [free, pro] }, "list", "read")).toEqual({ requestsPerMinute: 60, perDay: 5000, upgradeUrl: "https://example.com/pricing" });
  });

  it("ignores rules that don't allow the call", () => {
    expect(callLimits({ rules: [free, pro] }, "update", "write")).toEqual({ requestsPerMinute: 60, perDay: 5000, perMonth: 100_000 });
    expect(callLimits({ rules: [{ ...free, operations: ["other"] }, pro] }, "list", "read")).toEqual(pro.limits);
    expect(callLimits({ rules: [free] }, "update", "write")).toBeUndefined();
  });

  it("lets a direct grant or an unset limit mean no limit", () => {
    expect(callLimits({ rules: [free, { level: "use" }] }, "list", "read")).toEqual({ upgradeUrl: "https://example.com/pricing" });
    expect(callLimits({ rules: [free, { level: "use", limits: { perDay: 500 } }] }, "list", "read")).toEqual({ perDay: 500, upgradeUrl: "https://example.com/pricing" });
  });

  it("accepts only https upgrade links", () => {
    expect(PlanLimits.safeParse({ upgradeUrl: "http://example.com" }).success).toBe(false);
    expect(PlanLimits.safeParse({ upgradeUrl: "https://example.com/upgrade" }).success).toBe(true);
    expect(PlanLimits.safeParse({ perDay: 0 }).success).toBe(false);
  });
});
