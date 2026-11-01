import { TenantId } from "@cairnmcp/core";
import type { AuditEvent, AuditSink } from "@cairnmcp/runtime";
import type { CredentialRecord, VaultStore, WrappedKey } from "@cairnmcp/vault";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { auditEvents, credentials, dataKeys } from "./schema.ts";

/**
 * Vault storage in Postgres. Each call runs in its own tenant-scoped
 * transaction, so row-level security backs up the explicit tenant filter.
 */
export class PgVaultStore implements VaultStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async getDataKey(tenantId: TenantId): Promise<WrappedKey | undefined> {
    return this.#db.withTenant(tenantId, async (tx) => {
      const [row] = await tx.select().from(dataKeys).where(eq(dataKeys.tenantId, tenantId));
      return row ? { keyId: row.keyId, iv: row.iv, ciphertext: row.ciphertext, tag: row.tag } : undefined;
    });
  }

  async putDataKeyIfAbsent(tenantId: TenantId, key: WrappedKey): Promise<WrappedKey> {
    return this.#db.withTenant(tenantId, async (tx) => {
      await tx.insert(dataKeys).values({ tenantId, ...wrappedKey(key) }).onConflictDoNothing({ target: dataKeys.tenantId });
      const [row] = await tx.select().from(dataKeys).where(eq(dataKeys.tenantId, tenantId));
      if (!row) throw new Error("data key insert was not visible");
      return { keyId: row.keyId, iv: row.iv, ciphertext: row.ciphertext, tag: row.tag };
    });
  }

  async replaceDataKey(tenantId: TenantId, key: WrappedKey): Promise<void> {
    await this.#db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .update(dataKeys)
        .set({ ...wrappedKey(key), updatedAt: sql`now()` })
        .where(eq(dataKeys.tenantId, tenantId))
        .returning({ tenantId: dataKeys.tenantId });
      if (rows.length === 0) throw new Error("no data key to replace");
    });
  }

  async putCredential(record: CredentialRecord): Promise<void> {
    const values = {
      sourceId: record.sourceId,
      schemeId: record.schemeId,
      kind: record.kind,
      iv: record.sealed.iv,
      ciphertext: record.sealed.ciphertext,
      tag: record.sealed.tag,
    };
    await this.#db.withTenant(record.tenantId, async (tx) => {
      await tx
        .insert(credentials)
        .values({ tenantId: record.tenantId, id: record.id, ...values })
        .onConflictDoUpdate({ target: [credentials.tenantId, credentials.id], set: values });
    });
  }

  async getCredential(tenantId: TenantId, id: string): Promise<CredentialRecord | undefined> {
    return this.#db.withTenant(tenantId, async (tx) => {
      const [row] = await tx.select().from(credentials).where(and(eq(credentials.tenantId, tenantId), eq(credentials.id, id)));
      return row ? toRecord(row) : undefined;
    });
  }

  async listCredentials(tenantId: TenantId, sourceId?: string): Promise<CredentialRecord[]> {
    return this.#db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(credentials)
        .where(and(eq(credentials.tenantId, tenantId), sourceId === undefined ? undefined : eq(credentials.sourceId, sourceId)))
        .orderBy(credentials.createdAt, credentials.id);
      return rows.map(toRecord);
    });
  }

  async deleteCredential(tenantId: TenantId, id: string): Promise<boolean> {
    return this.#db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .delete(credentials)
        .where(and(eq(credentials.tenantId, tenantId), eq(credentials.id, id)))
        .returning({ id: credentials.id });
      return rows.length > 0;
    });
  }
}

/** Audit log in Postgres. Resolves only after the row is committed. */
export class PgAuditSink implements AuditSink {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async record(event: AuditEvent): Promise<void> {
    await this.#db.withTenant(event.tenantId, async (tx) => {
      await tx.insert(auditEvents).values({
        tenantId: event.tenantId,
        invocationId: event.invocationId,
        actorUserId: event.actorUserId,
        at: new Date(event.at),
        phase: event.phase,
        sourceId: event.sourceId,
        toolName: event.toolName,
        operationId: event.operationId,
        sideEffect: event.sideEffect,
        method: event.method,
        pathTemplate: event.pathTemplate,
        input: event.input,
        outcome: event.outcome ?? null,
      });
    });
  }
}

function wrappedKey(key: WrappedKey) {
  return { keyId: key.keyId, iv: key.iv, ciphertext: key.ciphertext, tag: key.tag };
}

function toRecord(row: typeof credentials.$inferSelect): CredentialRecord {
  return {
    tenantId: TenantId.parse(row.tenantId),
    id: row.id,
    sourceId: row.sourceId,
    schemeId: row.schemeId,
    kind: row.kind,
    sealed: { iv: row.iv, ciphertext: row.ciphertext, tag: row.tag },
  };
}
