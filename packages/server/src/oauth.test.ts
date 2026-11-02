// The embedded authorization server end to end, through the whole app:
// registration, authorize, sign-in at a (fake, in-memory) OIDC provider via
// the real openid-client, consent, tokens, refresh, and MCP calls with the
// result. Real Postgres as the app role. Last: the MCP SDK's own OAuth client.
import { randomBytes } from "node:crypto";
import { OidcIdentityProvider } from "@cairnmcp/auth";
import { Toolset, type TenantId, type UserId } from "@cairnmcp/core";
import { addMember, Database, listAuditEvents, putSource, putToolset, schema, setToolsetAccess } from "@cairnmcp/db";
import { intervalsIr, scratchDatabase, testDatabaseUrl, type ScratchDatabase } from "@cairnmcp/db/test-support";
import type { FetchLike } from "@cairnmcp/runtime";
import { LocalKeyWrapper } from "@cairnmcp/vault";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { FakeOidcProvider, pkce, TestBrowser } from "./test-support.ts";

const adminUrl = testDatabaseUrl();
const BASE = "https://cairn.test";
const REDIRECT = "http://localhost:4567/callback";

describe.skipIf(!adminUrl)("embedded authorization server (Postgres)", () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let op: FakeOidcProvider;
  let app: (request: Request) => Promise<Response>;
  let clock: number;
  let alice: UserId; // tenant A owner, use_writes
  let carol: UserId; // tenant A member, no toolset access
  let a: TenantId;
  let b: TenantId;
  let upstreamCalls: number;

  const resource = (tenantId: string, toolsetId = "mine") => `${BASE}/mcp/${tenantId}/${toolsetId}`;
  const ALICE = { sub: "alice", email: "alice@example.com" };

  beforeAll(async () => {
    scratch = await scratchDatabase(adminUrl!);
    db = await Database.connect({ url: scratch.appUrl, max: 4 });
    op = await FakeOidcProvider.create();

    // People sign in at the provider, so their users are keyed by its issuer and subject.
    alice = await db.ensureUser(op.issuer, "alice");
    carol = await db.ensureUser(op.issuer, "carol");
    const bob = await db.ensureUser(op.issuer, "bob");
    a = await db.createTenant("Alpha", alice);
    b = await db.createTenant("Bravo", bob);
    const toolset = Toolset.parse({
      id: "mine",
      sourceId: "intervals-icu",
      name: "My training",
      tools: [{ operationId: "list_activities", name: "list_activities", description: "List my activities.", pinnedInputs: { id: "0" } }],
    });
    for (const [tenantId, owner] of [[a, alice], [b, bob]] as const) {
      await db.withTenant(tenantId, async (tx) => {
        await putSource(tx, intervalsIr());
        await putToolset(tx, toolset);
        await setToolsetAccess(tx, toolset.id, owner, "use_writes");
      });
    }
    await db.withTenant(a, (tx) => addMember(tx, carol, "member"));

    const fetch: FetchLike = async () => (upstreamCalls++, new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    app = await createApp({
      db,
      keyWrapper: new LocalKeyWrapper(randomBytes(32)),
      publicUrl: BASE,
      providers: [new OidcIdentityProvider({ id: "idp", name: "Test IdP", issuer: op.issuer, clientId: op.clientId, clientSecret: op.clientSecret }, { fetch: op.fetch })],
      fetch,
      now: () => clock,
    });
  });

  beforeEach(() => {
    clock = Date.now();
    upstreamCalls = 0;
    op.wrongNonce = false;
  });

  afterAll(async () => {
    await db?.close();
    await scratch?.drop();
  });

  // --- Helpers ---------------------------------------------------------------

  async function register(body: Record<string, unknown> = { redirect_uris: [REDIRECT], client_name: "Test Client" }) {
    return app(new Request(`${BASE}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }

  async function newClient(): Promise<string> {
    return ((await (await register()).json()) as { client_id: string }).client_id;
  }

  function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}): string {
    const url = new URL(`${BASE}/oauth/authorize`);
    const params = { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "client-state", resource: resource(a), ...extra };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  /** Authorize and sign in at the provider; returns the consent page response. */
  async function untilConsent(browser: TestBrowser, url: string, user = ALICE): Promise<Response> {
    const toLogin = await browser.get(url);
    expect(toLogin.status).toBe(302);
    const toProvider = await browser.get(toLogin.headers.get("location")!);
    expect(toProvider.status).toBe(302);
    return browser.get(op.approve(toProvider.headers.get("location")!, user));
  }

  async function allow(browser: TestBrowser, consentPage: Response): Promise<URL> {
    // Under no-referrer, real browsers post the form with `Origin: null`, which the check refuses.
    expect(consentPage.headers.get("referrer-policy")).toBe("same-origin");
    const html = await consentPage.text();
    const requestId = /name="request" value="([^"]+)"/.exec(html)![1]!;
    const response = await browser.postForm(`${BASE}/oauth/consent`, { request: requestId, decision: "allow" }, { origin: BASE });
    expect(response.status).toBe(302);
    return new URL(response.headers.get("location")!);
  }

  /** The whole browser part of the flow; returns the code. */
  async function getCode(clientId: string, challenge: string, user = ALICE): Promise<string> {
    const browser = new TestBrowser(app);
    const consent = await untilConsent(browser, authorizeUrl(clientId, challenge), user);
    expect(consent.status).toBe(200);
    return (await allow(browser, consent)).searchParams.get("code")!;
  }

  const tokenRequest = (form: Record<string, string>) =>
    app(new Request(`${BASE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }));

  const exchange = (clientId: string, code: string, verifier: string, extra: Record<string, string> = {}) =>
    tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT, ...extra });

  type Tokens = { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string };

  async function signInFully(): Promise<{ clientId: string; tokens: Tokens }> {
    const clientId = await newClient();
    const { verifier, challenge } = pkce();
    const response = await exchange(clientId, await getCode(clientId, challenge), verifier);
    expect(response.status).toBe(200);
    return { clientId, tokens: (await response.json()) as Tokens };
  }

  const mcpList = (token: string, endpoint = resource(a)) =>
    app(
      new Request(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

  // --- Tests -----------------------------------------------------------------

  describe("discovery", () => {
    it("publishes authorization server metadata (RFC 8414)", async () => {
      const metadata = await (await app(new Request(`${BASE}/.well-known/oauth-authorization-server`))).json();
      expect(metadata).toMatchObject({
        issuer: BASE,
        authorization_endpoint: `${BASE}/oauth/authorize`,
        token_endpoint: `${BASE}/oauth/token`,
        registration_endpoint: `${BASE}/oauth/register`,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    });

    it("the MCP endpoint names the embedded server as its authorization server", async () => {
      const prm = (await (await app(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp/${a}/mine`))).json()) as { authorization_servers: string[] };
      expect(prm.authorization_servers).toEqual([BASE]);
    });

    it("publishes only public signing keys", async () => {
      const { keys } = (await (await app(new Request(`${BASE}/oauth/jwks`))).json()) as { keys: Array<Record<string, unknown>> };
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256" });
      expect(keys[0]).not.toHaveProperty("d");
    });

    it("stores the signing key only wrapped by the master key", async () => {
      const rows = await db.withoutTenant((tx) => tx.select().from(schema.oauthSigningKeys));
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0]!.wrappedPrivate)).not.toMatch(/"d"/);
      expect(rows[0]!.wrappedPrivate).toHaveProperty("ciphertext");
    });
  });

  describe("client registration", () => {
    it("registers a public client", async () => {
      const response = await register({ redirect_uris: [REDIRECT], client_name: "Claude", token_endpoint_auth_method: "client_secret_basic" });
      expect(response.status).toBe(201);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
      expect(body).not.toHaveProperty("client_secret");
    });

    it.each([["http://evil.example/cb"], ["javascript:alert(1)"], ["https://a.test/cb#x"]])("refuses redirect URI %s", async (uri) => {
      const response = await register({ redirect_uris: [uri] });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_redirect_uri" });
    });

    it("refuses a registration without redirect URIs", async () => {
      expect((await register({ client_name: "x" })).status).toBe(400);
    });
  });

  describe("authorize", () => {
    it("never redirects for an unknown client or an unregistered redirect URI", async () => {
      const clientId = await newClient();
      const unknown = await app(new Request(authorizeUrl("c_nope_nope_nope_nope", pkce().challenge)));
      const wrongRedirect = await app(new Request(authorizeUrl(clientId, pkce().challenge, { redirect_uri: "https://evil.example/cb" })));
      for (const response of [unknown, wrongRedirect]) {
        expect(response.status).toBe(400);
        expect(response.headers.get("location")).toBeNull();
        expect(response.headers.get("x-frame-options")).toBe("DENY");
      }
    });

    it.each([
      ["no PKCE", { code_challenge: "" }, "invalid_request"],
      ["plain PKCE", { code_challenge_method: "plain" }, "invalid_request"],
      ["a resource that isn't an MCP endpoint", { resource: "https://evil.example/mcp/x/y" }, "invalid_target"],
      ["another response type", { response_type: "token" }, "unsupported_response_type"],
    ])("returns an error to the client for %s", async (_, extra, error) => {
      const clientId = await newClient();
      const response = await app(new Request(authorizeUrl(clientId, pkce().challenge, extra)));
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin + location.pathname).toBe(REDIRECT);
      expect(location.searchParams.get("error")).toBe(error);
      expect(location.searchParams.get("state")).toBe("client-state");
      expect(location.searchParams.get("iss")).toBe(BASE);
    });

    it("lets a native app's loopback redirect use another port", async () => {
      const clientId = await newClient();
      const response = await app(new Request(authorizeUrl(clientId, pkce().challenge, { redirect_uri: "http://localhost:9999/callback" })));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("/oauth/login/idp?request=");
    });
  });

  describe("sign-in and consent", () => {
    it("shows who is signing in, to which toolset, and where the app returns", async () => {
      const consent = await untilConsent(new TestBrowser(app), authorizeUrl(await newClient(), pkce().challenge));
      expect(consent.status).toBe(200);
      expect(consent.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      const html = await consent.text();
      for (const text of ["Allow Test Client?", "alice@example.com", "My training (Alpha)", "Read and change data", "localhost:4567"]) expect(html).toContain(text);
    });

    it("refuses to finish sign-in in a different browser", async () => {
      const browser = new TestBrowser(app);
      const toLogin = await browser.get(authorizeUrl(await newClient(), pkce().challenge));
      const toProvider = await browser.get(toLogin.headers.get("location")!);
      const back = op.approve(toProvider.headers.get("location")!, ALICE);
      const otherBrowser = new TestBrowser(app);
      expect((await otherBrowser.get(back)).status).toBe(400);
    });

    it("refuses an ID token with the wrong nonce", async () => {
      op.wrongNonce = true;
      expect((await untilConsent(new TestBrowser(app), authorizeUrl(await newClient(), pkce().challenge))).status).toBe(502);
    });

    it("says no access for someone who isn't a member with access", async () => {
      for (const user of [{ sub: "carol", email: "carol@example.com" }, { sub: "bob", email: "bob@example.com" }, { sub: "stranger", email: "s@example.com" }]) {
        const page = await untilConsent(new TestBrowser(app), authorizeUrl(await newClient(), pkce().challenge), user);
        expect(page.status).toBe(403);
        const html = await page.text();
        expect(html).toContain("have access to this toolset");
        // The account id an owner needs to grant access.
        expect(html).toContain(`<code>${await db.ensureUser(op.issuer, user.sub)}</code>`);
      }
    });

    it("sends access_denied back when the user denies", async () => {
      const browser = new TestBrowser(app);
      const html = await (await untilConsent(browser, authorizeUrl(await newClient(), pkce().challenge))).text();
      const requestId = /name="request" value="([^"]+)"/.exec(html)![1]!;
      const response = await browser.postForm(`${BASE}/oauth/consent`, { request: requestId, decision: "deny" }, { origin: BASE });
      expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    });

    it("refuses a consent form posted from another site", async () => {
      const browser = new TestBrowser(app);
      const html = await (await untilConsent(browser, authorizeUrl(await newClient(), pkce().challenge))).text();
      const requestId = /name="request" value="([^"]+)"/.exec(html)![1]!;
      const response = await browser.postForm(`${BASE}/oauth/consent`, { request: requestId, decision: "allow" }, { origin: "https://evil.example" });
      expect(response.status).toBe(403);
      expect(response.headers.get("location")).toBeNull();
    });
  });

  describe("tokens", () => {
    it("issues an access token for exactly one MCP endpoint, and it works there", async () => {
      const { clientId, tokens } = await signInFully();
      expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 900, scope: "mcp" });
      expect(decodeProtectedHeader(tokens.access_token)).toMatchObject({ alg: "ES256", typ: "at+jwt" });
      expect(decodeJwt(tokens.access_token)).toMatchObject({ iss: BASE, sub: alice, aud: resource(a), client_id: clientId, scope: "mcp" });

      const listed = await mcpList(tokens.access_token);
      expect(listed.status).toBe(200);
      expect(JSON.stringify(await listed.json())).toContain("list_activities");
      // Not for any other endpoint, even one alice could use.
      expect((await mcpList(tokens.access_token, resource(b))).status).toBe(401);
    });

    it("rejects a wrong code verifier, redirect URI, client, or resource", async () => {
      const clientId = await newClient();
      const otherClient = await newClient();
      for (const extra of [{ code_verifier: pkce().verifier }, { redirect_uri: "http://localhost:4567/other" }, { client_id: otherClient }, { resource: resource(b) }]) {
        const { verifier, challenge } = pkce();
        const response = await exchange(clientId, await getCode(clientId, challenge), verifier, extra);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "invalid_grant" });
      }
    });

    it("expires codes after a minute", async () => {
      const clientId = await newClient();
      const { verifier, challenge } = pkce();
      const code = await getCode(clientId, challenge);
      clock += 61_000;
      expect((await exchange(clientId, code, verifier)).status).toBe(400);
    });

    it("treats a reused code as leaked: refused, and its tokens are revoked", async () => {
      const clientId = await newClient();
      const { verifier, challenge } = pkce();
      const code = await getCode(clientId, challenge);
      const first = (await (await exchange(clientId, code, verifier)).json()) as Tokens;
      expect((await exchange(clientId, code, verifier)).status).toBe(400);
      const refreshed = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token });
      expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
    });

    it("rotates refresh tokens", async () => {
      const { clientId, tokens } = await signInFully();
      const response = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token });
      expect(response.status).toBe(200);
      const next = (await response.json()) as Tokens;
      expect(next.refresh_token).not.toBe(tokens.refresh_token);
      expect(decodeJwt(next.access_token)).toMatchObject({ sub: alice, aud: resource(a) });
      expect((await mcpList(next.access_token)).status).toBe(200);
    });

    it("revokes the whole family when a rotated refresh token is reused", async () => {
      const { clientId, tokens } = await signInFully();
      const next = (await (await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token })).json()) as Tokens;
      // Someone replays the old one: refused, and the current one stops working too.
      expect((await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token })).status).toBe(400);
      expect((await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: next.refresh_token })).status).toBe(400);
    });

    it("refuses another client's refresh token", async () => {
      const { tokens } = await signInFully();
      const response = await tokenRequest({ grant_type: "refresh_token", client_id: await newClient(), refresh_token: tokens.refresh_token });
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    });

    it("stores codes and refresh tokens only as hashes", async () => {
      const { tokens } = await signInFully();
      const rows = await db.withoutTenant(async (tx) => [await tx.select().from(schema.oauthRequests), await tx.select().from(schema.oauthRefreshTokens)]);
      expect(JSON.stringify(rows)).not.toContain(tokens.refresh_token);
    });

    it("access is still checked per call: a token stops working when access is revoked", async () => {
      const temp = await db.ensureUser(op.issuer, "temp");
      await db.withTenant(a, async (tx) => {
        await addMember(tx, temp, "member");
        await setToolsetAccess(tx, "mine" as never, temp, "use");
      });
      const clientId = await newClient();
      const { verifier, challenge } = pkce();
      const tokens = (await (await exchange(clientId, await getCode(clientId, challenge, { sub: "temp", email: "t@example.com" }), verifier)).json()) as Tokens;
      expect((await mcpList(tokens.access_token)).status).toBe(200);
      await db.withTenant(a, (tx) => tx.delete(schema.memberships).where(eq(schema.memberships.userId, temp)));
      expect((await mcpList(tokens.access_token)).status).toBe(403);
    });
  });

  describe("with the MCP SDK's OAuth client", () => {
    it("discovers, registers, signs in, and calls a tool", async () => {
      const fetchFn = (url: string | URL, init?: RequestInit) => app(new Request(url, init));
      const browser = new TestBrowser(app);
      const store: { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; authorizationUrl?: URL } = {};
      const provider: OAuthClientProvider = {
        redirectUrl: REDIRECT,
        clientMetadata: { client_name: "SDK Client", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" } as OAuthClientMetadata,
        clientInformation: () => store.client,
        saveClientInformation: (info) => void (store.client = info),
        tokens: () => store.tokens,
        saveTokens: (tokens) => void (store.tokens = tokens),
        redirectToAuthorization: (url) => void (store.authorizationUrl = url),
        saveCodeVerifier: (v) => void (store.verifier = v),
        codeVerifier: () => store.verifier!,
      };

      expect(await auth(provider, { serverUrl: resource(a), fetchFn })).toBe("REDIRECT");
      expect(store.authorizationUrl?.searchParams.get("resource")).toBe(resource(a));
      const consent = await untilConsent(browser, store.authorizationUrl!.toString());
      const code = (await allow(browser, consent)).searchParams.get("code")!;
      expect(await auth(provider, { serverUrl: resource(a), authorizationCode: code, fetchFn })).toBe("AUTHORIZED");

      const client = new Client({ name: "sdk", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(resource(a)), { authProvider: provider, fetch: fetchFn });
      // The SDK's own classes disagree under exactOptionalPropertyTypes (sessionId?: string vs string | undefined).
      await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
      const result = await client.callTool({ name: "list_activities", arguments: { oldest: "2026-10-25" } });
      // Tenant A has no stored credential here; reaching the runtime is what matters.
      expect(result.structuredContent).toMatchObject({ error: { kind: "missing_credentials" } });
      expect(upstreamCalls).toBe(0);
      await client.close();

      const audit = await db.withTenant(a, (tx) => listAuditEvents(tx));
      expect(audit).toEqual([]); // reads aren't audited (D-020)
    });
  });
});
