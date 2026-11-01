// PgVaultStore and PgAuditSink behind the real Vault and Runtime.
import { randomBytes } from "node:crypto";
import { resolveToolset, Toolset, type Caller, type Instant, type TenantId, type UserId } from "@cairnmcp/core";
import { InMemoryRateLimiter, Runtime, type FetchLike } from "@cairnmcp/runtime";
import { LocalKeyWrapper, Vault } from "@cairnmcp/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "./client.ts";
import { listAuditEvents, putSource } from "./repo.ts";
import { PgAuditSink, PgVaultStore } from "./stores.ts";
import { intervalsIr, newTenant, scratchDatabase, testDatabaseUrl, type ScratchDatabase } from "./test-support.ts";

const adminUrl = testDatabaseUrl();
const SECRET = "fake-test-secret-stores-0123456789";
const NOW = "2026-11-01T12:00:00Z" as Instant;

describe.skipIf(!adminUrl)("Postgres stores", () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let tenantId: TenantId;
  let ownerId: UserId;

  beforeAll(async () => {
    scratch = await scratchDatabase(adminUrl!);
    db = await Database.connect({ url: scratch.appUrl });
    ({ tenantId, ownerId } = await newTenant(db, "stores"));
    await db.withTenant(tenantId, (tx) => putSource(tx, intervalsIr()));
  });
  afterAll(async () => {
    await db?.close();
    await scratch?.drop();
  });

  describe("PgVaultStore", () => {
    it("stores, lists, and deletes credentials", async () => {
      const store = new PgVaultStore(db);
      const vault = new Vault({ store, keyWrapper: new LocalKeyWrapper(randomBytes(32)) });
      const { id } = await vault.putCredential({ tenantId, sourceId: "intervals-icu", schemeId: "APIKey", credential: { kind: "basic", password: SECRET } });
      expect(await vault.listCredentials(tenantId, "intervals-icu")).toEqual([{ id, sourceId: "intervals-icu", schemeId: "APIKey", kind: "basic" }]);
      const cred = await vault.getCredential(tenantId, id);
      expect(cred?.kind === "basic" && cred.password.reveal()).toBe(SECRET);
      expect(await vault.deleteCredential(tenantId, id)).toBe(true);
      expect(await vault.deleteCredential(tenantId, id)).toBe(false);
    });

    it("keeps the first data key when two are offered", async () => {
      const store = new PgVaultStore(db);
      const first = await store.getDataKey(tenantId);
      const offered = { keyId: "other", iv: "aaaa", ciphertext: "bbbb", tag: "cccc" };
      expect(await store.putDataKeyIfAbsent(tenantId, offered)).toEqual(first);
    });

    it("re-wraps the data key on KEK rotation without touching credentials", async () => {
      const store = new PgVaultStore(db);
      const oldKek = new LocalKeyWrapper(randomBytes(32));
      const newKek = new LocalKeyWrapper(randomBytes(32));
      const { tenantId: t } = await newTenant(db, "rotation");
      await db.withTenant(t, (tx) => putSource(tx, intervalsIr()));
      const { id } = await new Vault({ store, keyWrapper: oldKek }).putCredential({ tenantId: t, sourceId: "intervals-icu", schemeId: "APIKey", credential: { kind: "bearer", token: SECRET } });
      const rotated = new Vault({ store, keyWrapper: newKek, previousKeyWrappers: [oldKek] });
      await rotated.rotateTenantKey(t);
      expect((await store.getDataKey(t))?.keyId).toBe(newKek.keyId);
      const cred = await new Vault({ store, keyWrapper: newKek }).getCredential(t, id);
      expect(cred?.kind === "bearer" && cred.token.reveal()).toBe(SECRET);
    });

    it("refuses to replace a data key that doesn't exist", async () => {
      const { tenantId: t } = await newTenant(db, "no-key");
      await expect(new PgVaultStore(db).replaceDataKey(t, { keyId: "k", iv: "", ciphertext: "", tag: "" })).rejects.toThrow(/no data key/);
    });
  });

  describe("PgAuditSink with the runtime", () => {
    it("records intent and outcome of a write, with the acting user", async () => {
      const ir = intervalsIr();
      const resolved = resolveToolset(
        Toolset.parse({ id: "w", sourceId: "intervals-icu", name: "W", tools: [{ operationId: "update_activity", name: "update_activity", description: "Update." }] }),
        ir,
      );
      if (!resolved.ok) throw new Error("toolset failed to resolve");
      const source = { ...ir.source, authSchemes: ir.source.authSchemes.map((s) => (s.type === "http_basic" ? { ...s, fixedUsername: "API_KEY" } : s)) };
      const vault = new Vault({ store: new PgVaultStore(db), keyWrapper: new LocalKeyWrapper(randomBytes(32)) });
      const { tenantId: t, ownerId: actor } = await newTenant(db, "audit");
      await db.withTenant(t, (tx) => putSource(tx, ir));
      await vault.putCredential({ tenantId: t, sourceId: "intervals-icu", schemeId: "APIKey", credential: { kind: "basic", password: SECRET } });

      const fetch: FetchLike = async () => new Response(JSON.stringify({ id: "i1" }), { status: 200, headers: { "content-type": "application/json" } });
      const runtime = new Runtime({ fetch, credentials: vault, limiter: new InMemoryRateLimiter(), audit: new PgAuditSink(db), now: () => NOW, newId: () => "inv-1" });
      const caller: Caller = { userId: actor, claims: { sub: "audit-owner" } };
      const result = await runtime.invoke({ tenantId: t, caller, source, tool: resolved.tools[0]!, args: { id: "i1", body: { name: "Ride" } } });
      expect(result.ok).toBe(true);

      const events = await db.withTenant(t, (tx) => listAuditEvents(tx));
      expect(events.map((e) => [e.phase, e.actorUserId, e.at, e.outcome])).toEqual([
        ["intent", actor, NOW, undefined],
        ["outcome", actor, NOW, { ok: true, status: 200 }],
      ]);
      expect(JSON.stringify(events)).not.toContain(SECRET);
      expect(ownerId).not.toBe(actor);
    });

    it("fails closed: an audit row for an unknown user is rejected, so the write isn't sent", async () => {
      let sent = 0;
      const fetch: FetchLike = async () => (sent++, new Response("{}", { status: 200 }));
      const ir = intervalsIr();
      const resolved = resolveToolset(
        Toolset.parse({ id: "w", sourceId: "intervals-icu", name: "W", tools: [{ operationId: "update_activity", name: "update_activity", description: "Update." }] }),
        ir,
      );
      if (!resolved.ok) throw new Error("toolset failed to resolve");
      const runtime = new Runtime({
        fetch,
        credentials: { credentialsForSource: async () => new Map() },
        limiter: new InMemoryRateLimiter(),
        audit: new PgAuditSink(db),
      });
      const caller: Caller = { userId: "no-such-user" as UserId, claims: {} };
      const result = await runtime.invoke({ tenantId, caller, source: { ...ir.source, defaultAuth: [] }, tool: { ...resolved.tools[0]!, operation: { ...resolved.tools[0]!.operation, auth: [] } }, args: { id: "i1", body: {} } });
      expect(result).toMatchObject({ ok: false, error: { kind: "audit_failed" } });
      expect(sent).toBe(0);
    });
  });
});
