import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A random, URL-safe secret of `bytes` random bytes (sign-in state, session tokens, codes). */
export function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * SHA-256 as hex. Tokens are stored only as hashes; keep using the encoding a
 * table already stores (the OAuth tables use hex, the console tables base64url).
 */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** SHA-256 as base64url (also the PKCE S256 transform). */
export function sha256Base64url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Compare two strings (usually hashes) in constant time. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
