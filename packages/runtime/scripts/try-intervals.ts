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
// "0" means "the athlete this API key belongs to" (confirmed). Set INTERVALS_ATHLETE_ID (e.g. i12345,
// shown on your Intervals.icu settings page) to use an explicit id instead.
const athleteId = process.env["INTERVALS_ATHLETE_ID"]?.trim() || "0";
if (!/^(0|i?\d+)$/.test(athleteId)) {
  console.error(`INTERVALS_ATHLETE_ID should look like i12345 (or be empty to use 0); got "${athleteId}".`);
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
    tools: [{ operationId: "list_activities", name: "list_activities", description: "List my activities.", pinnedInputs: { id: athleteId } }],
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
console.log(`Listing activities for athlete ${athleteId === "0" ? "0 (the key's own athlete)" : athleteId} since ${oldest} (read-only)…`);
const all = await runtime.invoke({ tenantId, source, tool, args: { oldest, limit: 10 } });
if (!all.ok) {
  console.error(`Failed: ${all.error.kind}: ${all.error.message}`);
  if (athleteId === "0" && all.error.kind === "upstream_error" && (all.error.status === 403 || all.error.status === 404)) {
    console.error('Tip: athlete id "0" may not be accepted. Set INTERVALS_ATHLETE_ID in .env to your id (e.g. i12345) and retry.');
  }
  process.exit(1);
}
const activities = Array.isArray(all.data) ? (all.data as Array<Record<string, unknown>>) : [];
// Activities synced from Strava come back as stubs (Strava's API terms): no type, duration, or load.
const isStub = (a: Record<string, unknown>) => a["type"] === undefined && a["moving_time"] === undefined;
console.log(`OK: HTTP ${all.status}, ${activities.length} activities`);
for (const a of activities.slice(0, 10)) {
  if (isStub(a)) {
    console.log(`  ${String(a["start_date_local"] ?? "?").slice(0, 10)}  (stub, likely from Strava: details not available via the API)`);
    continue;
  }
  const minutes = typeof a["moving_time"] === "number" ? Math.round(a["moving_time"] / 60) : "?";
  console.log(`  ${String(a["start_date_local"] ?? "?").slice(0, 10)}  ${String(a["type"] ?? "?").padEnd(16)} ${String(minutes).padStart(4)} min  load ${a["icu_training_load"] ?? "-"}`);
}
const stub = activities.find(isStub);
if (stub) console.log(`  Stub field names: ${Object.keys(stub).sort().join(", ")}`);

// 5. Settle an open question: how does Intervals.icu want the `fields` list encoded?
//    The spec implies repeated values (fields=a&fields=b); its description says comma-separated.
//    Compare the same full (non-stub) activity with and without `fields`, in both encodings.
const sample = activities.find((a) => !isStub(a));
if (!sample) {
  console.log('\n"fields" check skipped: no non-stub activities in range.');
} else {
  const wanted = ["id", "type", "start_date_local"];
  const fullCount = Object.keys(sample).length;
  const commaTool = toolWithFieldsExplode(false);
  console.log(`\n"fields" check (a full activity has ${fullCount} fields; asked for ${wanted.length}):`);
  for (const [label, t] of [["repeated  fields=id&fields=type&…", tool], ["comma     fields=id,type,…", commaTool]] as const) {
    const r = await runtime.invoke({ tenantId, source, tool: t, args: { oldest, limit: 10, fields: wanted } });
    const same = r.ok && Array.isArray(r.data) ? (r.data as Array<Record<string, unknown>>).find((a) => a["id"] === sample["id"]) : undefined;
    if (!same) {
      console.log(`  ${label}: inconclusive (${r.ok ? "activity not in response" : r.error.kind})`);
      continue;
    }
    const keys = Object.keys(same);
    const honored = keys.length < fullCount && keys.every((k) => wanted.includes(k));
    console.log(`  ${label}: ${honored ? "honored ✅" : "ignored ❌"} (${keys.length} fields${honored ? "" : `: ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ", …" : ""}`})`);
  }
}

/** Same tool, with the `fields` parameter serialized comma-separated instead of repeated. */
function toolWithFieldsExplode(explode: boolean) {
  const op = tool.operation;
  return {
    ...tool,
    operation: {
      ...op,
      mapping: { ...op.mapping, parameters: op.mapping.parameters.map((p) => (p.wireName === "fields" ? { ...p, explode } : p)) },
    },
  };
}
