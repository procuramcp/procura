import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { Secret } from "./secret.ts";

describe("Secret", () => {
  const s = new Secret("hunter2-very-secret");

  it("reveals only on request", () => {
    expect(s.reveal()).toBe("hunter2-very-secret");
  });

  it.each([
    ["String()", () => String(s)],
    ["template string", () => `${s}`],
    ["JSON.stringify", () => JSON.stringify({ token: s })],
    ["util.inspect (console.log)", () => inspect({ nested: { token: s } })],
    ["Error message", () => new Error(`bad token ${s}`).message],
  ])("is redacted in %s", (_name, render) => {
    const out = render();
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[redacted]");
  });
});
