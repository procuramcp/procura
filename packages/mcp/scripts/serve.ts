// Run the MCP endpoint. Settings come from the environment (see the root .env.example).
// Run: pnpm --filter @cairnmcp/mcp start
import { Database, PgAuditSink, PgVaultStore } from "@cairnmcp/db";
import { InMemoryRateLimiter, Runtime } from "@cairnmcp/runtime";
import { LocalKeyWrapper, parseMasterKey, Vault } from "@cairnmcp/vault";
import { createMcpHandler, loadConfig, serve, TokenVerifier } from "../src/index.ts";

let config;
try {
  config = loadConfig(process.env);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const db = await Database.connect({ url: config.databaseUrl });
const vault = new Vault({ store: new PgVaultStore(db), keyWrapper: new LocalKeyWrapper(parseMasterKey(config.masterKey)) });
const runtime = new Runtime({
  fetch: (url, init) => fetch(url, init),
  credentials: vault,
  limiter: new InMemoryRateLimiter(),
  audit: new PgAuditSink(db),
});
const handler = createMcpHandler({
  db,
  verifier: new TokenVerifier(config.trustedIssuers),
  runtime,
  publicUrl: config.publicUrl,
  allowedOrigins: config.allowedOrigins,
});

const server = serve(handler, { port: config.port, publicUrl: config.publicUrl });
console.log(`cairnmcp MCP endpoint listening on :${config.port} as ${config.publicUrl}`);

const shutdown = () => {
  server.close(() => void db.close().then(() => process.exit(0)));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
