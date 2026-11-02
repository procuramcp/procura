// A tenant's own sign-in (D-040), end to end through the app: customers sign
// in at the tenant's provider (OIDC, or plain OAuth 2 with a userinfo URL),
// are created on first sign-in, get profiles from their claims, and those
// claims are read again on every token refresh. Real Postgres as the app role.
import { randomBytes } from "node:crypto";
import { OidcIdentityProvider, type ProviderFetch } from "@cairnmcp/auth";
import { AccessProfile, SIGN_IN_SECRET_CONTEXT, SignInConfig, Toolset, type TenantId, type UserId } from "@cairnmcp/core";
import {
  Database,
  getMember,
  listCustomers,
  memberProfileIds,
  PgVaultStore,
  putProfile,
  putSignIn,
  putSource,
  putToolset,
  setMemberProfiles,
  signInProfileIds,
  updateMember,
} from "@cairnmcp/db";
import { intervalsIr, scratchDatabase, testDatabaseUrl, type ScratchDatabase } from "@cairnmcp/db/test-support";
import { LocalKeyWrapper, Vault } from "@cairnmcp/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { FakeOidcProvider, pkce, TestBrowser } from "./test-support.ts";

const adminUrl = testDatabaseUrl();
const BASE = "https://cairn.test";
const REDIRECT = "http://localhost:4567/callback";

describe.skipIf(!adminUrl)("a tenant's own sign-in (D-040, Postgres)", () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let app: (request: Request) => Promise<Response>;
  let acmeOp: FakeOidcProvider; // OIDC
  let zetaOp: FakeOidcProvider; // plain OAuth 2
  let staffOp: FakeOidcProvider; // the console's own sign-in
  const acme = "acme" as TenantId;
  const zeta = "zeta" as TenantId;
  const resource = (tenantId: string) => `${BASE}/mcp/${tenantId}/mine`;

  beforeAll(async () => {
    scratch = await scratchDatabase(adminUrl!);
    db = await Database.connect({ url: scratch.appUrl, max: 4 });
    acmeOp = await FakeOidcProvider.create({ issuer: "https://login.acme.test" });
    zetaOp = await FakeOidcProvider.create({ issuer: "https://api.zeta.test", plainOAuth2: true });
    staffOp = await FakeOidcProvider.create();
    const keyWrapper = new LocalKeyWrapper(randomBytes(32));
    const vault = new Vault({ store: new PgVaultStore(db), keyWrapper });

    const toolset = Toolset.parse({
      id: "mine",
      sourceId: "intervals-icu",
      name: "My training",
      tools: [{ operationId: "list_activities", name: "list_activities", description: "List my activities.", pinnedInputs: { id: "0" } }],
    });
    const configs: Record<string, SignInConfig> = {
      acme: SignInConfig.parse({ kind: "oidc", name: "Acme", issuer: acmeOp.issuer, clientId: acmeOp.clientId, defaultProfileId: "free" }),
      zeta: SignInConfig.parse({
        kind: "oauth2",
        name: "Zeta",
        clientId: zetaOp.clientId,
        authorizationUrl: `${zetaOp.issuer}/authorize`,
        tokenUrl: `${zetaOp.issuer}/token`,
        userinfoUrl: `${zetaOp.issuer}/api/me`,
      }),
    };
    for (const [tenantId, op] of [[acme, acmeOp], [zeta, zetaOp]] as const) {
      const owner = await db.ensureUser(staffOp.issuer, `${tenantId}-owner`);
      await db.createTenant(tenantId, owner, { id: tenantId });
      const sealed = await vault.sealSecret(tenantId, SIGN_IN_SECRET_CONTEXT, op.clientSecret);
      await db.withTenant(tenantId, async (tx) => {
        await putSource(tx, intervalsIr());
        await putToolset(tx, toolset);
        await putProfile(tx, AccessProfile.parse({ id: "free", name: "Free", rules: [], claims: [] }));
        await putProfile(tx, AccessProfile.parse({ id: "pro", name: "Pro", rules: [{ toolsetId: "mine", level: "use" }], claims: [{ claim: "plan", value: "pro" }] }));
        await putSignIn(tx, configs[tenantId]!, sealed);
      });
    }

    // Tenant providers are reached only through this fetch: a fake web of the two providers.
    const signInFetch: ProviderFetch = (url, init) => (url.startsWith(acmeOp.issuer) ? acmeOp : zetaOp).fetch(url, init as never);
    app = await createApp({
      db,
      keyWrapper,
      publicUrl: BASE,
      providers: [new OidcIdentityProvider({ id: "idp", name: "Staff", issuer: staffOp.issuer, clientId: staffOp.clientId, clientSecret: staffOp.clientSecret }, { fetch: staffOp.fetch })],
      fetch: async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
      signInFetch,
    });
  });

  afterAll(async () => {
    await db?.close();
    await scratch?.drop();
  });

  // --- Helpers ---------------------------------------------------------------

  async function newClient(): Promise<string> {
    const response = await app(new Request(`${BASE}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) }));
    return ((await response.json()) as { client_id: string }).client_id;
  }

  /** Authorize for `tenantId`'s endpoint and sign in at its provider as `user`; returns the page after the callback. */
  async function signIn(browser: TestBrowser, clientId: string, challenge: string, tenantId: string, op: FakeOidcProvider, user: { sub: string; email: string }) {
    const url = new URL(`${BASE}/oauth/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", resource: resource(tenantId) })) {
      url.searchParams.set(k, v);
    }
    const toLogin = await browser.get(url);
    expect(toLogin.headers.get("location")).toMatch(new RegExp(`^${BASE}/oauth/login/tenant/${tenantId}\\?request=`));
    const toProvider = await browser.get(toLogin.headers.get("location")!);
    expect(toProvider.status).toBe(302);
    const back = op.approve(toProvider.headers.get("location")!, user);
    expect(back.toString()).toMatch(new RegExp(`^${BASE}/oauth/callback/tenant/${tenantId}\\?`));
    return browser.get(back);
  }

  type Tokens = { access_token: string; refresh_token: string };

  /** The whole flow to tokens. */
  async function connect(tenantId: string, op: FakeOidcProvider, user: { sub: string; email: string }): Promise<{ clientId: string; tokens: Tokens }> {
    const clientId = await newClient();
    const { verifier, challenge } = pkce();
    const browser = new TestBrowser(app);
    const consent = await signIn(browser, clientId, challenge, tenantId, op, user);
    expect(consent.status).toBe(200);
    const requestId = /name="request" value="([^"]+)"/.exec(await consent.text())![1]!;
    const allowed = await browser.postForm(`${BASE}/oauth/consent`, { request: requestId, decision: "allow" }, { origin: BASE });
    const code = new URL(allowed.headers.get("location")!).searchParams.get("code")!;
    const tokens = await token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT });
    expect(tokens.status).toBe(200);
    return { clientId, tokens: (await tokens.json()) as Tokens };
  }

  const token = (form: Record<string, string>) =>
    app(new Request(`${BASE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }));
  const refresh = (clientId: string, refreshToken: string) => token({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });

  const userOf = (issuer: string, subject: string) => db.findUser(issuer, subject);
  const profilesOf = async (tenantId: TenantId, user: UserId) => ((await db.withTenant(tenantId, (tx) => memberProfileIds(tx, [user]))).get(user) ?? []).sort();

  // --- Tests -----------------------------------------------------------------

  it("makes a new customer at first sign-in, with profiles from their claims", async () => {
    acmeOp.claims.set("ann", { plan: "pro" });
    await connect("acme", acmeOp, { sub: "ann", email: "ann@acme.test" });
    const ann = (await userOf(acmeOp.issuer, "ann"))!;
    const member = await db.withTenant(acme, (tx) => getMember(tx, ann));
    expect(member).toMatchObject({ role: "customer", status: "active", label: "ann@acme.test" });
    expect(await profilesOf(acme, ann)).toEqual(["free", "pro"]);
    expect((await db.withTenant(acme, (tx) => signInProfileIds(tx, [ann]))).get(ann)?.sort()).toEqual(["free", "pro"]);
  });

  it("reads claims again on refresh: a downgrade takes away the plan, the team's own grant stays", async () => {
    acmeOp.claims.set("ben", { plan: "pro" });
    const { clientId, tokens } = await connect("acme", acmeOp, { sub: "ben", email: "ben@acme.test" });
    const ben = (await userOf(acmeOp.issuer, "ben"))!;
    await db.withTenant(acme, async (tx) => {
      await putProfile(tx, AccessProfile.parse({ id: "beta", name: "Beta", rules: [] }));
      await setMemberProfiles(tx, ben, ["beta"]);
    });

    acmeOp.claims.set("ben", { plan: "basic" });
    const refreshed = await refresh(clientId, tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    expect(await profilesOf(acme, ben)).toEqual(["beta", "free"]);

    // The provider ends their session: the next refresh is refused and they must connect again.
    acmeOp.revoke("ben");
    const next = (await refreshed.json()) as Tokens;
    const ended = await refresh(clientId, next.refresh_token);
    expect(ended.status).toBe(400);
    expect(await ended.json()).toMatchObject({ error: "invalid_grant", error_description: expect.stringMatching(/sign-in at the provider has ended/) });
  });

  it("shows no access to someone whose claims give no plan for this toolset", async () => {
    const { challenge } = pkce();
    const page = await signIn(new TestBrowser(app), await newClient(), challenge, "acme", acmeOp, { sub: "cat", email: "cat@acme.test" });
    expect(page.status).toBe(403);
    // They're a customer now (with the default plan), so the team can find them and give access.
    const found = await db.withTenant(acme, (tx) => listCustomers(tx, { query: "cat@acme.test" }));
    expect(found.customers).toHaveLength(1);
  });

  it("never lifts a suspension by signing in", async () => {
    acmeOp.claims.set("dan", { plan: "pro" });
    await connect("acme", acmeOp, { sub: "dan", email: "dan@acme.test" });
    const dan = (await userOf(acmeOp.issuer, "dan"))!;
    await db.withTenant(acme, (tx) => updateMember(tx, dan, { status: "suspended" }));
    const { challenge } = pkce();
    const page = await signIn(new TestBrowser(app), await newClient(), challenge, "acme", acmeOp, { sub: "dan", email: "dan@acme.test" });
    expect(page.status).toBe(403);
    expect((await db.withTenant(acme, (tx) => getMember(tx, dan)))?.status).toBe("suspended");
  });

  it("signs in with plain OAuth 2, identifying people by the userinfo URL's id", async () => {
    zetaOp.claims.set("u42", { plan: "pro" });
    const { clientId, tokens } = await connect("zeta", zetaOp, { sub: "u42", email: "eve@zeta.test" });
    const eve = (await userOf(`oauth2:${zetaOp.issuer}/api/me`, "42"))!;
    expect(eve).toBeDefined();
    expect((await db.withTenant(zeta, (tx) => getMember(tx, eve)))?.label).toBe("eve@zeta.test");
    expect(await profilesOf(zeta, eve)).toEqual(["pro"]);

    zetaOp.claims.set("u42", {});
    expect((await refresh(clientId, tokens.refresh_token)).status).toBe(200);
    expect(await profilesOf(zeta, eve)).toEqual([]);
  });

  it("won't use one tenant's sign-in for another tenant's endpoint", async () => {
    const browser = new TestBrowser(app);
    const url = new URL(`${BASE}/oauth/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: await newClient(), redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256", resource: resource("zeta") })) {
      url.searchParams.set(k, v);
    }
    const toLogin = new URL((await browser.get(url)).headers.get("location")!);
    const swapped = `${BASE}/oauth/login/tenant/acme${toLogin.search}`;
    expect((await browser.get(swapped)).status).toBe(400);
  });
});
