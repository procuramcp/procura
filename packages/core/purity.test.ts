// `core` must stay pure (no I/O, no clock, no randomness). Node and DOM types are
// absent from its tsconfig, so imports of node:* or fetch/timers fail to compile.
// This test catches what types cannot: ES built-ins that read the clock or entropy.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("./src/", import.meta.url).pathname;
const FORBIDDEN: [RegExp, string][] = [
  [/\bDate\.now\s*\(/, "Date.now(): pass the time in"],
  [/\bnew Date\s*\(\s*\)/, "new Date(): pass the time in"],
  [/\bMath\.random\s*\(/, "Math.random(): inject a random source"],
  [/\bprocess\./, "process: core has no environment access"],
  [/\bcrypto\./, "crypto: hashing and keys belong outside core"],
  [/from\s+["'](?:node:|fs|http|https|net|pg|postgres|drizzle|ioredis|@upstash)/, "I/O module import"],
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : [],
  );
}

describe("core purity", () => {
  it("has no clock, randomness, environment, or I/O access", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const [pattern, why] of FORBIDDEN) if (pattern.test(text)) violations.push(`${file.slice(SRC.length)}: ${why}`);
    }
    expect(violations).toEqual([]);
  });
});
