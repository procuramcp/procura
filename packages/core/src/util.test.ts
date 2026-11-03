import { describe, expect, it } from "vitest";
import { countBySideEffect } from "./ir/side-effect.ts";
import { instantOf } from "./time.ts";
import { canonicalJson, isRecord, omitUndefined, sameJson, slugify, truncate } from "./util.ts";

describe("shared helpers", () => {
  it("isRecord accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it("omitUndefined drops undefined but keeps null, 0, and empty strings", () => {
    expect(omitUndefined({ a: 1, b: undefined, c: null, d: 0, e: "" })).toEqual({ a: 1, c: null, d: 0, e: "" });
  });

  it("slugify makes a lowercase slug or nothing", () => {
    expect(slugify("Intervals.icu API v1")).toBe("intervals-icu-api-v1");
    expect(slugify("¡¡!!")).toBeUndefined();
    expect(slugify(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
  });

  it("truncate adds an ellipsis only when it cuts", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("abcd", 3)).toBe("ab…");
  });

  it("instantOf drops .000 and keeps other milliseconds", () => {
    expect(instantOf(new Date(Date.UTC(2026, 9, 30, 18, 48, 57)))).toBe("2026-10-30T18:48:57Z");
    expect(instantOf(new Date(Date.UTC(2026, 9, 30, 18, 48, 57, 123)))).toBe("2026-10-30T18:48:57.123Z");
  });

  it("countBySideEffect tallies each class", () => {
    const op = (c: "read" | "write" | "destructive") => ({ sideEffect: { class: c } });
    expect(countBySideEffect([op("read"), op("read"), op("destructive")])).toEqual({ total: 3, read: 2, write: 0, destructive: 1 });
  });
});

describe("sameJson", () => {
  it("ignores object key order, not array order", () => {
    expect(sameJson({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }, { b: { c: [1, { e: 3, d: 2 }] }, a: 1 })).toBe(true);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson({ a: undefined }, {})).toBe(true);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
