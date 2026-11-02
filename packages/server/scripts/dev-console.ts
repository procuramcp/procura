// Try the curation console locally (D-033) without Auth0 or real data:
// a throwaway local Postgres database, a sign-in that approves you at once,
// and a stand-in for the Intervals.icu API. Dropped again on exit.
//
//   pnpm --filter @cairnmcp/web build      # or run `pnpm --filter @cairnmcp/web dev` alongside
//   CAIRNMCP_TEST_DATABASE_URL=postgres://$USER@localhost:5432/postgres \
//     pnpm --filter @cairnmcp/server dev:console
//
// Then open http://localhost:8787/app/. Never point this at a real database:
// it needs a local superuser URL and creates and drops its own database.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IdentityProvider } from "@cairnmcp/auth";
import { AccessProfile, Toolset, type TenantId } from "@cairnmcp/core";
import { addMember, Database, PgVaultStore, putProfile, putSource, putToolset, setMemberProfiles, setToolsetAccess, takeAllowance, updateMember } from "@cairnmcp/db";
import { intervalsIr, scratchDatabase } from "@cairnmcp/db/test-support";
import { LocalKeyWrapper, Vault } from "@cairnmcp/vault";
import { createApp, serve } from "../src/index.ts";

const adminUrl = process.env["CAIRNMCP_TEST_DATABASE_URL"];
if (!adminUrl || !/@(localhost|127\.0\.0\.1)[:/]/.test(adminUrl)) {
  console.error("Set CAIRNMCP_TEST_DATABASE_URL to a local Postgres superuser URL (localhost only).");
  process.exit(1);
}
const port = Number(process.env["PORT"] ?? 8787);
const publicUrl = `http://localhost:${port}`;
const ISSUER = "https://dev-sign-in.local";

/** Signs everyone in as one dev user, straight back to the callback. */
const devProvider: IdentityProvider = {
  id: "dev",
  name: "Dev sign-in",
  async authorizationUrl({ redirectUri, state }) {
    const url = new URL(redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code", "dev");
    return url;
  },
  async finish() {
    // DEV_USER=friend signs in as the viewer instead, to see the read-only console.
    const subject = process.env["DEV_USER"] ?? "dev-user";
    return { issuer: ISSUER, subject, label: `${subject === "dev-user" ? "dev" : subject}@localhost` };
  },
};

const scratch = await scratchDatabase(adminUrl);
const db = await Database.connect({ url: scratch.appUrl, max: 4 });
const keyWrapper = new LocalKeyWrapper(randomBytes(32));

// A tenant like the one set up with the admin CLI: Intervals.icu and the starter toolset.
const me = await db.ensureUser(ISSUER, "dev-user", "dev@localhost");
const friend = await db.ensureUser(ISSUER, "friend", "friend@localhost");
const tenant = await db.createTenant("Colter", me, { id: "colter" as TenantId });
const starter = JSON.parse(readFileSync(new URL("../../../examples/intervals-icu/toolset.json", import.meta.url), "utf8")) as object;
await db.withTenant(tenant, async (tx) => {
  await putSource(tx, intervalsIr());
  await putToolset(tx, Toolset.parse({ ...starter, id: "intervals", sourceId: "intervals-icu" }));
  await setToolsetAccess(tx, "intervals" as never, me, "use");
  await addMember(tx, friend, "viewer");
  await putProfile(
    tx,
    AccessProfile.parse({
      id: "athlete",
      name: "Athlete",
      rules: [{ toolsetId: "intervals", level: "use" }],
      limits: { requestsPerMinute: 30, perDay: 200, perMonth: 3000, upgradeUrl: "https://example.com/pricing" },
    }),
  );
});
// Customers to search and page through (D-038). One transaction each, so they get distinct join times.
for (let i = 1; i <= 60; i++) {
  const customer = await db.ensureUser(ISSUER, `customer-${i}`, `athlete${i}@example.com`);
  await db.withTenant(tenant, async (tx) => {
    await addMember(tx, customer, "customer");
    if (i % 2 === 0) await setMemberProfiles(tx, customer, ["athlete"]);
    if (i % 10 === 0) await updateMember(tx, customer, { status: "suspended", note: "Card declined" });
    // Some usage to show (D-039).
    for (let n = 0; n < (i % 7) * 3; n++) await takeAllowance(tx, customer, {}, new Date());
  });
}
await new Vault({ store: new PgVaultStore(db), keyWrapper }).putCredential({
  tenantId: tenant,
  sourceId: "intervals-icu",
  schemeId: "APIKey",
  credential: { kind: "basic", username: "API_KEY", password: "dev-not-a-real-key" },
});

const handler = await createApp({
  db,
  keyWrapper,
  publicUrl,
  providers: [devProvider],
  // A stand-in API: echoes what was called, so the test panel has something to show.
  fetch: async (url, init) =>
    new Response(JSON.stringify([{ note: "stand-in response from dev-console.ts", method: init.method, url }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  consoleDir: fileURLToPath(new URL("../../web/dist", import.meta.url)),
});
const server = serve(handler, { port, publicUrl });
console.log(`console at ${publicUrl}/app/ (database ${scratch.name}, dropped on exit)`);

const stop = () => server.close(() => void db.close().then(() => scratch.drop()).then(() => process.exit(0)));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
