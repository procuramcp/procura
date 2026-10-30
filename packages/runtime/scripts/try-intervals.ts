// First live call: read your own recent Intervals.icu activities through the
// full pipeline (ingest → toolset → vault → runtime). Read-only.
//
// Setup (once): copy .env.example to .env at the repo root and set INTERVALS_API_KEY
// (Intervals.icu → Settings → Developer Settings). Then run: pnpm try:intervals
//
// Prints a summary only. Never prints your key or raw activity data.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveToolset, TenantId, Toolset, type Source } from "@cairnmcp/core";
import { ingestOpenApiText } from "@cairnmcp/ingest";
import { InMemoryVaultStore, LocalKeyWrapper, parseMasterKey, Vault } from "@cairnmcp/vault";
import { InMemoryAuditSink, InMemoryRateLimiter, Runtime } from "../src/index.ts";

const root = resolve(import.meta.dirname, "../../..");
if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));

const apiKey = process.env["INTERVALS_API_KEY"]?.trim();
if (!apiKey) {
  console.error("INTERVALS_API_KEY is not set. Copy .env.example to .env at the repo root and add your key.");
  process.exit(1);
}
const masterKey = process.env["CAIRNMCP_MASTER_KEY"] ? parseMasterKey(process.env["CAIRNMCP_MASTER_KEY"]) : randomBytes(32);

// 1. Ingest the Intervals.icu description and apply the one curation step it needs.
const text = readFileSync(resolve(root, "packages/ingest/fixtures/intervals-icu/openapi.json"), "utf8");
const mapped = ingestOpenApiText(text, { sourceId: "intervals-icu" });
if (!mapped.ok) throw new Error("could not map the Intervals.icu spec");
const source: Source = {
  ...mapped.ir.source,
  authSchemes: mapped.ir.source.authSchemes.map((s) => (s.id === "APIKey" && s.type === "http_basic" ? { ...s, fixedUsername: "API_KEY" } : s)),
};

// 2. A read-only toolset pinned to the authenticated athlete.
const resolved = resolveToolset(
  Toolset.parse({
    id: "try",
    sourceId: "intervals-icu",
    name: "Try",
    tools: [{ operationId: "list_activities", name: "list_activities", description: "List my activities.", pinnedInputs: { id: "0" } }],
  }),
  mapped.ir,
);
if (!resolved.ok) throw new Error(JSON.stringify(resolved.issues));
const tool = resolved.tools[0]!;

// 3. Store the key in an (in-memory) vault, as the server will.
const tenantId = TenantId.parse("local-me");
const vault = new Vault({ store: new InMemoryVaultStore(), keyWrapper: new LocalKeyWrapper(masterKey) });
await vault.putCredential({ tenantId, sourceId: source.id, schemeId: "APIKey", credential: { kind: "basic", password: apiKey } });

const runtime = new Runtime({
  fetch: (url, init) => fetch(url, init),
  credentials: vault,
  limiter: new InMemoryRateLimiter(),
  audit: new InMemoryAuditSink(),
});

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const oldest = day(-14);

// 4. Call it.
console.log(`Listing your activities since ${oldest} (read-only)…`);
const all = await runtime.invoke({ tenantId, source, tool, args: { oldest, limit: 10 } });
if (!all.ok) {
  console.error(`Failed: ${all.error.kind}: ${all.error.message}`);
  process.exit(1);
}
const activities = Array.isArray(all.data) ? (all.data as Array<Record<string, unknown>>) : [];
console.log(`OK: HTTP ${all.status}, ${activities.length} activities`);
for (const a of activities.slice(0, 10)) {
  const minutes = typeof a["moving_time"] === "number" ? Math.round(a["moving_time"] / 60) : "?";
  console.log(`  ${String(a["start_date_local"] ?? "?").slice(0, 10)}  ${String(a["type"] ?? "?").padEnd(16)} ${String(minutes).padStart(4)} min  load ${a["icu_training_load"] ?? "-"}`);
}

// 5. Settle an open question: does `fields` accept repeated values (what the spec implies)?
const wanted = ["id", "type", "start_date_local"];
const narrowed = await runtime.invoke({ tenantId, source, tool, args: { oldest, limit: 3, fields: wanted } });
if (narrowed.ok && Array.isArray(narrowed.data) && narrowed.data.length > 0) {
  const keys = Object.keys(narrowed.data[0] as object).sort();
  const honored = keys.every((k) => wanted.includes(k));
  console.log(`\n"fields" sent as fields=id&fields=type&…: ${honored ? "honored ✅" : `ignored ❌ (got ${keys.length} fields)`}`);
} else {
  console.log(`\n"fields" check skipped (${narrowed.ok ? "no activities in range" : narrowed.error.kind})`);
}
