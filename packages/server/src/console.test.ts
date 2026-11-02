// The curation console's server side (D-033) against real Postgres: sign-in
// and sessions, who may edit what, CSRF, editing a toolset and its access,
// the tool test panel, and the static files.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { OidcIdentityProvider } from "@cairnmcp/auth";
import { Toolset, type TenantId, type UserId } from "@cairnmcp/core";
import { addMember, Database, PgVaultStore, putSource, putToolset, setToolsetAccess } from "@cairnmcp/db";
import { intervalsIr, scratchDatabase, testDatabaseUrl, type ScratchDatabase } from "@cairnmcp/db/test-support";
import type { FetchLike } from "@cairnmcp/runtime";
import { LocalKeyWrapper, Vault } from "@cairnmcp/vault";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { FakeOidcProvider, TestBrowser } from "./test-support.ts";

const adminUrl = testDatabaseUrl();
const BASE = "https://cairn.test";
const API = `${BASE}/app/api`;

describe.skipIf(!adminUrl)("curation console (Postgres)", () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let op: FakeOidcProvider;
  let app: (request: Request) => Promise<Response>;
  let alice: UserId; // owner of Alpha
  let carol: UserId; // plain member of Alpha
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
    await db.withTenant(a, (tx) => addMember(tx, carol, "member"));
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

  describe("who may edit", () => {
    it("hides other tenants and stops plain members", async () => {
      const alice_ = await signIn();
      expect((await alice_.json("GET", `${API}/tenants/bravo`)).status).toBe(404);
      expect((await alice_.json("GET", `${API}/tenants/nope`)).status).toBe(404);
      const carol_ = await signIn({ sub: "carol", email: "carol@example.com" });
      expect((await carol_.json("GET", `${API}/tenants/alpha`)).status).toBe(403);
      expect((await carol_.json("PUT", `${API}/tenants/alpha/toolsets/mine`, starter)).status).toBe(403);
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
      const tenant = (await (await browser.json("GET", `${API}/tenants/alpha`)).json()) as { toolsets: unknown[]; members: Array<{ you: boolean }> };
      expect(tenant.toolsets).toEqual([{ id: "mine", name: "My training", sourceId: "intervals-icu", enabledTools: 1, endpoint: `${BASE}/mcp/alpha/mine` }]);
      expect(tenant.members.filter((m) => m.you)).toHaveLength(1);
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
      expect(view.access).toEqual([{ userId: alice, level: "use" }]);
      expect((await browser.json("POST", `${API}/tenants/alpha/toolsets`, { id: "everything", sourceId: "intervals-icu", name: "Again" })).status).toBe(409);
    });

    it("grants and revokes access, and explains an unknown account", async () => {
      const browser = await signIn();
      const dave = await db.ensureUser(op.issuer, "dave");
      const granted = await browser.json("PUT", `${API}/tenants/alpha/toolsets/mine/access`, { userId: dave, level: "use_writes" });
      expect(((await granted.json()) as { access: unknown[] }).access).toContainEqual({ userId: dave, level: "use_writes" });
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
      const view = (await assigned.json()) as { profiles: Array<{ id: string; members: string[] }>; members: Array<{ userId: string; profiles: string[] }> };
      expect(view.profiles).toEqual([expect.objectContaining({ id: "coach", members: [carol] })]);
      expect(view.members.find((m) => m.userId === carol)?.profiles).toEqual(["coach"]);
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

    it("adds someone who has signed in as a member when they get a profile", async () => {
      const browser = await signIn();
      const erin = await db.ensureUser(op.issuer, "erin");
      const added = await browser.json("PUT", `${API}/tenants/alpha/members/${erin}/profiles`, { profiles: ["coach"] });
      expect(added.status).toBe(200);
      expect(((await added.json()) as { members: Array<{ userId: string; role: string; profiles: string[] }> }).members.find((m) => m.userId === erin)).toMatchObject({ role: "member", profiles: ["coach"] });
    });

    it("deletes a profile, and keeps members from editing profiles", async () => {
      const browser = await signIn();
      await browser.json("PUT", `${API}/tenants/alpha/profiles/temp`, { name: "Temp", rules: [] });
      const deleted = await browser.json("DELETE", `${API}/tenants/alpha/profiles/temp`);
      expect(((await deleted.json()) as { profiles: Array<{ id: string }> }).profiles.map((p) => p.id)).not.toContain("temp");
      expect((await browser.json("DELETE", `${API}/tenants/alpha/profiles/temp`)).status).toBe(404);
      const carol_ = await signIn({ sub: "carol", email: "carol@example.com" });
      expect((await carol_.json("PUT", `${API}/tenants/alpha/profiles/mine`, { name: "Mine", rules: [{ toolsetId: "mine", level: "use_writes" }] })).status).toBe(403);
      expect((await carol_.json("GET", `${API}/tenants/alpha/access`)).status).toBe(403);
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
      const carol_ = await signIn({ sub: "carol", email: "carol@example.com" });
      const run = await carol_.json("POST", `${API}/tenants/alpha/toolsets/mine/test`, { tool: starter.tools[0], args: {} });
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
