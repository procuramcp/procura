// Map an OpenAPI document to IR and write it to out/ for review.
// Usage: pnpm ir:dump [path-to-openapi] [source-id]
// Defaults to the Intervals.icu fixture.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { instantOf } from "@cairnmcp/core";
import { ingestOpenApiText } from "../src/index.ts";

const input = resolve(process.argv[2] ?? new URL("../fixtures/intervals-icu/openapi.json", import.meta.url).pathname);
const sourceId = process.argv[3] ?? (process.argv[2] ? undefined : "intervals-icu");
const result = ingestOpenApiText(readFileSync(input, "utf8"), {
  ...(sourceId ? { sourceId } : {}),
  derivedAt: instantOf(new Date()),
});

const outDir = resolve(import.meta.dirname, "../../../out");
mkdirSync(outDir, { recursive: true });
const name = result.ok ? result.ir.source.id : basename(input);
writeFileSync(resolve(outDir, `${name}.diagnostics.json`), `${JSON.stringify(result.diagnostics, null, 2)}\n`);

const bySeverity = Object.groupBy(result.diagnostics, (d) => d.severity);
console.log(`diagnostics: ${bySeverity.error?.length ?? 0} errors, ${bySeverity.warning?.length ?? 0} warnings, ${bySeverity.info?.length ?? 0} info`);
if (!result.ok) {
  console.error(result.diagnostics.filter((d) => d.severity === "error"));
  process.exit(1);
}
writeFileSync(resolve(outDir, `${name}.ir.json`), `${JSON.stringify(result.ir, null, 2)}\n`);
console.log(`${result.ir.operations.length} operations → out/${name}.ir.json`);
