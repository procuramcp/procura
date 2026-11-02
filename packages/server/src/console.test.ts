// The curation console's server side (D-033) against real Postgres: sign-in
// and sessions, who may edit what, CSRF, editing a toolset and its access,
// the tool test panel, and the static files.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { OidcIdentityProvider } from "@cairnmcp/auth";
import { Toolset, type TenantId, type UserId } from "@cairnmcp/core";
import { addMember, Database, PgVaultStore, putSource, putToolset, schema, setToolsetAccess } from "@cairnmcp/db";
import { intervalsIr, scratchDatabase, testDatabaseUrl, type ScratchDatabase } from "@cairnmcp/db/test-support";
import type { FetchLike } from "@cairnmcp/runtime";
import { LocalKeyWrapper, Vault } from "@cairnmcp/vault";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { FetchRefused, type DocumentGetter } from "./fetch-document.ts";
import { FakeOidcProvider, TestBrowser } from "./test-support.ts";

const adminUrl = testDatabaseUrl();
const BASE = "https://cairn.test";
const API = `${BASE}/app/api`;
const OPENAPI = readFileSync(new URL("../../ingest/fixtures/intervals-icu/openapi.json", import.meta.url), "utf8");
const SECRET = "fake-console-key-0123456789";

/** A fake web for URL ingestion: the Intervals.icu shape (Swagger UI page, config, document). */
const getDocument: DocumentGetter = async (url) => {
  if (url.includes("internal")) throw new FetchRefused("internal.test points to a private or internal address");
  const pages: Record<string, string> = {
    "https://api.test/api/v1/docs/swagger-ui/index.html": "<html>Swagger UI</html>",
    "https://api.test/api/v1/docs/swagger-config": JSON.stringify({ url: "/api/v1/docs" }),
    "https://api.test/api/v1/docs": OPENAPI,
  };
  const text = pages[url];
  return text === undefined ? { url, status: 404, contentType: "text/plain", text: "" } : { url, status: 200, contentType: "application/json", text };
};

describe.skipIf(!adminUrl)("curation console (Postgres)", () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let op: FakeOidcProvider;
  let app: (request: Request) => Promise<Response>;
  let alice: UserId; // owner of Alpha
  let carol: UserId; // a customer of Alpha: calls tools, never the console
  let vic: UserId; // a viewer of Alpha
  let ed: UserId; // an editor of Alpha
  let a: TenantId;
  let b: TenantId;
  let upstream: string[];

  const starter = {
    id: "mine",
    sourceId: "intervals-icu",
    name: "My training",
    tools: [{ operationId: "list_activities", name: "list_activities", description: "List my activities.", pinnedInputs: { id: "0" } }],
  };

  beforeAll(async () => {
    scratch = await scratchDatabase(adminUrl!);
    db = await Database.connect({ url: scratch.appUrl, max: 4 });
    op = await FakeOidcProvider.create();
    alice = await db.ensureUser(op.issuer, "alice");
    carol = await db.ensureUser(op.issuer, "carol");
    const bob = await db.ensureUser(op.issuer, "bob");
    a = await db.createTenant("Alpha", alice, { id: "alpha" as TenantId });
    b = await db.createTenant("Bravo", bob, { id: "bravo" as TenantId });
    for (const [tenantId, owner] of [[a, alice], [b, bob]] as const) {
      await db.withTenant(tenantId, async (tx) => {
        await putSource(tx, intervalsIr());
        await putToolset(tx, Toolset.parse(starter));
        await setToolsetAccess(tx, "mine" as never, owner, "use");
      });
    }
    vic = await db.ensureUser(op.issuer, "vic");
    ed = await db.ensureUser(op.issuer, "ed");
    await db.withTenant(a, async (tx) => {
      await addMember(tx, carol, "customer");
      await addMember(tx, vic, "viewer");
      await addMember(tx, ed, "editor");
    });
    const keyWrapper = new LocalKeyWrapper(randomBytes(32));
    const vault = new Vault({ store: new PgVaultStore(db), keyWrapper });
    await vault.putCredential({ tenantId: a, sourceId: "intervals-icu", schemeId: "APIKey", credential: { kind: "basic", username: "API_KEY", password: "fake-key-0000" } });

    const staticDir = mkdtempSync(join(tmpdir(), "cairnmcp-console-"));
    mkdirSync(join(staticDir, "assets"));
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>console</title>");
    writeFileSync(join(staticDir, "assets", "app-123.js"), "console.log(1)");
    writeFileSync(join(tmpdir(), "outside-console.txt"), "secret");

    const fetch: FetchLike = async (url) => (upstream.push(url), new Response('[{"id":"i1"}]', { status: 200, headers: { "content-type": "application/json" } }));
    app = await createApp({
      db,
      keyWrapper,
      publicUrl: BASE,
      providers: [new OidcIdentityProvider({ id: "idp", name: "Test IdP", issuer: op.issuer, clientId: op.clientId, clientSecret: op.clientSecret }, { fetch: op.fetch })],
      fetch,
      consoleDir: staticDir,
      getDocument,
    });
  });

  beforeEach(() => {
    upstream = [];
  });

  afterAll(async () => {
    await db?.close();
    await scratch?.drop();
  });

  async function signIn(user = { sub: "alice", email: "alice@example.com" }): Promise<TestBrowser> {
    const browser = new TestBrowser(app);
    const toProvider = await browser.get(`${BASE}/app/login/idp`);
    expect(toProvider.status).toBe(302);
    const back = await browser.get(op.approve(toProvider.headers.get("location")!, user));
    expect([back.status, back.headers.get("location")]).toEqual([302, `${BASE}/app/`]);
    return browser;
  }

  describe("sign-in and sessions", () => {
    it("signs in through the provider and lists only your own tenants", async () => {
      const browser = await signIn();
      const me = await browser.json("GET", `${API}/me`);
      expect(me.status).toBe(200);
      expect(await me.json()).toEqual({ user: { id: alice, label: "alice@example.com" }, tenants: [{ id: "alpha", name: "Alpha", role: "owner" }] });
    });

    it("says signed out, with where to sign in, without a session", async () => {
      const me = await new TestBrowser(app).json("GET", `${API}/me`);
      expect(me.status).toBe(401);
      expect(await me.json()).toEqual({ error: "signed_out", providers: [{ id: "idp", name: "Test IdP", href: "/app/login/idp" }] });
    });

    it("sets __Host- cookies that scripts can't read", async () => {
      const browser = new TestBrowser(app);
      const start = await browser.get(`${BASE}/app/login/idp`);
      expect(start.headers.getSetCookie()[0]).toMatch(/^__Host-cairnmcp_login=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
      const back = await browser.get(op.approve(start.headers.get("location")!, { sub: "alice", email: "alice@example.com" }));
      expect(back.headers.getSetCookie()[0]).toMatch(/^__Host-cairnmcp_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=28800; Secure$/);
    });

    it("refuses a callback in a different browser, and a replayed one", async () => {
      const browser = new TestBrowser(app);
      const start = await browser.get(`${BASE}/app/login/idp`);
      const callback = op.approve(start.headers.get("location")!, { sub: "alice", email: "alice@example.com" });
      expect((await new TestBrowser(app).get(callback)).status).toBe(400); // no login cookie: and the state is now spent
      expect((await browser.get(callback)).status).toBe(400);
    });

    it("logs out", async () => {
      const browser = await signIn();
      expect((await browser.json("POST", `${API}/logout`, {})).status).toBe(200);
      expect((await browser.json("GET", `${API}/me`)).status).toBe(401);
    });
  });

  describe("who may do what (D-038)", () => {
    it("hides other tenants, and keeps customers out of the console entirely", async () => {
      const alice_ = await signIn();
      expect((await alice_.json("GET", `${API}/tenants/bravo`)).status).toBe(404);
      expect((await alice_.json("GET", `${API}/tenants/nope`)).status).toBe(404);
      const carol_ = await signIn({ sub: "carol", email: "carol@example.com" });
      expect(((await (await carol_.json("GET", `${API}/me`)).json()) as { tenants: unknown[] }).tenants).toEqual([]);
      // Same answer as a tenant that doesn't exist.
      for (const path of ["", "/toolsets/mine", "/access", "/customers", "/sources/intervals-icu"]) {
        expect((await carol_.json("GET", `${API}/tenants/alpha${path}`)).status, path).toBe(404);
      }
      expect((await carol_.json("PUT", `${API}/tenants/alpha/toolsets/mine`, starter)).status).toBe(404);
    });

    it("lets viewers look at everything but change nothing", async () => {
      const vic_ = await signIn({ sub: "vic", email: "vic@example.com" });
      expect(((await (await vic_.json("GET", `${API}/me`)).json()) as { tenants: unknown[] }).tenants).toEqual([{ id: "alpha", name: "Alpha", role: "viewer" }]);
      for (const path of ["", "/toolsets/mine", "/access", "/customers", "/sources/intervals-icu"]) {
        expect((await vic_.json("GET", `${API}/tenants/alpha${path}`)).status, path).toBe(200);
      }
      const writes: Array<[string, string, unknown?]> = [
        ["PUT", "/toolsets/mine", starter],
        ["PUT", "/toolsets/mine/access", { userId: vic, level: "use" }],
        ["POST", "/toolsets", { id: "new", sourceId: "intervals-icu", name: "New" }],
        ["POST", "/toolsets/mine/test", { tool: starter.tools[0], args: {} }],
        ["PUT", "/profiles/x", { name: "X", rules: [] }],
        ["PUT", `/members/${carol}/profiles`, { profiles: [] }],
        ["PUT", `/members/${carol}`, { status: "suspended" }],
        ["POST", "/sources/preview", { document: OPENAPI }],
        ["PUT", "/sources/intervals-icu/credentials/APIKey", { credential: { kind: "basic", password: "x" } }],
      ];
      for (const [method, path, body] of writes) {
        expect((await vic_.json(method, `${API}/tenants/alpha${path}`, body)).status, `${method} ${path}`).toBe(403);
      }
    });

    it("lets editors curate but not touch keys or the team", async () => {
      const ed_ = await signIn({ sub: "ed", email: "ed@example.com" });
      expect((await ed_.json("PUT", `${API}/tenants/alpha/toolsets/mine`, starter)).status).toBe(200);
      expect((await ed_.json("PUT", `${API}/tenants/alpha/sources/intervals-icu/credentials/APIKey`, { credential: { kind: "basic", password: "x" } })).status).toBe(403);
      expect((await ed_.json("DELETE", `${API}/tenants/alpha/sources/intervals-icu/credentials/APIKey`)).status).toBe(403);
      expect((await ed_.json("PUT", `${API}/tenants/alpha/members/${vic}/role`, { role: "editor" })).status).toBe(403);
      expect((await ed_.json("PUT", `${API}/tenants/alpha/members/${vic}`, { status: "suspended" })).status).toBe(403);
    });

    it("refuses writes from another site or as a form", async () => {
      const browser = await signIn();
      const evil = await browser.json("PUT", `${API}/tenants/alpha/toolsets/mine`, starter, { origin: "https://evil.example" });
      expect(evil.status).toBe(403);
      const noOrigin = await browser.json("PUT", `${API}/tenants/alpha/toolsets/mine`, starter, { origin: "" });
      expect(noOrigin.status).toBe(403);
      const form = await browser.json("PUT", `${API}/tenants/alpha/toolsets/mine`, starter, { "content-type": "text/plain" });
      expect(form.status).toBe(415);
    });
  });

  describe("editing", () => {
    it("shows the tenant and the toolset with every operation and its side effect", async () => {
      const browser = await signIn();
      const tenant = (await (await browser.json("GET", `${API}/tenants/alpha`)).json()) as { toolsets: unknown[]; people: { team: number; customers: number } };
      expect(tenant.toolsets).toEqual([{ id: "mine", name: "My training", sourceId: "intervals-icu", enabledTools: 1, endpoint: `${BASE}/mcp/alpha/mine` }]);
      expect(tenant.people.team).toBeGreaterThanOrEqual(3);
      expect(tenant.people.customers).toBeGreaterThanOrEqual(1);
      const view = (await (await browser.json("GET", `${API}/tenants/alpha/toolsets/mine`)).json()) as { operations: Array<{ id: string; sideEffect: { class: string } }>; issues: unknown[] };
      expect(view.operations).toHaveLength(148);
      expect(view.operations.find((o) => o.id === "list_activities")?.sideEffect.class).toBe("read");
      expect(view.issues).toEqual([]);
    });

    it("saves a toolset, and refuses one that doesn't fit the source", async () => {
      const browser = await signIn();
      const edited = { ...starter, tools: [...starter.tools, { operationId: "get_activity", name: "get_activity", description: "One activity by id." }] };
      const saved = await browser.json("PUT", `${API}/tenants/alpha/toolsets/mine`, edited);
      expect(saved.status).toBe(200);
      expect(((await saved.json()) as { toolset: { tools: unknown[] } }).toolset.tools).toHaveLength(2);
      const bad = await browser.json("PUT", `${API}/tenants/alpha/toolsets/mine`, { ...starter, tools: [{ operationId: "no_such_op", name: "nope", description: "x" }] });
      expect(bad.status).toBe(422);
      const dup = await browser.json("PUT", `${API}/tenants/alpha/toolsets/mine`, { ...starter, tools: [starter.tools[0], starter.tools[0]] });
      expect(dup.status).toBe(422);
      expect(((await dup.json()) as { issues: Array<{ toolName: string }> }).issues[0]?.toolName).toBe("list_activities");
    });

    it("creates a toolset with the read-only default", async () => {
      const browser = await signIn();
      const created = await browser.json("POST", `${API}/tenants/alpha/toolsets`, { id: "everything", sourceId: "intervals-icu", name: "Everything" });
      expect(created.status).toBe(201);
      const view = (await (await browser.json("GET", `${API}/tenants/alpha/toolsets/everything`)).json()) as { toolset: { tools: Array<{ enabled: boolean }> }; access: unknown[] };
      expect(view.toolset.tools.filter((t) => t.enabled)).toHaveLength(79);
      expect(view.access).toEqual([{ userId: alice, label: "alice@example.com", role: "owner", level: "use" }]);
      expect((await browser.json("POST", `${API}/tenants/alpha/toolsets`, { id: "everything", sourceId: "intervals-icu", name: "Again" })).status).toBe(409);
    });

    it("grants and revokes access, and explains an unknown account", async () => {
      const browser = await signIn();
      const dave = await db.ensureUser(op.issuer, "dave");
      const granted = await browser.json("PUT", `${API}/tenants/alpha/toolsets/mine/access`, { userId: dave, level: "use_writes" });
      // Someone new is added as a customer.
      expect(((await granted.json()) as { access: unknown[] }).access).toContainEqual({ userId: dave, label: null, role: "customer", level: "use_writes" });
      const revoked = await browser.json("PUT", `${API}/tenants/alpha/toolsets/mine/access`, { userId: dave, level: "none" });
      expect(((await revoked.json()) as { access: Array<{ userId: string }> }).access.map((x) => x.userId)).not.toContain(dave);
      const unknown = await browser.json("PUT", `${API}/tenants/alpha/toolsets/mine/access`, { userId: "no-such-user", level: "use" });
      expect(unknown.status).toBe(404);
    });
  });

  describe("access profiles (D-034)", () => {
    it("creates a profile, assigns it, and shows it on the toolset", async () => {
      const browser = await signIn();
      const created = await browser.json("PUT", `${API}/tenants/alpha/profiles/coach`, {
        name: "Coach",
        description: "",
        rules: [{ toolsetId: "mine", level: "use", operations: ["list_activities"] }],
      });
      expect(created.status).toBe(200);
      const assigned = await browser.json("PUT", `${API}/tenants/alpha/members/${carol}/profiles`, { profiles: ["coach"] });
      const view = (await assigned.json()) as { profiles: Array<{ id: string; members: string[] }> };
      expect(view.profiles).toEqual([expect.objectContaining({ id: "coach", members: [carol] })]);
      const customers = (await (await browser.json("GET", `${API}/tenants/alpha/customers?q=${carol}`)).json()) as { customers: Array<{ profiles: string[] }> };
      expect(customers.customers.map((c) => c.profiles)).toEqual([["coach"]]);
      const toolset = (await (await browser.json("GET", `${API}/tenants/alpha/toolsets/mine`)).json()) as { profiles: unknown[] };
      expect(toolset.profiles).toEqual([{ profileId: "coach", name: "Coach", level: "use", operations: ["list_activities"], members: [carol] }]);
    });

    it("refuses rules for toolsets or tools that don't exist, and assignments to strangers", async () => {
      const browser = await signIn();
      const noToolset = await browser.json("PUT", `${API}/tenants/alpha/profiles/bad`, { name: "Bad", rules: [{ toolsetId: "nope", level: "use" }] });
      expect(noToolset.status).toBe(422);
      const noTool = await browser.json("PUT", `${API}/tenants/alpha/profiles/bad`, { name: "Bad", rules: [{ toolsetId: "mine", level: "use", operations: ["delete_activity"] }] });
      expect(noTool.status).toBe(422);
      const twice = await browser.json("PUT", `${API}/tenants/alpha/profiles/bad`, { name: "Bad", rules: [{ toolsetId: "mine", level: "use" }, { toolsetId: "mine", level: "use_writes" }] });
      expect(twice.status).toBe(422);
      const stranger = await db.ensureUser(op.issuer, "stranger");
      expect((await browser.json("PUT", `${API}/tenants/alpha/members/${stranger}/profiles`, { profiles: [] })).status).toBe(404);
      expect((await browser.json("PUT", `${API}/tenants/alpha/members/no-such-account/profiles`, { profiles: ["coach"] })).status).toBe(404);
      expect((await browser.json("PUT", `${API}/tenants/alpha/members/${carol}/profiles`, { profiles: ["missing"] })).status).toBe(404);
    });

    it("adds someone who has signed in as a customer when they get a profile", async () => {
      const browser = await signIn();
      const erin = await db.ensureUser(op.issuer, "erin", "erin@example.com");
      const added = await browser.json("PUT", `${API}/tenants/alpha/members/${erin}/profiles`, { profiles: ["coach"] });
      expect(added.status).toBe(200);
      const found = (await (await browser.json("GET", `${API}/tenants/alpha/customers?q=erin@`)).json()) as { customers: unknown[] };
      expect(found.customers).toEqual([expect.objectContaining({ userId: erin, label: "erin@example.com", role: "customer", status: "active", profiles: ["coach"] })]);
    });

    it("saves a plan's limits, refuses a link that isn't https, and shows each customer's usage (D-039)", async () => {
      const browser = await signIn();
      const limits = { perDay: 500, perMonth: 10_000, upgradeUrl: "https://example.com/pricing" };
      const saved = await browser.json("PUT", `${API}/tenants/alpha/profiles/free`, { name: "Free", rules: [{ toolsetId: "mine", level: "use" }], limits });
      expect(((await saved.json()) as { profiles: Array<{ id: string; limits: unknown }> }).profiles.find((p) => p.id === "free")?.limits).toEqual(limits);
      const insecure = await browser.json("PUT", `${API}/tenants/alpha/profiles/free`, { name: "Free", rules: [], limits: { upgradeUrl: "http://example.com" } });
      expect(insecure.status).toBe(422);
      const zero = await browser.json("PUT", `${API}/tenants/alpha/profiles/free`, { name: "Free", rules: [], limits: { perDay: 0 } });
      expect(zero.status).toBe(422);

      const page = (await (await browser.json("GET", `${API}/tenants/alpha/customers?q=${carol}`)).json()) as { customers: Array<{ usage: unknown }> };
      expect(page.customers[0]?.usage).toEqual({ today: 0, month: 0 });
    });

    it("deletes a profile", async () => {
      const browser = await signIn();
      await browser.json("PUT", `${API}/tenants/alpha/profiles/temp`, { name: "Temp", rules: [] });
      const deleted = await browser.json("DELETE", `${API}/tenants/alpha/profiles/temp`);
      expect(((await deleted.json()) as { profiles: Array<{ id: string }> }).profiles.map((p) => p.id)).not.toContain("temp");
      expect((await browser.json("DELETE", `${API}/tenants/alpha/profiles/temp`)).status).toBe(404);
    });
  });

  describe("team and customers (D-038)", () => {
    type Page = { customers: Array<{ userId: string; label: string | null; status: string; note: string | null }>; total: number; next?: string };
    type Access = { team: Array<{ userId: string; role: string; label: string | null; you: boolean }>; customers: number };

    it("pages through customers newest first and searches them", async () => {
      const browser = await signIn();
      const ids: string[] = [];
      for (let i = 0; i < 55; i++) {
        const id = await db.ensureUser(op.issuer, `runner-${i}`, `runner${i}@club.test`);
        await db.withTenant(a, (tx) => addMember(tx, id, "customer"));
        ids.push(id);
      }
      const first = (await (await browser.json("GET", `${API}/tenants/alpha/customers?q=club.test`)).json()) as Page;
      expect([first.total, first.customers.length, first.customers[0]?.userId]).toEqual([55, 50, ids[54]]);
      const second = (await (await browser.json("GET", `${API}/tenants/alpha/customers?q=club.test&after=${first.next}`)).json()) as Page;
      expect(second.customers.map((c) => c.userId)).toEqual(ids.slice(0, 5).reverse());
      expect(second.next).toBeUndefined();
      const access = (await (await browser.json("GET", `${API}/tenants/alpha/access`)).json()) as Access;
      expect(access.customers).toBeGreaterThanOrEqual(56);
      expect(access.team.map((m) => m.role)).not.toContain("customer");
    });

    it("suspends and resumes a customer, with a note", async () => {
      const ed_ = await signIn({ sub: "ed", email: "ed@example.com" });
      const suspended = await ed_.json("PUT", `${API}/tenants/alpha/members/${carol}`, { status: "suspended", note: "  Card declined  " });
      expect(await suspended.json()).toMatchObject({ userId: carol, status: "suspended", note: "Card declined", role: "customer" });
      const resumed = await ed_.json("PUT", `${API}/tenants/alpha/members/${carol}`, { status: "active", note: "" });
      expect(await resumed.json()).toMatchObject({ status: "active", note: null });
      expect((await ed_.json("PUT", `${API}/tenants/alpha/members/${ed}`, { status: "suspended" })).status).toBe(403);
      expect((await ed_.json("PUT", `${API}/tenants/alpha/members/no-such-user`, { status: "suspended" })).status).toBe(404);
    });

    it("lets admins build the team, and only owners make or change owners", async () => {
      const alice_ = await signIn();
      const frank = await db.ensureUser(op.issuer, "frank", "frank@example.com");
      const added = (await (await alice_.json("PUT", `${API}/tenants/alpha/members/${frank}/role`, { role: "admin" })).json()) as Access;
      expect(added.team.find((m) => m.userId === frank)).toMatchObject({ role: "admin", label: "frank@example.com" });

      const frank_ = await signIn({ sub: "frank", email: "frank@example.com" });
      expect((await frank_.json("PUT", `${API}/tenants/alpha/members/${vic}/role`, { role: "editor" })).status).toBe(200);
      expect((await frank_.json("PUT", `${API}/tenants/alpha/members/${vic}/role`, { role: "owner" })).status).toBe(403);
      expect((await frank_.json("PUT", `${API}/tenants/alpha/members/${alice}/role`, { role: "viewer" })).status).toBe(403);
      expect((await frank_.json("PUT", `${API}/tenants/alpha/members/${alice}`, { status: "suspended" })).status).toBe(403);
      expect((await frank_.json("PUT", `${API}/tenants/alpha/members/${frank}/role`, { role: "owner" })).status).toBe(403);
      expect((await alice_.json("PUT", `${API}/tenants/alpha/members/${alice}/role`, { role: "admin" })).status).toBe(403);
      expect((await alice_.json("PUT", `${API}/tenants/alpha/members/no-such-user/role`, { role: "viewer" })).status).toBe(404);

      // Back to a viewer, for the other tests.
      expect((await frank_.json("PUT", `${API}/tenants/alpha/members/${vic}/role`, { role: "viewer" })).status).toBe(200);
    });

    it("removes people, but not yourself", async () => {
      const alice_ = await signIn();
      const gone = await db.ensureUser(op.issuer, "gone");
      await db.withTenant(a, (tx) => addMember(tx, gone, "customer"));
      expect(await (await alice_.json("DELETE", `${API}/tenants/alpha/members/${gone}`)).json()).toEqual({ ok: true });
      expect((await alice_.json("DELETE", `${API}/tenants/alpha/members/${gone}`)).status).toBe(404);
      expect((await alice_.json("DELETE", `${API}/tenants/alpha/members/${alice}`)).status).toBe(403);
    });
  });

  describe("customer sign-in (D-040)", () => {
    const settings = { kind: "oidc", name: "Alpha Login", clientId: "alpha-client", issuer: "https://login.alpha.test" };
    const CLIENT_SECRET = "fake-client-secret-0123456789";

    it("lets admins set it, keeps the client secret sealed, and never sends it back", async () => {
      const alice_ = await signIn();
      const empty = (await (await alice_.json("GET", `${API}/tenants/alpha/sign-in`)).json()) as { settings: unknown; callbackUrl: string };
      expect(empty).toEqual({ settings: null, secretSet: false, callbackUrl: `${BASE}/oauth/callback/tenant/alpha` });

      expect((await alice_.json("PUT", `${API}/tenants/alpha/sign-in`, settings)).status).toBe(422);
      const saved = await alice_.json("PUT", `${API}/tenants/alpha/sign-in`, { ...settings, clientSecret: CLIENT_SECRET });
      expect(saved.status).toBe(200);
      const text = await saved.text();
      expect(text).not.toContain(CLIENT_SECRET);
      expect(JSON.parse(text)).toMatchObject({ settings: { ...settings, scopes: "openid email profile offline_access" }, secretSet: true });
      const [row] = await db.withTenant(a, (tx) => tx.select().from(schema.tenantSignIn));
      expect(JSON.stringify(row)).not.toContain(CLIENT_SECRET);

      // Changing settings without a secret keeps the saved one.
      const renamed = (await (await alice_.json("PUT", `${API}/tenants/alpha/sign-in`, { ...settings, name: "Alpha" })).json()) as { secretSet: boolean };
      expect(renamed.secretSet).toBe(true);
    });

    it("refuses http URLs, unknown default profiles, and anyone below admin", async () => {
      const alice_ = await signIn();
      expect((await alice_.json("PUT", `${API}/tenants/alpha/sign-in`, { ...settings, issuer: "http://login.alpha.test", clientSecret: "x" })).status).toBe(422);
      expect((await alice_.json("PUT", `${API}/tenants/alpha/sign-in`, { ...settings, defaultProfileId: "nope", clientSecret: "x" })).status).toBe(422);
      const ed_ = await signIn({ sub: "ed", email: "ed@example.com" });
      expect((await ed_.json("PUT", `${API}/tenants/alpha/sign-in`, { ...settings, clientSecret: "x" })).status).toBe(403);
      expect((await ed_.json("DELETE", `${API}/tenants/alpha/sign-in`)).status).toBe(403);
      const vic_ = await signIn({ sub: "vic", email: "vic@example.com" });
      expect((await vic_.json("GET", `${API}/tenants/alpha/sign-in`)).status).toBe(200);
    });

    it("keeps claim rules on profiles and says which profiles came from sign-in", async () => {
      const alice_ = await signIn();
      const claims = [{ claim: "plan", value: "pro" }];
      const saved = (await (await alice_.json("PUT", `${API}/tenants/alpha/profiles/pro`, { name: "Pro", rules: [], claims })).json()) as { profiles: Array<{ id: string; claims: unknown }> };
      expect(saved.profiles.find((p) => p.id === "pro")?.claims).toEqual(claims);
      // Saving without claims or limits keeps them.
      const renamed = (await (await alice_.json("PUT", `${API}/tenants/alpha/profiles/pro`, { name: "Pro plan", rules: [] })).json()) as { profiles: Array<{ id: string; claims: unknown }> };
      expect(renamed.profiles.find((p) => p.id === "pro")?.claims).toEqual(claims);
      const page = (await (await alice_.json("GET", `${API}/tenants/alpha/customers?q=${carol}`)).json()) as { customers: Array<{ signInProfiles: string[] }> };
      expect(page.customers[0]?.signInProfiles).toEqual([]);
    });

    it("removes it", async () => {
      const alice_ = await signIn();
      expect(((await (await alice_.json("DELETE", `${API}/tenants/alpha/sign-in`)).json()) as { settings: unknown }).settings).toBeNull();
    });
  });

  describe("sources (D-035)", () => {
    it("previews a pasted document without storing anything", async () => {
      const browser = await signIn();
      const res = await browser.json("POST", `${API}/tenants/alpha/sources/preview`, { document: OPENAPI });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { preview: { name: string; operations: { total: number; read: number }; authSchemes: Array<{ id: string; type: string }> }; takenIds: string[] };
      expect(body.preview).toMatchObject({ name: "Intervals.icu API", operations: { total: 148, read: 79 } });
      expect(body.preview.authSchemes.map((a) => [a.id, a.type])).toEqual([["APIKey", "http_basic"], ["AccessToken", "http_bearer"]]);
      expect(body.takenIds).toEqual(["intervals-icu"]);
      const tenant = (await (await browser.json("GET", `${API}/tenants/alpha`)).json()) as { sources: unknown[] };
      expect(tenant.sources).toHaveLength(1);
    });

    it("finds the document behind a Swagger UI page, and refuses internal URLs", async () => {
      const browser = await signIn();
      const res = await browser.json("POST", `${API}/tenants/alpha/sources/preview`, { url: "https://api.test/api/v1/docs/swagger-ui/index.html" });
      expect(await res.json()).toMatchObject({ documentUrl: "https://api.test/api/v1/docs", via: "Swagger UI's config", preview: { operations: { total: 148 } } });
      const refused = await browser.json("POST", `${API}/tenants/alpha/sources/preview`, { url: "https://internal.test/openapi.json" });
      expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([422, "fetch_refused"]);
      const junk = await browser.json("POST", `${API}/tenants/alpha/sources/preview`, { document: "not: [an, api" });
      expect([junk.status, ((await junk.json()) as { error: string }).error]).toEqual([422, "invalid_document"]);
      expect((await browser.json("POST", `${API}/tenants/alpha/sources/preview`, { url: "https://api.test/x", document: OPENAPI })).status).toBe(400);
    });

    it("creates a source with its first toolset, and refuses an id that's taken", async () => {
      const browser = await signIn();
      const taken = await browser.json("POST", `${API}/tenants/alpha/sources`, { id: "intervals-icu", document: OPENAPI });
      expect(taken.status).toBe(409);
      const toolsetTaken = await browser.json("POST", `${API}/tenants/alpha/sources`, { id: "half", document: OPENAPI, toolset: { id: "mine", name: "Mine" } });
      expect(toolsetTaken.status).toBe(409);
      expect((await browser.json("GET", `${API}/tenants/alpha/sources/half`)).status).toBe(404);
      const created = await browser.json("POST", `${API}/tenants/alpha/sources`, {
        id: "intervals-live",
        url: "https://api.test/api/v1/docs/swagger-ui/index.html",
        fixedUsernames: { APIKey: "API_KEY" },
        toolset: { id: "live", name: "Live" },
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ source: { id: "intervals-live", operations: 148 }, toolset: { id: "live", endpoint: `${BASE}/mcp/alpha/live` } });
      const view = (await (await browser.json("GET", `${API}/tenants/alpha/sources/intervals-live`)).json()) as {
        documentUrl: string;
        authSchemes: Array<{ id: string; fixedUsername?: string; accepts: string[]; stored: unknown[] }>;
        toolsets: Array<{ id: string }>;
      };
      expect(view.documentUrl).toBe("https://api.test/api/v1/docs");
      expect(view.authSchemes[0]).toMatchObject({ id: "APIKey", fixedUsername: "API_KEY", accepts: ["basic"], stored: [] });
      expect(view.toolsets).toEqual([{ id: "live", name: "Live" }]);
      const toolset = (await (await browser.json("GET", `${API}/tenants/alpha/toolsets/live`)).json()) as { access: unknown[] };
      expect(toolset.access).toEqual([{ userId: alice, label: "alice@example.com", role: "owner", level: "use" }]);
    });

    it("stores, replaces, and removes an API key without ever returning it", async () => {
      const browser = await signIn();
      const url = `${API}/tenants/alpha/sources/intervals-live/credentials/APIKey`;
      const wrong = await browser.json("PUT", url, { credential: { kind: "bearer", token: SECRET } });
      expect(wrong.status).toBe(422);
      const set = await browser.json("PUT", url, { credential: { kind: "basic", password: SECRET } });
      const text = await set.text();
      expect(set.status).toBe(200);
      expect(text).not.toContain(SECRET);
      expect((JSON.parse(text) as { authSchemes: Array<{ stored: unknown[] }> }).authSchemes[0]?.stored).toEqual([{ kind: "basic" }]);
      await browser.json("PUT", url, { credential: { kind: "basic", password: `${SECRET}-2` } });
      const after = (await (await browser.json("GET", `${API}/tenants/alpha/sources/intervals-live`)).json()) as { authSchemes: Array<{ stored: unknown[] }> };
      expect(after.authSchemes[0]?.stored).toHaveLength(1);
      const removed = (await (await browser.json("DELETE", url)).json()) as { authSchemes: Array<{ stored: unknown[] }> };
      expect(removed.authSchemes[0]?.stored).toEqual([]);
      expect((await browser.json("PUT", `${API}/tenants/alpha/sources/intervals-live/credentials/Nope`, { credential: { kind: "basic", password: "x" } })).status).toBe(404);
    });

    it("is for editors only, and caps the body size", async () => {
      const vic_ = await signIn({ sub: "vic", email: "vic@example.com" });
      expect((await vic_.json("POST", `${API}/tenants/alpha/sources/preview`, { document: OPENAPI })).status).toBe(403);
      expect((await vic_.json("POST", `${API}/tenants/alpha/sources`, { id: "x", document: OPENAPI })).status).toBe(403);
      const browser = await signIn();
      const huge = await browser.json("POST", `${API}/tenants/alpha/sources/preview`, { document: "x".repeat(11 * 1024 * 1024) });
      expect(huge.status).toBe(400);
    });
  });

  describe("tool test panel", () => {
    it("runs an unsaved tool with its pins and the stored key, through the runtime", async () => {
      const browser = await signIn();
      const tool = { operationId: "list_wellness_records", name: "list_wellness", description: "Wellness.", pinnedInputs: { id: "0", ext: "" } };
      const run = await browser.json("POST", `${API}/tenants/alpha/toolsets/mine/test`, { tool, args: { oldest: "2026-10-01" } });
      expect(run.status).toBe(200);
      const body = (await run.json()) as { result: { ok: boolean; data: unknown }; tool: { sideEffect: string } };
      expect(body.result, JSON.stringify(body.result)).toMatchObject({ ok: true, data: [{ id: "i1" }] });
      expect(body.tool.sideEffect).toBe("read");
      expect(upstream).toEqual(["https://intervals.icu/api/v1/athlete/0/wellness?oldest=2026-10-01"]);
    });

    it("asks before running a write tool", async () => {
      const browser = await signIn();
      const write = intervalsIr().operations.find((o) => o.sideEffect.class === "write")!;
      const tool = { operationId: write.id, name: "a_write", description: "Writes.", pinnedInputs: {} };
      const unconfirmed = await browser.json("POST", `${API}/tenants/alpha/toolsets/mine/test`, { tool, args: {} });
      expect(unconfirmed.status).toBe(409);
      expect(upstream).toEqual([]);
    });

    it("is for editors only", async () => {
      const vic_ = await signIn({ sub: "vic", email: "vic@example.com" });
      const run = await vic_.json("POST", `${API}/tenants/alpha/toolsets/mine/test`, { tool: starter.tools[0], args: {} });
      expect(run.status).toBe(403);
      expect(upstream).toEqual([]);
    });
  });

  describe("static files", () => {
    it("serves the app shell for client routes, hashed assets for a year, and nothing outside", async () => {
      const browser = new TestBrowser(app);
      const shell = await browser.get(`${BASE}/app/tenants/alpha`);
      expect([shell.status, shell.headers.get("cache-control"), await shell.text()]).toEqual([200, "no-store", "<!doctype html><title>console</title>"]);
      expect(shell.headers.get("content-security-policy")).toContain("script-src 'self'");
      const asset = await browser.get(`${BASE}/app/assets/app-123.js`);
      expect([asset.status, asset.headers.get("content-type"), asset.headers.get("cache-control")]).toEqual([200, "text/javascript; charset=utf-8", "public, max-age=31536000, immutable"]);
      expect((await browser.get(`${BASE}/app/assets/missing.js`)).status).toBe(404);
      for (const path of ["/app/../outside-console.txt", "/app/%2e%2e/outside-console.txt", "/app/..%2Foutside-console.txt"]) {
        const res = await app(new Request(`${BASE}${path}`));
        expect(await res.text()).not.toContain("secret");
      }
      expect((await browser.get(`${BASE}/app`)).headers.get("location")).toBe(`${BASE}/app/`);
      expect((await browser.get(`${BASE}/app/%zz`)).status).toBe(404);
    });
  });
});
