// Tenant and member isolation against real Postgres, connected as the app role.
// Every test here is about something that must NOT happen.
import { randomBytes } from "node:crypto";
import { canCall, defaultToolset, Toolset, ToolsetId, UserId, type TenantId } from "@cairnmcp/core";
import type { AuditEvent } from "@cairnmcp/runtime";
import { LocalKeyWrapper, Vault } from "@cairnmcp/vault";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "./client.ts";
import {
  addMember,
  getSource,
  getToolset,
  listAuditEvents,
  listSources,
  listToolsets,
  mayCallTool,
  memberRole,
  putSource,
  putToolset,
  setToolsetAccess,
  toolsetAccessLevel,
} from "./repo.ts";
import { auditEvents, credentials, dataKeys, memberships, sources, tenants, toolsetAccess, toolsets, users } from "./schema.ts";
import { PgAuditSink, PgVaultStore } from "./stores.ts";
import { intervalsIr, newTenant, scratchDatabase, testDatabaseUrl, type ScratchDatabase } from "./test-support.ts";

const adminUrl = testDatabaseUrl();
const SECRET = "fake-test-secret-isolation-0123456789";
const SOURCE_ID = "intervals-icu";
const TOOLSET_ID = ToolsetId.parse("mine");

let scratch: ScratchDatabase;
let db: Database;
let vault: Vault;
let a: { tenantId: TenantId; ownerId: UserId };
let b: { tenantId: TenantId; ownerId: UserId };
let aCredentialId: string;
let reader: UserId; // A member with `use`
let outsider: UserId; // A member with no toolset access

const toolset = (): Toolset => defaultToolset(intervalsIr(), { id: TOOLSET_ID, name: "Mine" });

function auditEvent(tenantId: TenantId, actorUserId: UserId, invocationId: string): AuditEvent {
  return {
    invocationId,
    tenantId,
    actorUserId,
    at: "2026-11-01T12:00:00Z" as AuditEvent["at"],
    phase: "intent",
    sourceId: SOURCE_ID,
    toolName: "update_activity",
    operationId: "update_activity",
    sideEffect: "write",
    method: "PUT",
    pathTemplate: "/api/v1/activity/{id}",
    input: { id: "i1" },
  };
}

/** Postgres error code of a rejected promise (42501 permission, 23503 foreign key, ...). */
async function pgError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    let err: unknown = e;
    while (err instanceof Error && !("code" in err) && err.cause) err = err.cause;
    return String((err as { code?: string }).code ?? (err as Error).message);
  }
  throw new Error("expected the database to refuse");
}

describe.skipIf(!adminUrl)("tenant isolation (Postgres, app role)", () => {
  beforeAll(async () => {
    scratch = await scratchDatabase(adminUrl!);
    db = await Database.connect({ url: scratch.appUrl, max: 2 });
    vault = new Vault({ store: new PgVaultStore(db), keyWrapper: new LocalKeyWrapper(randomBytes(32)) });

    a = await newTenant(db, "alpha");
    b = await newTenant(db, "bravo");
    reader = await db.ensureUser("https://issuer.test", "alpha-reader");
    outsider = await db.ensureUser("https://issuer.test", "alpha-outsider");

    // Both tenants have a source and toolset with the same ids; only A has members and a credential.
    for (const t of [a, b]) {
      await db.withTenant(t.tenantId, async (tx) => {
        await putSource(tx, intervalsIr());
        await putToolset(tx, toolset());
        await setToolsetAccess(tx, TOOLSET_ID, t.ownerId, "use_writes");
      });
    }
    await db.withTenant(a.tenantId, async (tx) => {
      await addMember(tx, reader, "member");
      await addMember(tx, outsider, "member");
      await setToolsetAccess(tx, TOOLSET_ID, reader, "use");
    });
    aCredentialId = (await vault.putCredential({ tenantId: a.tenantId, sourceId: SOURCE_ID, schemeId: "APIKey", credential: { kind: "basic", password: SECRET } })).id;
    await new PgAuditSink(db).record(auditEvent(a.tenantId, a.ownerId, "inv-a"));
  });

  afterAll(async () => {
    await db?.close();
    await scratch?.drop();
  });

  describe("without a tenant set", () => {
    it("sees no rows in any tenant table", async () => {
      const db2 = await Database.connect({ url: scratch.appUrl, max: 1 });
      try {
        // A plain transaction with no set_config: reach Drizzle through a throwaway tenant scope and clear it.
        const counts = await db2.withTenant(a.tenantId, async (tx) => {
          await tx.execute(sql`SELECT set_config('app.tenant_id', '', true)`);
          return Promise.all(
            [tenants, memberships, users, sources, toolsets, toolsetAccess, dataKeys, credentials, auditEvents].map(async (t) => (await tx.select().from(t)).length),
          );
        });
        expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
      } finally {
        await db2.close();
      }
    });

    it("can't insert", async () => {
      const code = await pgError(
        db.withTenant(a.tenantId, async (tx) => {
          await tx.execute(sql`SELECT set_config('app.tenant_id', '', true)`);
          await tx.insert(sources).values({ tenantId: a.tenantId, id: "sneaky", name: "x", ir: {} });
        }),
      );
      expect(code).toBe("42501");
    });

    it("doesn't carry a tenant over to the next transaction on the same connection", async () => {
      const db1 = await Database.connect({ url: scratch.appUrl, max: 1 });
      try {
        await db1.withTenant(a.tenantId, async (tx) => expect((await tx.select().from(sources)).length).toBe(1));
        const leaked = await db1.withTenant(b.tenantId, async (tx) => {
          await tx.execute(sql`SELECT set_config('app.tenant_id', '', true)`);
          return (await tx.select().from(sources)).length;
        });
        expect(leaked).toBe(0);
      } finally {
        await db1.close();
      }
    });
  });

  describe("sources and toolsets", () => {
    it("each tenant sees only its own rows", async () => {
      for (const t of [a, b]) {
        const rows = await db.withTenant(t.tenantId, (tx) => tx.select({ tenantId: sources.tenantId }).from(sources));
        expect(rows).toEqual([{ tenantId: t.tenantId }]);
      }
      expect(await db.withTenant(b.tenantId, (tx) => listToolsets(tx))).toHaveLength(1);
    });

    it("can't read another tenant's rows even when filtering by its tenant_id", async () => {
      const rows = await db.withTenant(b.tenantId, (tx) => tx.select().from(sources).where(eq(sources.tenantId, a.tenantId)));
      expect(rows).toEqual([]);
      const ts = await db.withTenant(b.tenantId, (tx) => tx.select().from(toolsets).where(eq(toolsets.tenantId, a.tenantId)));
      expect(ts).toEqual([]);
    });

    it("can't update or delete another tenant's rows", async () => {
      const updated = await db.withTenant(b.tenantId, (tx) =>
        tx.update(sources).set({ name: "hijacked" }).where(eq(sources.tenantId, a.tenantId)).returning(),
      );
      const deleted = await db.withTenant(b.tenantId, (tx) => tx.delete(toolsets).where(eq(toolsets.tenantId, a.tenantId)).returning());
      expect([updated, deleted]).toEqual([[], []]);
      expect((await db.withTenant(a.tenantId, (tx) => getSource(tx, SOURCE_ID)))?.name).toBe(intervalsIr().source.name);
      expect(await db.withTenant(a.tenantId, (tx) => getToolset(tx, TOOLSET_ID))).toBeDefined();
    });

    it("can't move a row into another tenant", async () => {
      const code = await pgError(db.withTenant(b.tenantId, (tx) => tx.update(sources).set({ tenantId: a.tenantId })));
      expect(code).toBe("42501");
    });

    it("can't insert rows for another tenant", async () => {
      const code = await pgError(db.withTenant(b.tenantId, (tx) => tx.insert(sources).values({ tenantId: a.tenantId, id: "planted", name: "x", ir: {} })));
      expect(code).toBe("42501");
      expect(await db.withTenant(a.tenantId, (tx) => listSources(tx))).toHaveLength(1);
    });

    it("can't point a toolset at another tenant's source", async () => {
      await db.withTenant(a.tenantId, (tx) => putSource(tx, { ...intervalsIr(), source: { ...intervalsIr().source, id: "only-in-a" as never } }));
      const code = await pgError(
        db.withTenant(b.tenantId, (tx) => putToolset(tx, { ...toolset(), id: "cross" as ToolsetId, sourceId: "only-in-a" as never, tools: [] })),
      );
      expect(code).toBe("23503");
    });
  });

  describe("credentials", () => {
    it("decrypt for their own tenant only", async () => {
      expect((await vault.credentialsForSource(a.tenantId, SOURCE_ID)).size).toBe(1);
      expect((await vault.credentialsForSource(b.tenantId, SOURCE_ID)).size).toBe(0);
      expect(await vault.getCredential(b.tenantId, aCredentialId)).toBeUndefined();
    });

    it("can't be read, changed, or deleted from another tenant", async () => {
      const read = await db.withTenant(b.tenantId, (tx) => tx.select().from(credentials).where(eq(credentials.id, aCredentialId)));
      const keys = await db.withTenant(b.tenantId, (tx) => tx.select().from(dataKeys).where(eq(dataKeys.tenantId, a.tenantId)));
      const updated = await db.withTenant(b.tenantId, (tx) => tx.update(credentials).set({ ciphertext: "x" }).returning());
      const deleted = await new PgVaultStore(db).deleteCredential(b.tenantId, aCredentialId);
      expect([read, keys, updated, deleted]).toEqual([[], [], [], false]);
      const cred = await vault.getCredential(a.tenantId, aCredentialId);
      expect(cred?.kind === "basic" && cred.password.reveal()).toBe(SECRET);
    });

    it("can't be planted into another tenant", async () => {
      const code = await pgError(
        db.withTenant(b.tenantId, (tx) =>
          tx.insert(credentials).values({ tenantId: a.tenantId, id: "planted", sourceId: SOURCE_ID, schemeId: "APIKey", kind: "basic", iv: "", ciphertext: "", tag: "" }),
        ),
      );
      expect(code).toBe("42501");
    });

    it("are stored encrypted", async () => {
      const rows = await db.withTenant(a.tenantId, (tx) => tx.select().from(credentials));
      expect(JSON.stringify(rows)).not.toContain(SECRET);
    });
  });

  describe("audit log", () => {
    it("is visible to its own tenant only, with the acting user", async () => {
      const own = await db.withTenant(a.tenantId, (tx) => listAuditEvents(tx));
      expect(own).toEqual([auditEvent(a.tenantId, a.ownerId, "inv-a")]);
      expect(await db.withTenant(b.tenantId, (tx) => listAuditEvents(tx))).toEqual([]);
    });

    it("can't be written for another tenant", async () => {
      const code = await pgError(db.withTenant(b.tenantId, (tx) => tx.insert(auditEvents).values(rowOf(auditEvent(a.tenantId, b.ownerId, "planted")))));
      expect(code).toBe("42501");
      expect(await db.withTenant(a.tenantId, (tx) => listAuditEvents(tx, { invocationId: "planted" }))).toEqual([]);
    });

    it("can't be changed or deleted by the app, even in its own tenant", async () => {
      expect(await pgError(db.withTenant(a.tenantId, (tx) => tx.update(auditEvents).set({ toolName: "nothing_to_see" })))).toBe("42501");
      expect(await pgError(db.withTenant(a.tenantId, (tx) => tx.delete(auditEvents)))).toBe("42501");
      expect(await pgError(db.withTenant(a.tenantId, (tx) => tx.execute(sql`TRUNCATE cairnmcp.audit_events`)))).toBe("42501");
    });
  });

  describe("tenants, users, and members", () => {
    it("a tenant sees only itself", async () => {
      const rows = await db.withTenant(a.tenantId, (tx) => tx.select({ id: tenants.id }).from(tenants));
      expect(rows).toEqual([{ id: a.tenantId }]);
    });

    it("users are visible only through membership in the current tenant", async () => {
      const inA = await db.withTenant(a.tenantId, (tx) => tx.select({ id: users.id }).from(users));
      const inB = await db.withTenant(b.tenantId, (tx) => tx.select({ id: users.id }).from(users));
      expect(new Set(inA.map((u) => u.id))).toEqual(new Set([a.ownerId, reader, outsider]));
      expect(inB.map((u) => u.id)).toEqual([b.ownerId]);
    });

    it("find_user and ensure_user resolve one user per issuer and subject", async () => {
      expect(await db.findUser("https://issuer.test", "alpha-reader")).toBe(reader);
      expect(await db.ensureUser("https://issuer.test", "alpha-reader")).toBe(reader);
      expect(await db.findUser("https://other-issuer.test", "alpha-reader")).toBeUndefined();
    });

    it("tenants and users can only be created through the functions", async () => {
      expect(await pgError(db.withTenant(a.tenantId, (tx) => tx.insert(tenants).values({ id: "direct", name: "x" })))).toBe("42501");
      expect(await pgError(db.withTenant(a.tenantId, (tx) => tx.insert(users).values({ issuer: "i", subject: "s" } as never)))).toBe("42501");
    });

    it("can't add a member to another tenant", async () => {
      const code = await pgError(db.withTenant(b.tenantId, (tx) => tx.insert(memberships).values({ tenantId: a.tenantId, userId: b.ownerId, role: "owner" })));
      expect(code).toBe("42501");
      expect(await db.withTenant(a.tenantId, (tx) => memberRole(tx, b.ownerId))).toBeUndefined();
    });

    it("can't grant toolset access to someone who isn't a member", async () => {
      const code = await pgError(db.withTenant(a.tenantId, (tx) => setToolsetAccess(tx, TOOLSET_ID, b.ownerId, "use_writes")));
      expect(code).toBe("23503");
    });

    it("can't read another tenant's toolset access", async () => {
      const rows = await db.withTenant(b.tenantId, (tx) => tx.select().from(toolsetAccess).where(eq(toolsetAccess.tenantId, a.tenantId)));
      expect(rows).toEqual([]);
      expect(await db.withTenant(b.tenantId, (tx) => toolsetAccessLevel(tx, TOOLSET_ID, reader))).toBeUndefined();
    });
  });

  describe("toolset access (D-023)", () => {
    const may = (userId: UserId, sideEffect: "read" | "write" | "destructive", tenantId = a.tenantId) =>
      db.withTenant(tenantId, (tx) => mayCallTool(tx, { toolsetId: TOOLSET_ID, userId, sideEffect }));

    it("a member without access can't use the toolset at all", async () => {
      expect([await may(outsider, "read"), await may(outsider, "write")]).toEqual([false, false]);
    });

    it("a read-only member can call reads but not writes or destructive tools", async () => {
      expect([await may(reader, "read"), await may(reader, "write"), await may(reader, "destructive")]).toEqual([true, false, false]);
    });

    it("a member with use_writes can call everything the toolset enables", async () => {
      expect([await may(a.ownerId, "read"), await may(a.ownerId, "write"), await may(a.ownerId, "destructive")]).toEqual([true, true, true]);
    });

    it("access in one tenant gives nothing in another", async () => {
      expect(await may(a.ownerId, "read", b.tenantId)).toBe(false);
      expect(await may(b.ownerId, "read", a.tenantId)).toBe(false);
    });

    it("revoking access or removing the member takes effect immediately", async () => {
      const temp = await db.ensureUser("https://issuer.test", "alpha-temp");
      await db.withTenant(a.tenantId, async (tx) => {
        await addMember(tx, temp, "member");
        await setToolsetAccess(tx, TOOLSET_ID, temp, "use_writes");
      });
      expect(await may(temp, "write")).toBe(true);
      await db.withTenant(a.tenantId, (tx) => setToolsetAccess(tx, TOOLSET_ID, temp, "use"));
      expect(await may(temp, "write")).toBe(false);
      await db.withTenant(a.tenantId, (tx) => tx.delete(memberships).where(eq(memberships.userId, temp)));
      expect(await may(temp, "read")).toBe(false);
    });

    it("the repo check agrees with canCall", async () => {
      const level = await db.withTenant(a.tenantId, (tx) => toolsetAccessLevel(tx, TOOLSET_ID, reader));
      expect(level).toBe("use");
      expect(canCall(level, "write")).toBe(false);
    });
  });
});

function rowOf(e: AuditEvent): typeof auditEvents.$inferInsert {
  return {
    tenantId: e.tenantId,
    invocationId: e.invocationId,
    actorUserId: e.actorUserId,
    at: new Date(e.at),
    phase: e.phase,
    sourceId: e.sourceId,
    toolName: e.toolName,
    operationId: e.operationId,
    sideEffect: e.sideEffect,
    method: e.method,
    pathTemplate: e.pathTemplate,
    input: e.input,
  };
}
