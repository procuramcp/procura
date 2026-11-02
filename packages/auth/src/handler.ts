import { highestLevel } from "@cairnmcp/core";
import { getToolset, memberRole, schema, tenantName, toolsetAccessFor, type Database } from "@cairnmcp/db";
import {
  dispatch,
  json,
  randomToken as random,
  readCookie,
  readForm,
  readJson,
  redirect,
  safeEqual,
  setCookie,
  sha256Base64url,
  sha256Hex as sha256,
  withHeaders,
  type Route,
} from "@cairnmcp/http";
import { parseMcpResource } from "@cairnmcp/mcp";
import { and, eq, gt, isNull, lt, or, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { IdentityProvider } from "./identity.ts";
import type { SigningKeys } from "./keys.ts";
import { chooserPage, consentPage, errorPage, htmlResponse, noAccessPage } from "./pages.ts";
import { matchesRegistered, redirectUriProblem } from "./redirect.ts";

export type AuthServerOptions = {
  db: Database;
  keys: SigningKeys;
  /** Where people sign in (at least one). */
  providers: IdentityProvider[];
  /** Public base URL; also the issuer (`iss`) of every token. */
  publicUrl: string;
  /** Clock in milliseconds. Injected for tests. */
  now?: () => number;
  accessTokenSeconds?: number;
  refreshTokenSeconds?: number;
};

/** The one scope: "use the MCP endpoint this token is for". What a user may do there is decided per call (D-023). */
export const SCOPE = "mcp";
const REQUEST_SECONDS = 10 * 60;
const CODE_SECONDS = 60;
const COOKIE = "cairnmcp_auth";
const MAX_BODY_BYTES = 16 * 1024;

const { oauthClients: clients, oauthRequests: requests, oauthRefreshTokens: refreshTokens } = schema;
type RequestRow = typeof requests.$inferSelect;

/**
 * The embedded OAuth 2.1 authorization server (D-026). It authenticates people
 * by delegating to an OIDC provider, asks for consent, and issues short-lived
 * JWT access tokens bound to one MCP endpoint (RFC 8707) plus rotating
 * refresh tokens. Public clients only, PKCE (S256) required, clients register
 * dynamically (RFC 7591).
 *
 * Returns undefined for paths it doesn't own, so it can sit in front of the
 * MCP handler.
 */
export function createAuthHandler(options: AuthServerOptions): (request: Request) => Promise<Response | undefined> {
  const base = new URL(options.publicUrl).origin;
  const secureCookie = base.startsWith("https://");
  const nowMs = options.now ?? Date.now;
  const accessSeconds = options.accessTokenSeconds ?? 15 * 60;
  const refreshSeconds = options.refreshTokenSeconds ?? 30 * 24 * 60 * 60;
  const providers = new Map(options.providers.map((p) => [p.id, p]));
  const { db, keys } = options;
  if (providers.size === 0) throw new Error("the authorization server needs at least one identity provider");

  const at = (offsetSeconds = 0) => new Date(nowMs() + offsetSeconds * 1000);
  const callbackUri = (providerId: string) => `${base}/oauth/callback/${providerId}`;
  const cookie = (value: string, maxAgeSeconds: number) => setCookie(COOKIE, value, { path: "/oauth", maxAgeSeconds, secure: secureCookie });

  const metadata = {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    jwks_uri: `${base}/oauth/jwks`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };

  /** Send the browser back to the client with an OAuth error (only once the redirect URI is trusted). */
  const redirectWith = (redirectUri: string, params: Record<string, string | null | undefined>, extraHeaders: Record<string, string> = {}) => {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries({ ...params, iss: base })) if (v) url.searchParams.set(k, v);
    return redirect(url.toString(), extraHeaders);
  };

  async function loadRequest(where: ReturnType<typeof eq>): Promise<RequestRow | undefined> {
    const [row] = await db.withoutTenant((tx) => tx.select().from(requests).where(and(where, gt(requests.expiresAt, at()))));
    return row;
  }

  const expired = () => htmlResponse(400, errorPage("This sign-in has expired", "Start connecting again from your app."));

  // --- Endpoints ---------------------------------------------------------------

  async function register(request: Request): Promise<Response> {
    const body = await readJson(request, MAX_BODY_BYTES).catch(() => undefined);
    const parsed = RegistrationRequest.safeParse(body);
    if (!parsed.success) return oauthError(400, "invalid_client_metadata", "expected JSON with redirect_uris (1 to 10 URLs)");
    for (const uri of parsed.data.redirect_uris) {
      const problem = redirectUriProblem(uri);
      if (problem) return oauthError(400, "invalid_redirect_uri", `${uri} ${problem}`);
    }
    const id = `c_${random(24)}`;
    const name = parsed.data.client_name?.trim() || "Unnamed app";
    const issuedAt = at();
    await db.withoutTenant((tx) => tx.insert(clients).values({ id, name, redirectUris: parsed.data.redirect_uris, createdAt: issuedAt }));
    // Whatever auth method was asked for, these are public clients: no secret is issued (RFC 7591 lets us replace it).
    return json(201, {
      client_id: id,
      client_id_issued_at: Math.floor(issuedAt.getTime() / 1000),
      client_name: name,
      redirect_uris: parsed.data.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  }

  async function authorize(url: URL): Promise<Response> {
    const q = url.searchParams;
    const clientId = q.get("client_id") ?? "";
    const [client] = clientId ? await db.withoutTenant((tx) => tx.select().from(clients).where(eq(clients.id, clientId))) : [];
    // Until the client and redirect URI check out, errors are shown here, never redirected (no open redirect).
    if (!client) return htmlResponse(400, errorPage("Unknown app", "This app isn't registered with cairnmcp. Try connecting again from the app."));
    const redirectUri = q.get("redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : "");
    if (!redirectUri || !matchesRegistered(redirectUri, client.redirectUris)) {
      return htmlResponse(400, errorPage("Can't continue", "The app asked to return to an address it didn't register."));
    }
    const state = q.get("state");
    const fail = (error: string, description: string) => redirectWith(redirectUri, { error, error_description: description, state });

    if (state !== null && state.length > 1024) return fail("invalid_request", "state is too long");
    if (q.get("response_type") !== "code") return fail("unsupported_response_type", "only response_type=code is supported");
    const challenge = q.get("code_challenge") ?? "";
    if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return fail("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256");
    }
    const resources = q.getAll("resource");
    const target = resources.length === 1 ? parseMcpResource(base, resources[0]!) : undefined;
    if (!target) return fail("invalid_target", "resource must be exactly one cairnmcp MCP endpoint URL");

    const id = random(24);
    await db.withoutTenant((tx) =>
      tx.insert(requests).values({
        id,
        clientId: client.id,
        redirectUri,
        codeChallenge: challenge,
        state,
        resource: target.resource,
        scope: SCOPE,
        expiresAt: at(REQUEST_SECONDS),
        createdAt: at(),
      }),
    );
    const loginHref = (p: IdentityProvider) => `/oauth/login/${p.id}?request=${id}`;
    if (providers.size === 1) {
      const [only] = providers.values();
      return redirect(`${base}${loginHref(only!)}`);
    }
    return htmlResponse(200, chooserPage({ clientName: client.name, providers: [...providers.values()].map((p) => ({ name: p.name, href: loginHref(p) })) }));
  }

  async function login(url: URL, providerId: string): Promise<Response> {
    const provider = providers.get(providerId);
    const row = await loadRequest(eq(requests.id, url.searchParams.get("request") ?? ""));
    if (!provider || !row || row.userId !== null || row.codeHash !== null) return expired();
    const browserSecret = random(32);
    const upstreamState = random(32);
    const nonce = random(32);
    const verifier = random(32);
    await db.withoutTenant((tx) =>
      tx
        .update(requests)
        .set({ browserHash: sha256(browserSecret), provider: provider.id, upstreamStateHash: sha256(upstreamState), upstreamNonce: nonce, upstreamVerifier: verifier })
        .where(eq(requests.id, row.id)),
    );
    const location = await provider.authorizationUrl({ redirectUri: callbackUri(provider.id), state: upstreamState, nonce, codeVerifier: verifier });
    return redirect(location.toString(), { "set-cookie": cookie(browserSecret, REQUEST_SECONDS) });
  }

  async function callback(request: Request, url: URL, providerId: string): Promise<Response> {
    const provider = providers.get(providerId);
    const state = url.searchParams.get("state") ?? "";
    const row = provider && state ? await loadRequest(eq(requests.upstreamStateHash, sha256(state))) : undefined;
    if (!provider || !row || row.provider !== provider.id || row.userId !== null) return expired();
    if (!sameBrowser(request, row)) {
      return htmlResponse(400, errorPage("Can't continue", "Sign-in has to finish in the same browser it started in. Start again from your app."));
    }
    // The upstream state is single-use.
    await db.withoutTenant((tx) => tx.update(requests).set({ upstreamStateHash: null }).where(eq(requests.id, row.id)));
    if (url.searchParams.has("error")) return redirectWith(row.redirectUri, { error: "access_denied", error_description: "sign-in was cancelled", state: row.state });

    let identity;
    try {
      identity = await provider.finish({
        callbackUrl: url,
        redirectUri: callbackUri(provider.id),
        expectedState: state,
        expectedNonce: row.upstreamNonce ?? "",
        codeVerifier: row.upstreamVerifier ?? "",
      });
    } catch {
      return htmlResponse(502, errorPage("Sign-in failed", `${provider.name} didn't confirm the sign-in. Start again from your app.`));
    }
    const userId = await db.ensureUser(identity.issuer, identity.subject);
    const target = parseMcpResource(base, row.resource)!;
    const access = await db.withTenant(target.tenantId, async (tx) => {
      if (!(await memberRole(tx, userId))) return undefined;
      const level = highestLevel(await toolsetAccessFor(tx, target.toolsetId, userId));
      const toolset = level && (await getToolset(tx, target.toolsetId));
      const tenant = await tenantName(tx);
      return level && toolset && tenant ? { level, toolsetName: toolset.name, tenantName: tenant } : undefined;
    });
    if (!access) {
      return htmlResponse(403, noAccessPage({ userLabel: identity.label, userId }));
    }
    await db.withoutTenant((tx) => tx.update(requests).set({ userId, userLabel: identity.label }).where(eq(requests.id, row.id)));
    const [client] = await db.withoutTenant((tx) => tx.select({ name: clients.name }).from(clients).where(eq(clients.id, row.clientId)));
    return htmlResponse(
      200,
      consentPage({
        requestId: row.id,
        clientName: client?.name ?? "An app",
        redirectTarget: describeRedirect(row.redirectUri),
        userLabel: identity.label,
        tenantName: access.tenantName,
        toolsetName: access.toolsetName,
        canWrite: access.level === "use_writes",
      }),
    );
  }

  async function consent(request: Request): Promise<Response> {
    // A cross-site form post is refused even before the cookie check.
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== base) return htmlResponse(403, errorPage("Can't continue", "This form was sent from another site."));
    const form = await readForm(request, MAX_BODY_BYTES).catch(() => undefined);
    const row = form ? await loadRequest(eq(requests.id, form.get("request") ?? "")) : undefined;
    if (!form || !row || row.userId === null || row.codeHash !== null) return expired();
    if (!sameBrowser(request, row)) return htmlResponse(400, errorPage("Can't continue", "Sign-in has to finish in the same browser it started in."));
    const clearCookie = { "set-cookie": cookie("", 0) };

    if (form.get("decision") !== "allow") {
      await db.withoutTenant((tx) => tx.update(requests).set({ expiresAt: at() }).where(eq(requests.id, row.id)));
      return redirectWith(row.redirectUri, { error: "access_denied", error_description: "access was denied", state: row.state }, clearCookie);
    }
    const code = random(32);
    await db.withoutTenant((tx) => tx.update(requests).set({ codeHash: sha256(code), codeExpiresAt: at(CODE_SECONDS) }).where(eq(requests.id, row.id)));
    return redirectWith(row.redirectUri, { code, state: row.state }, clearCookie);
  }

  async function token(request: Request): Promise<Response> {
    const form = await readForm(request, MAX_BODY_BYTES).catch(() => undefined);
    if (!form) return oauthError(400, "invalid_request", "send application/x-www-form-urlencoded parameters");
    const clientId = form.get("client_id") ?? "";
    const resource = form.get("resource");
    switch (form.get("grant_type")) {
      case "authorization_code":
        return exchangeCode(form, clientId, resource);
      case "refresh_token":
        return refresh(form, clientId, resource);
      default:
        return oauthError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    }
  }

  async function exchangeCode(form: URLSearchParams, clientId: string, resource: string | null): Promise<Response> {
    const codeHash = sha256(form.get("code") ?? "");
    // Spend the code atomically: of two concurrent exchanges, only one gets the row.
    const [row] = await db.withoutTenant((tx) =>
      tx.update(requests).set({ codeUsedAt: at() }).where(and(eq(requests.codeHash, codeHash), isNull(requests.codeUsedAt))).returning(),
    );
    if (!row) {
      // A replayed code means it leaked: revoke everything issued from it (RFC 9700 §4.5).
      const [spent] = await db.withoutTenant((tx) => tx.select({ id: requests.id }).from(requests).where(and(eq(requests.codeHash, codeHash), isNotNull(requests.codeUsedAt))));
      if (spent) await revokeFamily(spent.id);
      return oauthError(400, "invalid_grant", "the authorization code is invalid or was already used");
    }
    const verifier = form.get("code_verifier") ?? "";
    const ok =
      row.clientId === clientId &&
      row.userId !== null &&
      row.codeExpiresAt !== null &&
      row.codeExpiresAt > at() &&
      form.get("redirect_uri") === row.redirectUri &&
      /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) &&
      sha256Base64url(verifier) === row.codeChallenge &&
      (resource === null || resource === row.resource);
    if (!ok) return oauthError(400, "invalid_grant", "the code doesn't match this client, redirect URI, code verifier, or resource, or it expired");
    return issueTokens({ userId: row.userId!, clientId, resource: row.resource, scope: row.scope, familyId: row.id });
  }

  async function refresh(form: URLSearchParams, clientId: string, resource: string | null): Promise<Response> {
    const tokenHash = sha256(form.get("refresh_token") ?? "");
    const [row] = await db.withoutTenant((tx) =>
      tx
        .update(refreshTokens)
        .set({ usedAt: at() })
        .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.usedAt), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, at())))
        .returning(),
    );
    if (!row) {
      // Reusing a rotated token means two parties hold it: end the whole family.
      const [spent] = await db.withoutTenant((tx) =>
        tx.select({ familyId: refreshTokens.familyId }).from(refreshTokens).where(and(eq(refreshTokens.tokenHash, tokenHash), isNotNull(refreshTokens.usedAt))),
      );
      if (spent) await revokeFamily(spent.familyId);
      return oauthError(400, "invalid_grant", "the refresh token is invalid, expired, or was already used");
    }
    if (row.clientId !== clientId || (resource !== null && resource !== row.resource)) {
      return oauthError(400, "invalid_grant", "the refresh token doesn't belong to this client or resource");
    }
    return issueTokens({ userId: row.userId, clientId, resource: row.resource, scope: row.scope, familyId: row.familyId });
  }

  async function issueTokens(input: { userId: string; clientId: string; resource: string; scope: string; familyId: string }): Promise<Response> {
    const accessToken = await keys.signAccessToken({
      issuer: base,
      subject: input.userId,
      audience: input.resource,
      clientId: input.clientId,
      scope: input.scope,
      jti: random(16),
      nowSeconds: Math.floor(nowMs() / 1000),
      lifetimeSeconds: accessSeconds,
    });
    const refreshToken = random(32);
    await db.withoutTenant((tx) =>
      tx.insert(refreshTokens).values({
        tokenHash: sha256(refreshToken),
        familyId: input.familyId,
        clientId: input.clientId,
        userId: input.userId,
        resource: input.resource,
        scope: input.scope,
        expiresAt: at(refreshSeconds),
        createdAt: at(),
      }),
    );
    return json(200, { access_token: accessToken, token_type: "Bearer", expires_in: accessSeconds, refresh_token: refreshToken, scope: input.scope });
  }

  async function revokeFamily(familyId: string): Promise<void> {
    await db.withoutTenant((tx) => tx.update(refreshTokens).set({ revokedAt: at() }).where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt))));
  }

  function sameBrowser(request: Request, row: RequestRow): boolean {
    const secret = readCookie(request, COOKIE);
    return secret !== undefined && row.browserHash !== null && safeEqual(sha256(secret), row.browserHash);
  }

  // --- Routing -------------------------------------------------------------------

  type Ctx = { request: Request; url: URL };
  const cached = { "cache-control": "max-age=300" };
  // Token, registration, and metadata endpoints use no cookies, so any origin may call them (browser-based MCP clients).
  const cors = (handle: Route<Ctx>["handle"]): Route<Ctx>["handle"] => async (c, p) => withHeaders(await handle(c, p), CORS);
  const preflight = async () => new Response(null, { status: 204 });
  const routes: Route<Ctx>[] = [
    { method: "OPTIONS", path: /^\/(?:\.well-known\/oauth-authorization-server|oauth\/(?:jwks|token|register))$/, handle: cors(preflight) },
    { method: "GET", path: /^\/\.well-known\/oauth-authorization-server$/, handle: cors(async () => json(200, metadata, cached)) },
    { method: "GET", path: /^\/oauth\/jwks$/, handle: cors(async () => json(200, keys.jwks(), cached)) },
    { method: "POST", path: /^\/oauth\/register$/, handle: cors(({ request }) => register(request)) },
    { method: "POST", path: /^\/oauth\/token$/, handle: cors(({ request }) => token(request)) },
    { method: "GET", path: /^\/oauth\/authorize$/, handle: ({ url }) => authorize(url) },
    { method: "POST", path: /^\/oauth\/consent$/, handle: ({ request }) => consent(request) },
    { method: "GET", path: /^\/oauth\/login\/([a-z0-9-]+)$/, handle: ({ url }, [provider]) => login(url, provider!) },
    { method: "GET", path: /^\/oauth\/callback\/([a-z0-9-]+)$/, handle: ({ request, url }, [provider]) => callback(request, url, provider!) },
  ];

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const handled = dispatch(routes, { request, url }, request.method, path);
    if (handled) return handled;
    if (path.startsWith("/oauth/") || path === "/.well-known/oauth-authorization-server") return json(404, { error: "not_found" });
    return undefined;
  };
}

/** Delete finished and expired sign-in flows and refresh tokens. Safe to run on any schedule. */
export async function purgeExpiredAuthState(db: Database, now = new Date()): Promise<void> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  await db.withoutTenant(async (tx) => {
    await tx.delete(requests).where(lt(requests.expiresAt, dayAgo));
    await tx.delete(refreshTokens).where(or(lt(refreshTokens.expiresAt, now), lt(refreshTokens.revokedAt, dayAgo), lt(refreshTokens.usedAt, dayAgo)));
  });
}

const RegistrationRequest = z.looseObject({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().max(200).optional(),
});

function describeRedirect(uri: string): string {
  const url = new URL(uri);
  return url.protocol === "http:" || url.protocol === "https:" ? url.host : `${url.protocol}//${url.host}`;
}

function oauthError(status: number, error: string, description: string): Response {
  return json(status, { error, error_description: description });
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
};
