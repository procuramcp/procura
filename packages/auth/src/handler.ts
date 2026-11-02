import { highestLevel, profilesForClaims, SIGN_IN_SECRET_CONTEXT, TenantId, upstreamGrantContext, UserId, type SignInConfig } from "@cairnmcp/core";
import {
  deleteUpstreamGrant,
  ensureMember,
  getSignIn,
  getToolset,
  getUpstreamGrant,
  getUserIdentity,
  listProfiles,
  memberRole,
  putUpstreamGrant,
  schema,
  syncSignInProfiles,
  tenantName,
  toolsetAccessFor,
  type Database,
} from "@cairnmcp/db";
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
import type { Vault } from "@cairnmcp/vault";
import type * as oidc from "openid-client";
import { finishSignIn, startSignIn, tenantIdentityProvider, type IdentityProvider } from "./identity.ts";
import type { SigningKeys } from "./keys.ts";
import { chooserPage, consentPage, errorPage, htmlResponse, noAccessPage } from "./pages.ts";
import { matchesRegistered, redirectUriProblem } from "./redirect.ts";

export type AuthServerOptions = {
  db: Database;
  keys: SigningKeys;
  /** Where people sign in (at least one). */
  providers: IdentityProvider[];
  /**
   * For tenants with their own sign-in (D-040): the vault that holds their
   * client secrets and customers' upstream refresh tokens, and the fetch used
   * for their provider's URLs, which a tenant admin typed in and so must
   * never reach a private address. Without both, only `providers` are used.
   */
  tenantSignIn?: { vault: Vault; fetch: oidc.CustomFetch };
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

  // --- A tenant's own sign-in (D-040) --------------------------------------------

  type TenantSignIn = { key: string; tenantId: TenantId; provider: IdentityProvider; config: SignInConfig; callback: string };
  // Built providers, so OIDC discovery runs once per settings version, not per sign-in.
  const built = new Map<string, { version: string; signIn: TenantSignIn }>();

  /** The tenant's own sign-in, if it has one with a client secret set. */
  async function tenantSignIn(tenantId: TenantId): Promise<TenantSignIn | undefined> {
    const own = options.tenantSignIn;
    if (!own) return undefined;
    const stored = await db.withTenant(tenantId, (tx) => getSignIn(tx));
    if (!stored?.secret) return undefined;
    const cached = built.get(tenantId);
    if (cached?.version === stored.updatedAt) return cached.signIn;
    const secret = await own.vault.openSecret(tenantId, SIGN_IN_SECRET_CONTEXT, stored.secret);
    const key = `tenant:${tenantId}`;
    const signIn = {
      key,
      tenantId,
      provider: tenantIdentityProvider(key, stored.config, secret.reveal(), own.fetch),
      config: stored.config,
      callback: tenantCallbackUrl(base, tenantId),
    };
    built.set(tenantId, { version: stored.updatedAt, signIn });
    return signIn;
  }

  /** Who signs this request in: a configured provider, or the tenant's own for its own MCP URLs only. */
  async function signInFor(ref: { provider: string } | { tenant: string }, row: RequestRow): Promise<{ key: string; provider: IdentityProvider; callback: string; tenant?: TenantSignIn } | undefined> {
    if ("provider" in ref) {
      const provider = providers.get(ref.provider);
      return provider && { key: provider.id, provider, callback: callbackUri(provider.id) };
    }
    const tenantId = TenantId.safeParse(ref.tenant).data;
    // A tenant's login can't be used to reach another tenant's endpoint.
    if (!tenantId || parseMcpResource(base, row.resource)?.tenantId !== tenantId) return undefined;
    const tenant = await tenantSignIn(tenantId);
    return tenant && { key: tenant.key, provider: tenant.provider, callback: tenant.callback, tenant };
  }

  /**
   * After a customer signs in with the tenant's provider: make them a customer
   * if they're new, set their profiles from their claims, and keep the
   * provider's refresh token for this token family so later refreshes can read
   * their claims again.
   */
  async function welcome(tenant: TenantSignIn, userId: string, claims: Record<string, unknown>, refreshToken: string | undefined, familyId: string): Promise<void> {
    const user = UserId.parse(userId);
    const sealed = refreshToken ? await options.tenantSignIn!.vault.sealSecret(tenant.tenantId, upstreamGrantContext(familyId), refreshToken) : undefined;
    await db.withTenant(tenant.tenantId, async (tx) => {
      // Someone already here keeps their role and status: signing in never lifts a suspension.
      await ensureMember(tx, user);
      await syncSignInProfiles(tx, user, profilesForClaims(await listProfiles(tx), claims, tenant.config.defaultProfileId));
      if (sealed) await putUpstreamGrant(tx, { familyId, userId: user, sealed, expiresAt: at(refreshSeconds + REQUEST_SECONDS) });
    });
  }

  /**
   * On refresh of a family that signed in with a tenant's provider: ask the
   * provider again and re-sync the person's profiles, so a lapsed plan ends
   * within one access token's life (D-032). "ended" if the provider refuses,
   * the sign-in was removed, or the provider now names someone else.
   */
  async function recheck(familyId: string, userId: string, resource: string): Promise<"ok" | "ended"> {
    const target = parseMcpResource(base, resource);
    const own = options.tenantSignIn;
    if (!target || !own) return "ok";
    const grant = await db.withTenant(target.tenantId, (tx) => getUpstreamGrant(tx, familyId));
    if (!grant) return "ok";
    const user = grant.userId;
    try {
      const tenant = await tenantSignIn(target.tenantId);
      if (!tenant?.provider.refresh || user !== userId) throw new Error("no sign-in to ask");
      const token = await own.vault.openSecret(target.tenantId, upstreamGrantContext(familyId), grant.sealed);
      const now = await tenant.provider.refresh(token.reveal());
      const identity = await db.withTenant(target.tenantId, (tx) => getUserIdentity(tx, user));
      if (identity?.subject !== now.subject) throw new Error("the provider named someone else");
      const sealed = now.refreshToken ? await own.vault.sealSecret(target.tenantId, upstreamGrantContext(familyId), now.refreshToken) : grant.sealed;
      await db.withTenant(target.tenantId, async (tx) => {
        await syncSignInProfiles(tx, user, profilesForClaims(await listProfiles(tx), now.claims, tenant.config.defaultProfileId));
        await putUpstreamGrant(tx, { familyId, userId: user, sealed, expiresAt: at(refreshSeconds) });
      });
      return "ok";
    } catch {
      await db.withTenant(target.tenantId, (tx) => deleteUpstreamGrant(tx, familyId));
      return "ended";
    }
  }

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
    // A tenant with its own sign-in sends its customers straight there (D-040).
    if (await tenantSignIn(target.tenantId)) return redirect(`${base}/oauth/login/tenant/${target.tenantId}?request=${id}`);
    const loginHref = (p: IdentityProvider) => `/oauth/login/${p.id}?request=${id}`;
    if (providers.size === 1) {
      const [only] = providers.values();
      return redirect(`${base}${loginHref(only!)}`);
    }
    return htmlResponse(200, chooserPage({ clientName: client.name, providers: [...providers.values()].map((p) => ({ name: p.name, href: loginHref(p) })) }));
  }

  async function login(url: URL, ref: { provider: string } | { tenant: string }): Promise<Response> {
    const row = await loadRequest(eq(requests.id, url.searchParams.get("request") ?? ""));
    if (!row || row.userId !== null || row.codeHash !== null) return expired();
    const signIn = await signInFor(ref, row);
    if (!signIn) return expired();
    const { location, secrets } = await startSignIn(signIn.provider, signIn.callback);
    await db.withoutTenant((tx) =>
      tx
        .update(requests)
        .set({ browserHash: sha256(secrets.browser), provider: signIn.key, upstreamStateHash: sha256(secrets.state), upstreamNonce: secrets.nonce, upstreamVerifier: secrets.verifier })
        .where(eq(requests.id, row.id)),
    );
    return redirect(location.toString(), { "set-cookie": cookie(secrets.browser, REQUEST_SECONDS) });
  }

  async function callback(request: Request, url: URL, ref: { provider: string } | { tenant: string }): Promise<Response> {
    const state = url.searchParams.get("state") ?? "";
    const row = state ? await loadRequest(eq(requests.upstreamStateHash, sha256(state))) : undefined;
    const signIn = row && (await signInFor(ref, row));
    if (!row || !signIn || row.provider !== signIn.key || row.userId !== null) return expired();
    const { provider } = signIn;
    if (!sameBrowser(request, row)) {
      return htmlResponse(400, errorPage("Can't continue", "Sign-in has to finish in the same browser it started in. Start again from your app."));
    }
    // The upstream state is single-use.
    await db.withoutTenant((tx) => tx.update(requests).set({ upstreamStateHash: null }).where(eq(requests.id, row.id)));
    if (url.searchParams.has("error")) return redirectWith(row.redirectUri, { error: "access_denied", error_description: "sign-in was cancelled", state: row.state });

    const identity = await finishSignIn(provider, { callbackUrl: url, redirectUri: signIn.callback, state, nonce: row.upstreamNonce ?? "", verifier: row.upstreamVerifier ?? "" });
    if (!identity) return htmlResponse(502, errorPage("Sign-in failed", `${provider.name} didn't confirm the sign-in. Start again from your app.`));
    const userId = await db.ensureUser(identity.issuer, identity.subject, identity.label);
    // The request's own id becomes the token family id (exchangeCode), so the grant is stored under it now.
    if (signIn.tenant) await welcome(signIn.tenant, userId, identity.claims, identity.refreshToken, row.id);
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
    if ((await recheck(row.familyId, row.userId, row.resource)) === "ended") {
      await revokeFamily(row.familyId);
      return oauthError(400, "invalid_grant", "your sign-in at the provider has ended; connect again");
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
    { method: "GET", path: /^\/oauth\/login\/tenant\/([A-Za-z0-9_-]+)$/, handle: ({ url }, [tenant]) => login(url, { tenant: tenant! }) },
    { method: "GET", path: /^\/oauth\/callback\/tenant\/([A-Za-z0-9_-]+)$/, handle: ({ request, url }, [tenant]) => callback(request, url, { tenant: tenant! }) },
    { method: "GET", path: /^\/oauth\/login\/([a-z0-9-]+)$/, handle: ({ url }, [provider]) => login(url, { provider: provider! }) },
    { method: "GET", path: /^\/oauth\/callback\/([a-z0-9-]+)$/, handle: ({ request, url }, [provider]) => callback(request, url, { provider: provider! }) },
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

/** Delete finished and expired sign-in flows, refresh tokens, and upstream grants. Safe to run on any schedule. */
export async function purgeExpiredAuthState(db: Database, now = new Date()): Promise<void> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  await db.withoutTenant(async (tx) => {
    await tx.delete(requests).where(lt(requests.expiresAt, dayAgo));
    await tx.delete(refreshTokens).where(or(lt(refreshTokens.expiresAt, now), lt(refreshTokens.revokedAt, dayAgo), lt(refreshTokens.usedAt, dayAgo)));
  });
  await db.purgeUpstreamGrants();
}

/** Where a tenant's provider sends customers back (D-040): register this redirect URI with the provider. */
export function tenantCallbackUrl(publicUrl: string, tenantId: string): string {
  return `${new URL(publicUrl).origin}/oauth/callback/tenant/${tenantId}`;
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
