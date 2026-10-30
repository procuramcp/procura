// Example: call Intervals.icu through cairnmcp with your own API key.
// Runs the whole pipeline (ingest → toolset → vault → runtime), read-only,
// and prints a short summary. Never prints the key.
//
// Setup: copy .env.example to .env in this folder and set INTERVALS_API_KEY
// (Intervals.icu → Settings → Developer Settings). Run: pnpm example:intervals
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveToolset, TenantId, Toolset, type Source } from "@cairnmcp/core";
import { ingestOpenApiText } from "@cairnmcp/ingest";
import { InMemoryAuditSink, InMemoryRateLimiter, Runtime } from "@cairnmcp/runtime";
import { InMemoryVaultStore, LocalKeyWrapper, parseMasterKey, Vault } from "@cairnmcp/vault";

const here = import.meta.dirname;
if (existsSync(resolve(here, ".env"))) process.loadEnvFile(resolve(here, ".env"));

const apiKey = process.env["INTERVALS_API_KEY"]?.trim();
if (!apiKey) {
  console.error("INTERVALS_API_KEY is not set. Copy examples/intervals-icu/.env.example to .env there and add your key.");
  process.exit(1);
}
const masterKey = process.env["CAIRNMCP_MASTER_KEY"] ? parseMasterKey(process.env["CAIRNMCP_MASTER_KEY"]) : randomBytes(32);

// 1. Ingest the API description.
const text = readFileSync(resolve(here, "../../packages/ingest/fixtures/intervals-icu/openapi.json"), "utf8");
const mapped = ingestOpenApiText(text, { sourceId: "intervals-icu" });
if (!mapped.ok) throw new Error("could not map the Intervals.icu spec");

// 2. Source-specific curation (the curation UI will store this per tenant):
//    Intervals.icu's basic-auth username is the literal "API_KEY", and athlete id "0"
//    means "the athlete this key belongs to". See docs/sources/intervals-icu.md.
const source: Source = {
  ...mapped.ir.source,
  authSchemes: mapped.ir.source.authSchemes.map((s) => (s.id === "APIKey" && s.type === "http_basic" ? { ...s, fixedUsername: "API_KEY" } : s)),
};
const resolved = resolveToolset(
  Toolset.parse({
    id: "example",
    sourceId: "intervals-icu",
    name: "Example",
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

// 4. Call it.
const runtime = new Runtime({ fetch: (url, init) => fetch(url, init), credentials: vault, limiter: new InMemoryRateLimiter(), audit: new InMemoryAuditSink() });
const oldest = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
console.log(`Calling list_activities since ${oldest} (read-only)…`);
const result = await runtime.invoke({ tenantId, source, tool, args: { oldest, limit: 10, fields: ["id", "start_date_local", "type", "moving_time"] } });
if (!result.ok) {
  console.error(`Failed: ${result.error.kind}: ${result.error.message}`);
  process.exit(1);
}

// The output is the API's, unchanged; this only prints a few fields of it.
const rows = Array.isArray(result.data) ? (result.data as Array<Record<string, unknown>>) : [];
console.log(`OK: HTTP ${result.status}, ${rows.length} items`);
for (const r of rows) console.log(`  ${String(r["start_date_local"] ?? "").slice(0, 10)}  ${String(r["type"] ?? "-").padEnd(14)} ${r["moving_time"] ?? "-"}`);
