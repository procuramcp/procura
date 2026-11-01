import type { JsonValue } from "@cairnmcp/core";
import { createRemoteJWKSet, decodeJwt, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/**
 * An authorization server whose tokens the MCP endpoint accepts. The embedded
 * authorization server will be one; a company's identity provider can be
 * another (D-022: checking tokens is separate from issuing them).
 */
export type TrustedIssuer = {
  /** Exact `iss` value. */
  issuer: string;
  /** Where the issuer publishes its signing keys. */
  jwksUri: string;
};

export type VerifiedToken = {
  issuer: string;
  subject: string;
  claims: Record<string, JsonValue>;
};

export type TokenCheck = { ok: true; token: VerifiedToken } | { ok: false; reason: string };

/** Asymmetric only: a shared-secret (HS*) or unsigned token is never accepted. */
const ALGORITHMS = ["RS256", "PS256", "ES256", "EdDSA"];
const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * Validates access tokens as an OAuth resource server: signature from a
 * trusted issuer's keys, `iss`, `aud` (this endpoint's resource URL, RFC 8707),
 * `exp`, and a `sub`. Doesn't look up users or tenants; that is the caller's job.
 */
export class TokenVerifier {
  readonly #keys: Map<string, JWTVerifyGetKey>;

  /** `keys` overrides key fetching per issuer (tests use local key sets). */
  constructor(issuers: TrustedIssuer[], keys: Map<string, JWTVerifyGetKey> = new Map()) {
    this.#keys = new Map(issuers.map((i) => [i.issuer, keys.get(i.issuer) ?? createRemoteJWKSet(new URL(i.jwksUri))]));
  }

  get issuers(): string[] {
    return [...this.#keys.keys()];
  }

  async verify(token: string, audience: string): Promise<TokenCheck> {
    let unverified: JWTPayload;
    try {
      unverified = decodeJwt(token);
    } catch {
      return { ok: false, reason: "malformed token" };
    }
    // Pick the key set by the claimed issuer; jwtVerify then checks the claim against it.
    const keys = typeof unverified.iss === "string" ? this.#keys.get(unverified.iss) : undefined;
    if (!keys) return { ok: false, reason: "token is from an issuer this server doesn't trust" };
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: unverified.iss!,
        audience,
        algorithms: ALGORITHMS,
        requiredClaims: ["exp", "sub"],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      return { ok: true, token: { issuer: payload.iss!, subject: payload.sub!, claims: payload as Record<string, JsonValue> } };
    } catch (e) {
      return { ok: false, reason: reasonFor(e) };
    }
  }
}

// Short reasons for the WWW-Authenticate header; never include the token.
function reasonFor(e: unknown): string {
  if (e instanceof errors.JWTExpired) return "token expired";
  if (e instanceof errors.JWTClaimValidationFailed) return e.claim === "aud" ? "token is not for this resource" : `invalid ${e.claim} claim`;
  if (e instanceof errors.JOSEAlgNotAllowed) return "token signing algorithm not allowed";
  if (e instanceof errors.JWSSignatureVerificationFailed || e instanceof errors.JWKSNoMatchingKey) return "token signature is not valid";
  return "token could not be verified";
}

/** The token from `Authorization: Bearer …`, or undefined. */
export function bearerToken(header: string | null): string | undefined {
  const match = header ? /^Bearer\s+([A-Za-z0-9._~+/-]+=*)\s*$/i.exec(header) : null;
  return match?.[1];
}
