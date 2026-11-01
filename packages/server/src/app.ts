import { createAuthHandler, SigningKeys, type IdentityProvider } from "@cairnmcp/auth";
import { PgAuditSink, PgVaultStore, type Database } from "@cairnmcp/db";
import { createMcpHandler, TokenVerifier, type TrustedIssuer } from "@cairnmcp/mcp";
import { InMemoryRateLimiter, Runtime, type FetchLike } from "@cairnmcp/runtime";
import { Vault, type KeyWrapper } from "@cairnmcp/vault";

export type AppOptions = {
  db: Database;
  keyWrapper: KeyWrapper;
  publicUrl: string;
  providers: IdentityProvider[];
  /** Issuers trusted besides the embedded one (their `sub` is looked up by issuer + subject). */
  trustedIssuers?: TrustedIssuer[];
  allowedOrigins?: string[];
  /** Upstream API access. Injected for tests. */
  fetch: FetchLike;
  now?: () => number;
};

/**
 * The whole app as one fetch-style handler: the embedded authorization server
 * (`/oauth/*` and its metadata) in front of the MCP endpoint. The MCP endpoint
 * trusts the embedded issuer with keys held in memory, plus any configured
 * external issuers.
 */
export async function createApp(options: AppOptions): Promise<(request: Request) => Promise<Response>> {
  const publicUrl = new URL(options.publicUrl).origin;
  const keys = await SigningKeys.load(options.db, options.keyWrapper);
  const embedded: TrustedIssuer = { issuer: publicUrl, jwksUri: `${publicUrl}/oauth/jwks`, subjectIsUserId: true };
  const verifier = new TokenVerifier([embedded, ...(options.trustedIssuers ?? [])], new Map([[publicUrl, keys.verifierKeys()]]));

  const vault = new Vault({ store: new PgVaultStore(options.db), keyWrapper: options.keyWrapper });
  const runtime = new Runtime({ fetch: options.fetch, credentials: vault, limiter: new InMemoryRateLimiter(), audit: new PgAuditSink(options.db) });

  const auth = createAuthHandler({ db: options.db, keys, providers: options.providers, publicUrl, ...(options.now ? { now: options.now } : {}) });
  const mcp = createMcpHandler({ db: options.db, verifier, runtime, publicUrl, ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}) });
  return async (request) => (await auth(request)) ?? mcp(request);
}
