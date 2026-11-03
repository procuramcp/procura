import { randomUUID } from "node:crypto";
import { TenantId } from "@procura/core";
import { newDataKey, open, seal } from "./aead.ts";
import { CredentialInput, wrapSecrets, type Credential } from "./credentials.ts";
import type { KeyWrapper, WrappedKey } from "./key-wrapper.ts";
import type { CredentialRecord, VaultStore } from "./store.ts";

export type StoredCredentialInfo = { id: string; sourceId: string; schemeId: string; kind: Credential["kind"] };

/**
 * Envelope-encrypted credential vault.
 *
 * Each tenant has one random 256-bit data key, stored only wrapped by the
 * key-encryption key (KEK). Credentials are encrypted with the tenant's data
 * key using AES-256-GCM, with the tenant, credential id, source, and scheme
 * as authenticated context: a ciphertext copied to another tenant or row does
 * not decrypt.
 *
 * Unwrapped data keys are not cached; with a remote KMS, add a short-lived
 * cache here.
 */
export class Vault {
  readonly #store: VaultStore;
  readonly #active: KeyWrapper;
  readonly #byKeyId: Map<string, KeyWrapper>;

  /** `previous` lets data keys wrapped by an older KEK still be read until `rotateTenantKey` runs. */
  constructor(options: { store: VaultStore; keyWrapper: KeyWrapper; previousKeyWrappers?: KeyWrapper[] }) {
    this.#store = options.store;
    this.#active = options.keyWrapper;
    this.#byKeyId = new Map([...(options.previousKeyWrappers ?? []), options.keyWrapper].map((w) => [w.keyId, w]));
  }

  async putCredential(input: { tenantId: TenantId; sourceId: string; schemeId: string; credential: CredentialInput }): Promise<StoredCredentialInfo> {
    const tenantId = TenantId.parse(input.tenantId);
    const credential = CredentialInput.parse(input.credential);
    const dataKey = await this.#dataKey(tenantId, { create: true });
    const id = randomUUID();
    const record: CredentialRecord = {
      tenantId,
      id,
      sourceId: input.sourceId,
      schemeId: input.schemeId,
      kind: credential.kind,
      sealed: seal(
        dataKey,
        Buffer.from(JSON.stringify(credential), "utf8"),
        credentialContext({ tenantId, id, sourceId: input.sourceId, schemeId: input.schemeId, kind: credential.kind }),
      ),
    };
    dataKey.fill(0);
    await this.#store.putCredential(record);
    return { id, sourceId: input.sourceId, schemeId: input.schemeId, kind: credential.kind };
  }

  async getCredential(tenantId: TenantId, id: string): Promise<Credential | undefined> {
    const record = await this.#store.getCredential(TenantId.parse(tenantId), id);
    return record ? this.#decrypt(record) : undefined;
  }

  /**
   * Credentials for one source, keyed by auth scheme id. What the runtime asks
   * for on every call, so the data key is unwrapped once (one KMS call), not
   * once per credential. The newest credential for a scheme wins.
   */
  async credentialsForSource(tenantId: TenantId, sourceId: string): Promise<Map<string, Credential>> {
    const t = TenantId.parse(tenantId);
    const records = await this.#store.listCredentials(t, sourceId);
    const out = new Map<string, Credential>();
    if (records.length === 0) return out;
    const dataKey = await this.#dataKey(t, { create: false });
    try {
      for (const record of records) out.set(record.schemeId, decryptWith(dataKey, record));
    } finally {
      dataKey.fill(0);
    }
    return out;
  }

  /**
   * Store the credential for one auth scheme and delete any older ones for it,
   * so a scheme has exactly one. The new one is written first: a failure leaves
   * the old credential working.
   */
  async replaceCredential(input: { tenantId: TenantId; sourceId: string; schemeId: string; credential: CredentialInput }): Promise<StoredCredentialInfo & { replaced: number }> {
    const older = (await this.listCredentials(input.tenantId, input.sourceId)).filter((c) => c.schemeId === input.schemeId);
    const stored = await this.putCredential(input);
    for (const old of older) await this.deleteCredential(input.tenantId, old.id);
    return { ...stored, replaced: older.length };
  }

  /** Delete every credential for one auth scheme of a source. Returns how many were deleted. */
  async deleteSchemeCredentials(tenantId: TenantId, sourceId: string, schemeId: string): Promise<number> {
    const matching = (await this.listCredentials(tenantId, sourceId)).filter((c) => c.schemeId === schemeId);
    for (const c of matching) await this.deleteCredential(tenantId, c.id);
    return matching.length;
  }

  /** Metadata only, for UIs: never decrypts. */
  async listCredentials(tenantId: TenantId, sourceId?: string): Promise<StoredCredentialInfo[]> {
    const records = await this.#store.listCredentials(TenantId.parse(tenantId), sourceId);
    return records.map((r) => ({ id: r.id, sourceId: r.sourceId, schemeId: r.schemeId, kind: r.kind }));
  }

  async deleteCredential(tenantId: TenantId, id: string): Promise<boolean> {
    return this.#store.deleteCredential(TenantId.parse(tenantId), id);
  }

  /** Re-wrap a tenant's data key with the active KEK. Credentials are untouched. */
  async rotateTenantKey(tenantId: TenantId): Promise<void> {
    const t = TenantId.parse(tenantId);
    const wrapped = await this.#store.getDataKey(t);
    if (!wrapped || wrapped.keyId === this.#active.keyId) return;
    const dataKey = await this.#unwrap(t, wrapped);
    await this.#store.replaceDataKey(t, await this.#active.wrap(dataKey, tenantContext(t)));
    dataKey.fill(0);
  }

  async #decrypt(record: CredentialRecord): Promise<Credential> {
    const dataKey = await this.#dataKey(record.tenantId, { create: false });
    try {
      return decryptWith(dataKey, record);
    } finally {
      dataKey.fill(0);
    }
  }

  async #dataKey(tenantId: TenantId, { create }: { create: boolean }): Promise<Buffer> {
    let wrapped = await this.#store.getDataKey(tenantId);
    if (!wrapped) {
      if (!create) throw new Error("tenant has no data key");
      const fresh = newDataKey();
      wrapped = await this.#store.putDataKeyIfAbsent(tenantId, await this.#active.wrap(fresh, tenantContext(tenantId)));
      fresh.fill(0);
    }
    return this.#unwrap(tenantId, wrapped);
  }

  async #unwrap(tenantId: TenantId, wrapped: WrappedKey): Promise<Buffer> {
    const wrapper = this.#byKeyId.get(wrapped.keyId);
    if (!wrapper) throw new Error(`no key wrapper for ${wrapped.keyId}`);
    return wrapper.unwrap(wrapped, tenantContext(tenantId));
  }
}

function decryptWith(dataKey: Buffer, record: CredentialRecord): Credential {
  const plaintext = open(dataKey, record.sealed, credentialContext(record));
  try {
    return wrapSecrets(CredentialInput.parse(JSON.parse(plaintext.toString("utf8"))));
  } finally {
    plaintext.fill(0);
  }
}

function tenantContext(tenantId: string): string {
  return `cairnmcp:v1:tenant:${tenantId}`;
}

// Everything that identifies a credential row is authenticated, so a ciphertext
// moved to another tenant, row, source, scheme, or kind fails to decrypt.
function credentialContext(r: Pick<CredentialRecord, "tenantId" | "id" | "sourceId" | "schemeId" | "kind">): string {
  return `cairnmcp:v1:credential:${JSON.stringify([r.tenantId, r.id, r.sourceId, r.schemeId, r.kind])}`;
}
