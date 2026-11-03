// The admin commands against real Postgres (as the app role), then the result
// through the MCP endpoint: after setup, the owner's MCP client sees the tools
// and calls go out with the curated pins and the stored credential.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { Database, PgAuditSink, PgVaultStore, schema } from "@procura/db";
import { scratchDatabase, testDatabaseUrl, type ScratchDatabase } from "@procura/db/test-support";
import { createMcpHandler, TokenVerifier } from "@procura/mcp";
import { InMemoryRateLimiter, Runtime, type FetchLike } from "@procura/runtime";
import { LocalKeyWrapper, Vault } from "@procura/vault";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminError, addSource, createTenant, grantAccess, putToolsetFor, setCredential, showTenant } from "./admin.ts";

const adminUrl = testDatabaseUrl();
const ISSUER = "https://accounts.test";
const BASE = "https://procura.test";
const SECRET = "fake-intervals-api-key-0123456789";
const openapi = readFileSync(new URL("../../ingest/fixtures/intervals-icu/openapi.json", import.meta.url), "utf8");
const starter = JSON.parse(readFileSync(new URL("../../../examples/intervals-icu/toolset.json", import.meta.url), "utf8")) as unknown;
const cli = new URL("../scripts/admin.ts", import.meta.url).pathname;
const run = promisify(execFile);

describe.skipIf(!adminUrl)("admin commands (Postgres)", () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let vault: Vault;
  let masterKey: string;
  let owner: string;

  beforeAll(async () => {
    scratch = await scratchDatabase(adminUrl!);
    db = await Database.connect({ url: scratch.appUrl, max: 4 });
    masterKey = randomBytes(32).toString("base64");
    vault = new Vault({ store: new PgVaultStore(db), keyWrapper: new LocalKeyWrapper(Buffer.from(masterKey, "base64")) });
    owner = await db.ensureUser(ISSUER, "owner"); // what signing in once does
  });
  afterAll(async () => {
    await db?.close();
    await scratch?.drop();
  });

  describe("each command", () => {
    it("creates a tenant with a readable id, and explains a missing user", async () => {
      expect(await createTenant(db, { name: "Me", ownerUserId: owner, id: "me" })).toBe("me");
      await expect(createTenant(db, { name: "Again", ownerUserId: owner, id: "me" })).rejects.toThrow(/already exists/);
      await expect(createTenant(db, { name: "X", ownerUserId: "no-such-user", id: "x" })).rejects.toThrow(/sign in once first/);
      await expect(createTenant(db, { name: "X", ownerUserId: owner, id: "Bad Id!" })).rejects.toThrow(AdminError);
    });

    it("adds a source from OpenAPI, with curated fixed usernames", async () => {
      const s = await addSource(db, { tenantId: "me", sourceId: "intervals-icu", openapi, fixedUsernames: { APIKey: "API_KEY" } });
      expect(s).toMatchObject({ id: "intervals-icu", operations: 148, reads: 79, authSchemes: ["APIKey", "AccessToken"] });
      await expect(addSource(db, { tenantId: "me", sourceId: "intervals-icu", openapi, fixedUsernames: { AccessToken: "x" } })).rejects.toThrow(/isn't a basic-auth scheme/);
      await expect(addSource(db, { tenantId: "me", sourceId: "x", openapi: "not: [an, api" })).rejects.toThrow(/didn't map/);
    });

    it("stores a curated toolset, a default one, and refuses one that doesn't fit", async () => {
      const t = await putToolsetFor(db, { tenantId: "me", sourceId: "intervals-icu", toolsetId: "intervals", definition: starter });
      expect(t.enabled).toEqual(["list_activities", "search_activities", "get_activity", "get_activity_streams", "list_wellness", "list_calendar", "get_profile", "get_training_summary"]);
      const all = await putToolsetFor(db, { tenantId: "me", sourceId: "intervals-icu", toolsetId: "everything" });
      expect([all.enabled.length, all.disabled]).toEqual([79, 69]); // reads only (D-016)
      await expect(
        putToolsetFor(db, { tenantId: "me", sourceId: "intervals-icu", toolsetId: "bad", definition: { name: "Bad", tools: [{ operationId: "no_such_op", name: "nope", description: "x" }] } }),
      ).rejects.toThrow(/doesn't fit the source/);
      await expect(putToolsetFor(db, { tenantId: "me", sourceId: "nope", toolsetId: "t" })).rejects.toThrow(/no source nope/);
    });

    it("grants access, adding a member when needed, and revokes it", async () => {
      expect(await grantAccess(db, { tenantId: "me", toolsetId: "intervals", userId: owner, level: "use" })).toEqual({ addedMember: false });
      const friend = await db.ensureUser(ISSUER, "friend");
      expect(await grantAccess(db, { tenantId: "me", toolsetId: "everything", userId: friend, level: "use" })).toEqual({ addedMember: true });
      await grantAccess(db, { tenantId: "me", toolsetId: "everything", userId: friend, level: "none" });
      await expect(grantAccess(db, { tenantId: "me", toolsetId: "intervals", userId: "ghost", level: "use" })).rejects.toThrow(/sign in once first/);
      await expect(grantAccess(db, { tenantId: "me", toolsetId: "nope", userId: owner, level: "use" })).rejects.toThrow(/no toolset/);
    });

    it("replaces a credential for the same scheme", async () => {
      expect((await setCredential(vault, { tenantId: "me", sourceId: "intervals-icu", schemeId: "APIKey", credential: { kind: "basic", password: "old-fake-key-0000" } })).replaced).toBe(0);
      expect((await setCredential(vault, { tenantId: "me", sourceId: "intervals-icu", schemeId: "APIKey", credential: { kind: "basic", password: SECRET } })).replaced).toBe(1);
      const creds = await vault.credentialsForSource("me" as never, "intervals-icu");
      const c = creds.get("APIKey");
      expect([creds.size, c?.kind === "basic" && c.password.reveal()]).toEqual([1, SECRET]);
    });

    it("shows the tenant without secrets", async () => {
      const overview = await showTenant(db, vault, "me");
      expect(overview.tenant).toEqual({ id: "me", name: "Me" });
      expect(overview.toolsets.find((t) => t.id === "intervals")).toMatchObject({ enabledTools: 8, access: [{ userId: owner, level: "use" }] });
      expect(overview.credentials).toEqual([{ sourceId: "intervals-icu", schemeId: "APIKey", kind: "basic" }]);
      expect(JSON.stringify(overview)).not.toContain(SECRET);
    });
  });

  describe("the CLI (as admin.sh runs it)", () => {
    const exec = (args: string[], input?: string) => {
      const env = { ...process.env, PROCURA_DATABASE_URL: scratch.appUrl, PROCURA_MASTER_KEY: masterKey, PROCURA_PUBLIC_URL: BASE };
      const child = run(process.execPath, [cli, ...args], { env });
      // A command that exits on bad arguments doesn't read stdin: ignore the closed pipe.
      child.child.stdin!.on("error", () => {});
      if (input !== undefined) child.child.stdin!.end(input);
      else child.child.stdin!.end();
      return child.then(
        (r) => ({ code: 0, out: r.stdout, err: r.stderr }),
        (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout, err: e.stderr }),
      );
    };

    it("sets up a second tenant end to end, reading files and the secret from stdin", async () => {
      expect((await exec(["tenant", "create", "--name", "Club", "--owner", owner, "--id", "club"])).out).toContain("Created tenant club");
      expect((await exec(["source", "add", "--tenant", "club", "--id", "intervals-icu", "--fixed-username", "APIKey=API_KEY"], openapi)).out).toContain("148 operations");
      const put = await exec(["toolset", "put", "--tenant", "club", "--source", "intervals-icu", "--id", "intervals", "--definition"], JSON.stringify(starter));
      expect(put.out).toContain(`MCP endpoint: ${BASE}/mcp/club/intervals`);
      expect((await exec(["access", "grant", "--tenant", "club", "--toolset", "intervals", "--user", owner, "--level", "use"])).out).toContain("Granted use");
      const cred = await exec(["credential", "set", "--tenant", "club", "--source", "intervals-icu", "--scheme", "APIKey", "--kind", "basic"], `${SECRET}\n`);
      expect(cred.out).toContain("The secret was not printed");
      expect(cred.out + cred.err).not.toContain(SECRET);
      const show = await exec(["tenant", "show", "--tenant", "club"]);
      expect(JSON.parse(show.out).credentials).toEqual([{ sourceId: "intervals-icu", schemeId: "APIKey", kind: "basic" }]);
      expect(show.out).not.toContain(SECRET);
    });

    it("updates a source from a new document, a dry run first, and restores the kept version (D-048, D-049)", async () => {
      const doc = JSON.parse(openapi) as { paths: Record<string, unknown> };
      const gone = Object.keys(doc.paths).find((p) => p.includes("/gear"))!;
      delete doc.paths[gone];
      const v2 = JSON.stringify(doc);
      const update = (args: string[], input?: string) => exec(["source", "update", "--tenant", "club", "--id", "intervals-icu", ...args], input);

      const dry = await update(["--stdin"], v2);
      expect(dry).toMatchObject({ code: 0 });
      expect(dry.out).toContain("removed");
      expect(dry.out).toContain("Dry run");
      expect(JSON.parse((await exec(["tenant", "show", "--tenant", "club"])).out).sources[0].operations).toBe(148);

      const applied = await update(["--stdin", "--apply"], v2);
      expect(applied.out).toContain("the previous version is kept as 1");
      const shown = JSON.parse((await exec(["tenant", "show", "--tenant", "club"])).out).sources[0];
      expect(shown).toMatchObject({ versions: [{ version: 1, operations: 148 }] });
      // Text from stdin may not be what the API publishes, so it doesn't count as a check.
      expect(shown.check).toBeUndefined();
      expect(shown.operations).toBeLessThan(148);

      expect((await update(["--version", "1", "--apply"])).out).toContain("kept as 2");
      expect((await update(["--stdin"], openapi)).out).toContain("Already up to date");
      // Added from pasted text, so there's no URL to fetch: says what to give.
      expect(await update([])).toMatchObject({ code: 1, err: expect.stringContaining("give a URL or the new document") });
      expect(await update(["--version", "x"])).toMatchObject({ code: 1, err: expect.stringContaining("--version") });
      expect(await update(["--version", "1", "--stdin"], v2)).toMatchObject({ code: 1, err: expect.stringContaining("give one of") });
    });

    it("explains mistakes instead of crashing", async () => {
      expect(await exec(["tenant", "create", "--name", "X"])).toMatchObject({ code: 1, err: expect.stringContaining("missing --owner") });
      expect(await exec(["source", "add", "--tenant", "club", "--id", "x"], "")).toMatchObject({ code: 1, err: expect.stringContaining("was empty") });
      expect((await exec(["frobnicate"])).code).toBe(2);
    });
  });

  describe("the result through the MCP endpoint", () => {
    it("the owner's client sees the starter tools, and calls carry the pins and the stored key", async () => {
      const calls: string[] = [];
      let authorization = "";
      const fetch: FetchLike = async (url, init) => {
        calls.push(url);
        authorization = init.headers["authorization"] ?? "";
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      };
      const { privateKey, publicKey } = await generateKeyPair("ES256");
      const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" }] });
      const handler = createMcpHandler({
        db,
        publicUrl: BASE,
        runtime: new Runtime({ fetch, credentials: vault, limiter: new InMemoryRateLimiter(), audit: new PgAuditSink(db) }),
        verifier: new TokenVerifier([{ issuer: ISSUER, jwksUri: `${ISSUER}/jwks` }], new Map([[ISSUER, jwks]])),
      });
      const endpoint = `${BASE}/mcp/me/intervals`;
      const token = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "k" }).setIssuer(ISSUER).setSubject("owner").setAudience(endpoint).setExpirationTime("5m").sign(privateKey);
      const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
        fetch: (u, i) => handler(new Request(u, i)),
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      const client = new Client({ name: "t", version: "0" });
      // The SDK's own classes disagree under exactOptionalPropertyTypes (sessionId?: string vs string | undefined).
      await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);

      const { tools } = await client.listTools();
      expect(tools).toHaveLength(8);
      expect(Object.keys(tools.find((t) => t.name === "list_wellness")!.inputSchema.properties ?? {})).not.toContain("id");

      await client.callTool({ name: "list_wellness", arguments: { oldest: "2026-10-01" } });
      await client.callTool({ name: "list_activities", arguments: { oldest: "2026-10-01", limit: 5 } });
      expect(calls[0]).toMatch(/^https:\/\/intervals\.icu\/api\/v1\/athlete\/0\/wellness\?oldest=2026-10-01$/);
      expect(calls[1]).toContain("/api/v1/athlete/0/activities?");
      expect(authorization).toBe(`Basic ${Buffer.from(`API_KEY:${SECRET}`).toString("base64")}`);
      await client.close();

      // Nothing secret reached the database in plain text.
      const rows = await db.withTenant("me" as never, (tx) => tx.select().from(schema.credentials));
      expect(JSON.stringify(rows)).not.toContain(SECRET);
    });
  });
});
