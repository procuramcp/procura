// Run cairnmcp: the authorization server and the MCP endpoint. Settings come
// from the environment (see the root .env.example). Run: pnpm --filter @cairnmcp/server start
import { OidcIdentityProvider, purgeExpiredAuthState } from "@cairnmcp/auth";
import { Database } from "@cairnmcp/db";
import { LocalKeyWrapper, parseMasterKey } from "@cairnmcp/vault";
import { fileURLToPath } from "node:url";
import { createApp, loadConfig, purgeExpiredConsoleState, serve } from "../src/index.ts";

let config;
try {
  config = loadConfig(process.env);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const db = await Database.connect({ url: config.databaseUrl });
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
console.log(`cairnmcp listening on :${config.port} as ${config.publicUrl}`);

// Expired sign-in flows, refresh tokens, and console sessions are cleaned up hourly.
const purge = setInterval(() => void Promise.all([purgeExpiredAuthState(db), purgeExpiredConsoleState(db)]).catch((e: unknown) => console.error("purge failed:", (e as Error).message)), 60 * 60 * 1000);
purge.unref();

const shutdown = () => {
  clearInterval(purge);
  server.close(() => void db.close().then(() => process.exit(0)));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
