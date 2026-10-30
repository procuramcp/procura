import type { TenantId } from "@cairnmcp/core";
import type { Sealed } from "./aead.ts";
import type { WrappedKey } from "./key-wrapper.ts";

/** One encrypted credential. Only `ciphertext` is secret; the rest is metadata. */
export type CredentialRecord = {
  tenantId: TenantId;
  id: string;
  sourceId: string;
  /** Auth scheme id in the source's IR, e.g. `APIKey`. */
  schemeId: string;
  /** Kind of credential inside the ciphertext. Not secret; bound into the encryption context. */
  kind: "basic" | "bearer" | "api_key" | "oauth2";
  sealed: Sealed;
};

/**
 * Persistence for the vault. Every call is scoped by tenant: implementations
 * must never return another tenant's rows (in Postgres, enforced again by RLS).
 */
export interface VaultStore {
  getDataKey(tenantId: TenantId): Promise<WrappedKey | undefined>;
  /** Store the tenant's wrapped data key unless one exists; return whichever is stored. */
  putDataKeyIfAbsent(tenantId: TenantId, key: WrappedKey): Promise<WrappedKey>;
  /** Replace the tenant's wrapped data key (KEK rotation). The data key itself is unchanged. */
  replaceDataKey(tenantId: TenantId, key: WrappedKey): Promise<void>;
  putCredential(record: CredentialRecord): Promise<void>;
  getCredential(tenantId: TenantId, id: string): Promise<CredentialRecord | undefined>;
  listCredentials(tenantId: TenantId, sourceId?: string): Promise<CredentialRecord[]>;
  deleteCredential(tenantId: TenantId, id: string): Promise<boolean>;
}

/** In-memory store for tests and single-process development. */
export class InMemoryVaultStore implements VaultStore {
  readonly #dataKeys = new Map<string, WrappedKey>();
  readonly #credentials = new Map<string, Map<string, CredentialRecord>>();

  async getDataKey(tenantId: TenantId) {
    return clone(this.#dataKeys.get(tenantId));
  }

  async putDataKeyIfAbsent(tenantId: TenantId, key: WrappedKey) {
    if (!this.#dataKeys.has(tenantId)) this.#dataKeys.set(tenantId, clone(key));
    return clone(this.#dataKeys.get(tenantId)!);
  }

  async replaceDataKey(tenantId: TenantId, key: WrappedKey) {
    if (!this.#dataKeys.has(tenantId)) throw new Error("no data key to replace");
    this.#dataKeys.set(tenantId, clone(key));
  }

  async putCredential(record: CredentialRecord) {
    const rows = this.#credentials.get(record.tenantId) ?? new Map<string, CredentialRecord>();
    rows.set(record.id, clone(record));
    this.#credentials.set(record.tenantId, rows);
  }

  async getCredential(tenantId: TenantId, id: string) {
    return clone(this.#credentials.get(tenantId)?.get(id));
  }

  async listCredentials(tenantId: TenantId, sourceId?: string) {
    const rows = [...(this.#credentials.get(tenantId)?.values() ?? [])];
    return rows.filter((r) => sourceId === undefined || r.sourceId === sourceId).map((r) => clone(r));
  }

  async deleteCredential(tenantId: TenantId, id: string) {
    return this.#credentials.get(tenantId)?.delete(id) ?? false;
  }
}

// Callers get copies, so mutating a returned record cannot change stored state.
function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
