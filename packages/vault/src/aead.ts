import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM from Node's built-in crypto (OpenSSL). No custom primitives:
// this module only fixes the parameters and the encoding.
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Ciphertext plus what is needed to decrypt it. Base64 fields, safe to store as text/jsonb. */
export type Sealed = { iv: string; ciphertext: string; tag: string };

export class DecryptionError extends Error {
  constructor() {
    // Deliberately vague: never say which part (key, AAD, tag) was wrong.
    super("decryption failed: wrong key, wrong context, or tampered data");
  }
}

/**
 * Encrypt with AES-256-GCM. `context` is authenticated but not encrypted
 * (AAD): decrypting with a different context fails. A fresh random 96-bit IV
 * is used for every call.
 */
export function seal(key: Buffer, plaintext: Buffer, context: string): Sealed {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function open(key: Buffer, sealed: Sealed, context: string): Buffer {
  assertKey(key);
  const iv = Buffer.from(sealed.iv, "base64");
  const tag = Buffer.from(sealed.tag, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new DecryptionError();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}

export function newDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error(`key must be ${KEY_BYTES} bytes`);
}
