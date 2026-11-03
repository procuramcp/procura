import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { schema, type Database } from "@procura/db";
import type { KeyWrapper } from "@procura/vault";
import { isNull, or, gt, sql } from "drizzle-orm";
import { calculateJwkThumbprint, createLocalJWKSet, SignJWT, type JWK, type JWTVerifyGetKey } from "jose";

const ALG = "ES256";
/** Retired keys stay in the JWKS this long, so tokens they signed still verify. */
const RETIRED_GRACE = "1 day";

const context = (kid: string) => `cairnmcp:v1:oauth-signing-key:${kid}`;

/**
 * Access-token signing keys. One active ES256 key, created on first start.
 * The private key is stored only wrapped by the KEK (D-019), like tenant data
 * keys, and unwrapped into memory at startup.
 */
export class SigningKeys {
  readonly #kid: string;
  readonly #privateKey: KeyObject;
  readonly #publicJwks: JWK[];

  private constructor(kid: string, privateKey: KeyObject, publicJwks: JWK[]) {
    this.#kid = kid;
    this.#privateKey = privateKey;
    this.#publicJwks = publicJwks;
  }

  /** Load the active key, creating it if there is none (safe when several instances start at once). */
  static async load(db: Database, keyWrapper: KeyWrapper): Promise<SigningKeys> {
    const keys = schema.oauthSigningKeys;
    let rows = await db.withoutTenant((tx) => tx.select().from(keys).where(isNull(keys.retiredAt)));
    if (rows.length === 0) {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const publicJwk = { ...(publicKey.export({ format: "jwk" }) as JWK), alg: ALG, use: "sig" };
      const kid = await calculateJwkThumbprint(publicJwk);
      const der = privateKey.export({ type: "pkcs8", format: "der" });
      const wrappedPrivate = await keyWrapper.wrap(der, context(kid));
      der.fill(0);
      // The one-active-key index makes a concurrent second insert a no-op.
      await db.withoutTenant((tx) =>
        tx.insert(keys).values({ kid, alg: ALG, publicJwk: { ...publicJwk, kid }, wrappedPrivate }).onConflictDoNothing(),
      );
      rows = await db.withoutTenant((tx) => tx.select().from(keys).where(isNull(keys.retiredAt)));
    }
    const active = rows[0];
    if (!active) throw new Error("no active signing key");
    const der = await keyWrapper.unwrap(active.wrappedPrivate, context(active.kid));
    const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    der.fill(0);

    const published = await db.withoutTenant((tx) =>
      tx.select({ jwk: keys.publicJwk }).from(keys).where(or(isNull(keys.retiredAt), gt(keys.retiredAt, sql`now() - ${RETIRED_GRACE}::interval`))),
    );
    return new SigningKeys(active.kid, privateKey, published.map((r) => r.jwk as JWK));
  }

  /** The public keys, for `/oauth/jwks`. */
  jwks(): { keys: JWK[] } {
    return { keys: this.#publicJwks.map((k) => ({ ...k })) };
  }

  /** Verify locally with the same keys, without fetching our own JWKS over HTTP. */
  verifierKeys(): JWTVerifyGetKey {
    return createLocalJWKSet(this.jwks());
  }

  /** Sign an access token (RFC 9068 `at+jwt`). */
  async signAccessToken(input: {
    issuer: string;
    subject: string;
    audience: string;
    clientId: string;
    scope: string;
    jti: string;
    nowSeconds: number;
    lifetimeSeconds: number;
  }): Promise<string> {
    return new SignJWT({ client_id: input.clientId, scope: input.scope })
      .setProtectedHeader({ alg: ALG, kid: this.#kid, typ: "at+jwt" })
      .setIssuer(input.issuer)
      .setSubject(input.subject)
      .setAudience(input.audience)
      .setJti(input.jti)
      .setIssuedAt(input.nowSeconds)
      .setExpirationTime(input.nowSeconds + input.lifetimeSeconds)
      .sign(this.#privateKey);
  }
}
