// Run procura: the authorization server and the MCP endpoint. Settings come
// from the environment (see the root .env.example). Run: pnpm --filter @procura/server start
import { OidcIdentityProvider, purgeExpiredAuthState } from "@procura/auth";
import { acceptLegacyEnvNames, Database } from "@procura/db";
import { LocalKeyWrapper, parseMasterKey } from "@procura/vault";
import { fileURLToPath } from "node:url";
import { createApp, loadConfig, purgeExpiredConsoleState, serve } from "../src/index.ts";
import { safeGet } from "../src/fetch-document.ts";
import { checkSourcesForUpdates } from "../src/source-check.ts";

acceptLegacyEnvNames();

let config;
try {
  config = loadConfig(process.env);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

// Connecting also checks the role can't bypass row-level security (D-024).
// pg's messages name the host or role, never the password.
const db = await Database.connect({ url: config.databaseUrl }).catch((e: unknown) => {
  console.error(`can't use PROCURA_DATABASE_URL: ${(e as Error).message}`);
  process.exit(1);
});
const handler = await createApp({
  db,
  keyWrapper: new LocalKeyWrapper(parseMasterKey(config.masterKey)),
  publicUrl: config.publicUrl,
  providers: config.oidcProviders.map((p) => new OidcIdentityProvider(p)),
  trustedIssuers: config.trustedIssuers,
  allowedOrigins: config.allowedOrigins,
  fetch: (url, init) => fetch(url, init),
  consoleDir: fileURLToPath(new URL("../../web/dist", import.meta.url)),
});

const server = serve(handler, { port: config.port, publicUrl: config.publicUrl });
console.log(`procura listening on :${config.port} as ${config.publicUrl}`);

// Expired sign-in flows, refresh tokens, and console sessions are cleaned up hourly.
const purge = setInterval(() => void Promise.all([purgeExpiredAuthState(db), purgeExpiredConsoleState(db)]).catch((e: unknown) => console.error("purge failed:", (e as Error).message)), 60 * 60 * 1000);
purge.unref();

// New versions of each source's document (D-049): every hour, check the ones that are due.
// One run at a time; a run checks at most 50, so a big backlog spreads over hours.
let checking = false;
const checkSources = () => {
  if (checking || config.sourceCheckHours === 0) return;
  checking = true;
  void checkSourcesForUpdates(db, { getDocument: safeGet, olderThanHours: config.sourceCheckHours, max: 50, now: () => new Date() })
    .then((r) => r.checked > 0 && console.log(`source checks: ${r.checked} checked, ${r.changed} with a new version, ${r.failed} failed`))
    .catch((e: unknown) => console.error("source checks failed:", (e as Error).message))
    .finally(() => (checking = false));
};
const sourceChecks = setInterval(checkSources, 60 * 60 * 1000);
sourceChecks.unref();
setTimeout(checkSources, 2 * 60 * 1000).unref();

const shutdown = () => {
  clearInterval(purge);
  clearInterval(sourceChecks);
  server.close(() => void db.close().then(() => process.exit(0)));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
