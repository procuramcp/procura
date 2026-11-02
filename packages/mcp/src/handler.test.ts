// The MCP endpoint end to end: real Postgres (as the app role), real vault and
// runtime, the MCP SDK client, a local token issuer, and a fake upstream.
import { randomBytes } from "node:crypto";
import { AccessProfile, Toolset, type IrDocument, type TenantId, type UserId } from "@cairnmcp/core";
import { addMember, Database, listAuditEvents, PgAuditSink, PgVaultStore, putProfile, putSource, putToolset, setMemberProfiles, setToolsetAccess } from "@cairnmcp/db";
import { intervalsIr, newTenant, scratchDatabase, testDatabaseUrl, type ScratchDatabase } from "@cairnmcp/db/test-support";
import { InMemoryRateLimiter, Runtime, type FetchLike } from "@cairnmcp/runtime";
import { LocalKeyWrapper, Vault } from "@cairnmcp/vault";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ToolsetCache } from "./cache.ts";
import { createMcpHandler } from "./handler.ts";
import { TokenVerifier } from "./token.ts";

const adminUrl = testDatabaseUrl();
const BASE = "https://cairn.test";
const ISSUER = "https://issuer.test"; // newTenant() creates owners under this issuer
const API_KEY = "fake-test-api-key-mcp-0123456789";

describe.skipIf(!adminUrl)("MCP endpoint (Postgres)", () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let handler: (request: Request) => Promise<Response>;
  let signToken: (subject: string, audience: string, issuer?: string) => Promise<string>;
  let upstreamCalls: Array<{ url: string; method: string; headers: Record<string, string> }>;
  let a: { tenantId: TenantId; ownerId: UserId };
  let b: { tenantId: TenantId; ownerId: UserId };
  let reader: UserId;
  let toolset: Toolset;
  const cache = new ToolsetCache();

  const resource = (tenantId: string, toolsetId = "mine") => `${BASE}/mcp/${tenantId}/${toolsetId}`;

  /** An MCP client for `subject`, with a token for `audience` (default: the endpoint it connects to). */
  async function connect(subject: string, endpoint: string, audience = endpoint): Promise<Client> {
    const token = await signToken(subject, audience);
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: (url, init) => handler(new Request(url, init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    // The SDK's own classes disagree under exactOptionalPropertyTypes (sessionId?: string vs string | undefined).
    await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
    return client;
  }

  const post = (url: string, headers: Record<string, string> = {}) =>
    handler(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

  beforeAll(async () => {
    scratch = await scratchDatabase(adminUrl!);
    db = await Database.connect({ url: scratch.appUrl, max: 4 });

    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" }] });
    signToken = (subject, audience, issuer = ISSUER) =>
      new SignJWT({ scope: "mcp" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(issuer).setSubject(subject).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);

    a = await newTenant(db, "alpha");
    b = await newTenant(db, "bravo");
    reader = await db.ensureUser(ISSUER, "alpha-reader");
    const outsider = await db.ensureUser(ISSUER, "alpha-outsider");

    // Curation the UI will do for Intervals.icu: the basic-auth username is the literal API_KEY.
    const base = intervalsIr();
    const ir: IrDocument = {
      ...base,
      source: { ...base.source, authSchemes: base.source.authSchemes.map((s) => (s.type === "http_basic" ? { ...s, fixedUsername: "API_KEY" } : s)) },
    };
    toolset = Toolset.parse({
      id: "mine",
      sourceId: "intervals-icu",
      name: "My training",
      tools: [
        { operationId: "list_activities", name: "list_activities", description: "List my activities.", pinnedInputs: { id: "0" } },
        { operationId: "update_activity", name: "update_activity", description: "Update one of my activities." },
      ],
    });
    for (const t of [a, b]) {
      await db.withTenant(t.tenantId, async (tx) => {
        await putSource(tx, ir);
        await putToolset(tx, toolset);
        await setToolsetAccess(tx, toolset.id, t.ownerId, "use_writes");
      });
    }
    await db.withTenant(a.tenantId, async (tx) => {
      await addMember(tx, reader, "member");
      await addMember(tx, outsider, "member");
      await setToolsetAccess(tx, toolset.id, reader, "use");
    });

    const vault = new Vault({ store: new PgVaultStore(db), keyWrapper: new LocalKeyWrapper(randomBytes(32)) });
    await vault.putCredential({ tenantId: a.tenantId, sourceId: "intervals-icu", schemeId: "APIKey", credential: { kind: "basic", password: API_KEY } });

    const fetch: FetchLike = async (url, init) => {
      upstreamCalls.push({ url, method: init.method, headers: init.headers });
      const body = init.method === "GET" ? [{ id: "i1", type: "Ride" }] : { id: "i1", name: "Updated" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const runtime = new Runtime({ fetch, credentials: vault, limiter: new InMemoryRateLimiter(), audit: new PgAuditSink(db) });
    handler = createMcpHandler({
      db,
      runtime,
      publicUrl: BASE,
      cache,
      verifier: new TokenVerifier([{ issuer: ISSUER, jwksUri: `${ISSUER}/jwks` }], new Map([[ISSUER, jwks]])),
    });
  });

  beforeEach(() => {
    upstreamCalls = [];
  });

  afterAll(async () => {
    await db?.close();
    await scratch?.drop();
  });

  describe("authentication", () => {
    it("asks for a token and points to the resource metadata", async () => {
      const response = await post(resource(a.tenantId));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp/${a.tenantId}/mine"`);
    });

    it("publishes protected-resource metadata naming the trusted issuers", async () => {
      const response = await handler(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp/${a.tenantId}/mine`));
      expect(await response.json()).toEqual({
        resource: resource(a.tenantId),
        authorization_servers: [ISSUER],
        bearer_methods_supported: ["header"],
        scopes_supported: ["mcp"],
        resource_name: "cairnmcp",
      });
    });

    it("rejects a token issued for another endpoint", async () => {
      const token = await signToken("alpha-owner", resource(a.tenantId, "other"));
      const response = await post(resource(a.tenantId), { authorization: `Bearer ${token}` });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain('error="invalid_token", error_description="token is not for this resource"');
    });

    it("rejects a token from an untrusted issuer", async () => {
      const token = await signToken("alpha-owner", resource(a.tenantId), "https://evil.test");
      expect((await post(resource(a.tenantId), { authorization: `Bearer ${token}` })).status).toBe(401);
    });

    it("refuses requests from browser origins that aren't allowed", async () => {
      const token = await signToken("alpha-owner", resource(a.tenantId));
      expect((await post(resource(a.tenantId), { authorization: `Bearer ${token}`, origin: "https://evil.test" })).status).toBe(403);
    });

    it("serves only POST (stateless, JSON responses)", async () => {
      expect((await handler(new Request(resource(a.tenantId)))).status).toBe(405);
    });
  });

  describe("tenant and toolset access", () => {
    it("refuses an unknown user", async () => {
      const token = await signToken("nobody", resource(a.tenantId));
      expect((await post(resource(a.tenantId), { authorization: `Bearer ${token}` })).status).toBe(403);
    });

    it("refuses another tenant's member, even with a token for this endpoint", async () => {
      const token = await signToken("bravo-owner", resource(a.tenantId));
      const response = await post(resource(a.tenantId), { authorization: `Bearer ${token}` });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error_description: "you are not a member of this tenant" });
    });

    it("answers the same for a tenant that doesn't exist", async () => {
      const token = await signToken("alpha-owner", resource("no-such-tenant"));
      expect((await post(resource("no-such-tenant"), { authorization: `Bearer ${token}` })).status).toBe(403);
    });

    it("refuses a member without access to the toolset", async () => {
      const token = await signToken("alpha-outsider", resource(a.tenantId));
      const response = await post(resource(a.tenantId), { authorization: `Bearer ${token}` });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error_description: "you don't have access to this toolset" });
    });

    it("says not found for a member asking for a toolset that doesn't exist", async () => {
      const token = await signToken("alpha-owner", resource(a.tenantId, "nope"));
      expect((await post(resource(a.tenantId, "nope"), { authorization: `Bearer ${token}` })).status).toBe(404);
    });
  });

  describe("read-only member", () => {
    it("sees only read tools", async () => {
      const client = await connect("alpha-reader", resource(a.tenantId));
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["list_activities"]);
      expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true });
      // Pinned inputs are hidden from the agent.
      expect(Object.keys((tools[0]?.inputSchema.properties ?? {}) as object)).not.toContain("id");
      await client.close();
    });

    it("can call a read tool, with the tenant's credentials and pinned inputs", async () => {
      const client = await connect("alpha-reader", resource(a.tenantId));
      const result = await client.callTool({ name: "list_activities", arguments: { oldest: "2026-10-25" } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ result: [{ id: "i1", type: "Ride" }] });
      expect(upstreamCalls).toHaveLength(1);
      expect(upstreamCalls[0]?.url).toContain("/athlete/0/activities");
      expect(upstreamCalls[0]?.headers["authorization"]).toBe(`Basic ${Buffer.from(`API_KEY:${API_KEY}`).toString("base64")}`);
      expect(JSON.stringify(result)).not.toContain(API_KEY);
      await client.close();
    });

    it("can't call a write tool even knowing its name", async () => {
      const client = await connect("alpha-reader", resource(a.tenantId));
      await expect(client.callTool({ name: "update_activity", arguments: { id: "i1", body: { name: "x" } } })).rejects.toThrow(/Unknown tool: update_activity/);
      expect(upstreamCalls).toEqual([]);
      await client.close();
    });
  });

  describe("member with use_writes", () => {
    it("sees and calls write tools, and the audit log records who", async () => {
      const client = await connect("alpha-owner", resource(a.tenantId));
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["list_activities", "update_activity"]);
      const result = await client.callTool({ name: "update_activity", arguments: { id: "i1", body: { name: "Updated" } } });
      expect(result.structuredContent).toEqual({ id: "i1", name: "Updated" });
      expect(upstreamCalls.map((c) => c.method)).toEqual(["PUT"]);
      const audit = await db.withTenant(a.tenantId, (tx) => listAuditEvents(tx));
      expect(audit.map((e) => [e.phase, e.toolName, e.actorUserId])).toEqual([
        ["intent", "update_activity", a.ownerId],
        ["outcome", "update_activity", a.ownerId],
      ]);
      await client.close();
    });

    it("gets the runtime's errors as tool results", async () => {
      // Tenant B has no stored credential.
      const client = await connect("bravo-owner", resource(b.tenantId));
      const result = await client.callTool({ name: "list_activities", arguments: { oldest: "2026-10-25" } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { kind: "missing_credentials", retryable: false } });
      expect(upstreamCalls).toEqual([]);
      await client.close();
    });
  });

  describe("changes take effect on the next request", () => {
    it("serves a toolset edit on the next request, while reusing the resolved toolset in between", async () => {
      const client = await connect("bravo-owner", resource(b.tenantId));
      expect((await client.listTools()).tools).toHaveLength(2);
      const cachedBefore = cache.size;
      expect((await client.listTools()).tools).toHaveLength(2);
      expect(cache.size).toBe(cachedBefore);

      const edited = Toolset.parse({ ...toolset, tools: toolset.tools.map((t) => (t.name === "update_activity" ? { ...t, enabled: false } : { ...t, description: "Edited." })) });
      await db.withTenant(b.tenantId, (tx) => putToolset(tx, edited));
      const tools = (await client.listTools()).tools;
      expect(tools.map((t) => [t.name, t.description])).toEqual([["list_activities", "Edited."]]);

      await db.withTenant(b.tenantId, (tx) => putToolset(tx, toolset));
      expect((await client.listTools()).tools).toHaveLength(2);
      await client.close();
    });

    it("downgrading access hides and blocks write tools immediately", async () => {
      const temp = await db.ensureUser(ISSUER, "alpha-temp");
      await db.withTenant(a.tenantId, async (tx) => {
        await addMember(tx, temp, "member");
        await setToolsetAccess(tx, "mine" as never, temp, "use_writes");
      });
      const client = await connect("alpha-temp", resource(a.tenantId));
      expect((await client.listTools()).tools).toHaveLength(2);

      await db.withTenant(a.tenantId, (tx) => setToolsetAccess(tx, "mine" as never, temp, "use"));
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["list_activities"]);
      await expect(client.callTool({ name: "update_activity", arguments: { id: "i1", body: {} } })).rejects.toThrow(/Unknown tool/);

      await db.withTenant(a.tenantId, (tx) => setToolsetAccess(tx, "mine" as never, temp, undefined));
      await expect(client.listTools()).rejects.toThrow();
      await client.close();
    });
  });

  describe("access profiles (D-034)", () => {
    it("a member with only a profile sees and calls exactly what it allows, and edits apply on the next request", async () => {
      const coach = await db.ensureUser(ISSUER, "alpha-coach");
      const profile = (operations: string[] | null) =>
        AccessProfile.parse({ id: "coach", name: "Coach", rules: [{ toolsetId: "mine", level: "use_writes", operations }] });
      await db.withTenant(a.tenantId, async (tx) => {
        await addMember(tx, coach, "member");
        await putProfile(tx, profile(["update_activity"]));
        await setMemberProfiles(tx, coach, ["coach"]);
      });
      const client = await connect("alpha-coach", resource(a.tenantId));
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["update_activity"]);
      await expect(client.callTool({ name: "list_activities", arguments: { oldest: "2026-10-25" } })).rejects.toThrow(/Unknown tool/);
      const result = await client.callTool({ name: "update_activity", arguments: { id: "i1", body: { name: "x" } } });
      expect(result.isError).toBeFalsy();

      await db.withTenant(a.tenantId, (tx) => putProfile(tx, profile(null)));
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["list_activities", "update_activity"]);

      await db.withTenant(a.tenantId, (tx) => setMemberProfiles(tx, coach, []));
      await expect(client.listTools()).rejects.toThrow();
      await client.close();
    });
  });
});
