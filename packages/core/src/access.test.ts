import { describe, expect, it } from "vitest";
import { canCall, hasTeamRole } from "./access.ts";

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
