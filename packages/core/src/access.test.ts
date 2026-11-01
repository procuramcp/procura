import { describe, expect, it } from "vitest";
import { canCall } from "./access.ts";

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
