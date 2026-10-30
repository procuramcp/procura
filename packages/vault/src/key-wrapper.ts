import { createHash } from "node:crypto";
import { open, seal, type Sealed } from "./aead.ts";

/** A data key encrypted by a key-encryption key (KEK), tagged with which KEK. */
export type WrappedKey = Sealed & { keyId: string };

/**
 * Wraps and unwraps per-tenant data keys. The local implementation holds a
 * master key in memory; a KMS implementation (AWS KMS, GCP KMS, Vault Transit)
 * keeps the KEK outside the process and is a drop-in replacement.
 */
export interface KeyWrapper {
  /** Stable id of the KEK, stored with each wrapped key so rotation can find the right one. */
  readonly keyId: string;
  wrap(dataKey: Buffer, context: string): Promise<WrappedKey>;
  unwrap(wrapped: WrappedKey, context: string): Promise<Buffer>;
}

/** KEK from a 32-byte master key (`CAIRNMCP_MASTER_KEY`). For self-hosting and development. */
export class LocalKeyWrapper implements KeyWrapper {
  readonly keyId: string;
  readonly #masterKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error("master key must be 32 bytes");
    this.#masterKey = Buffer.from(masterKey);
    // Identifies the key without revealing it (a hash prefix of a 256-bit random key).
    this.keyId = `local:${createHash("sha256").update("cairnmcp-kek-id").update(masterKey).digest("hex").slice(0, 16)}`;
  }

  async wrap(dataKey: Buffer, context: string): Promise<WrappedKey> {
    return { keyId: this.keyId, ...seal(this.#masterKey, dataKey, `kek:${context}`) };
  }

  async unwrap(wrapped: WrappedKey, context: string): Promise<Buffer> {
    if (wrapped.keyId !== this.keyId) throw new Error(`data key was wrapped by ${wrapped.keyId}, not ${this.keyId}`);
    return open(this.#masterKey, wrapped, `kek:${context}`);
  }
}

/**
 * Parse a master key from an environment value: 32 random bytes, base64.
 * Generate one with: `openssl rand -base64 32`.
 */
export function parseMasterKey(value: string | undefined, name = "CAIRNMCP_MASTER_KEY"): Buffer {
  if (value === undefined || value.trim() === "") throw new Error(`${name} is not set (generate one with: openssl rand -base64 32)`);
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw new Error(`${name} must be base64`);
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== 32) throw new Error(`${name} must decode to 32 bytes, got ${key.length}`);
  return key;
}
