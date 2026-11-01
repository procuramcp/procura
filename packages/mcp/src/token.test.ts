import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { bearerToken, TokenVerifier } from "./token.ts";

const ISSUER = "https://issuer.test";
const AUDIENCE = "https://cairn.test/mcp/tenant-a/mine";

let verifier: TokenVerifier;
let sign: (claims: Record<string, unknown>, options?: { alg?: string; key?: CryptoKey; exp?: string | number }) => Promise<string>;
let otherKey: CryptoKey;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  ({ privateKey: otherKey } = await generateKeyPair("ES256"));
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
  verifier = new TokenVerifier([{ issuer: ISSUER, jwksUri: `${ISSUER}/jwks` }], new Map([[ISSUER, createLocalJWKSet({ keys: [jwk] })]]));
  sign = (claims, options = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: options.alg ?? "ES256", kid: "k1" })
      .setIssuedAt()
      .setExpirationTime(options.exp ?? "5m")
      .sign(options.key ?? privateKey);
});

const valid = { iss: ISSUER, sub: "user-1", aud: AUDIENCE };

describe("TokenVerifier", () => {
  it("accepts a token from a trusted issuer for this resource", async () => {
    const result = await verifier.verify(await sign({ ...valid, scope: "mcp" }), AUDIENCE);
    expect(result).toMatchObject({ ok: true, token: { issuer: ISSUER, subject: "user-1", subjectIsUserId: false, claims: { scope: "mcp" } } });
  });

  it.each([
    ["a token for another resource", { ...valid, aud: "https://cairn.test/mcp/tenant-b/mine" }, "token is not for this resource"],
    ["an untrusted issuer", { ...valid, iss: "https://evil.test" }, "token is from an issuer this server doesn't trust"],
    ["no subject", { iss: ISSUER, aud: AUDIENCE }, "invalid sub claim"],
  ])("rejects %s", async (_, claims, reason) => {
    expect(await verifier.verify(await sign(claims), AUDIENCE)).toEqual({ ok: false, reason });
  });

  it("rejects an expired token", async () => {
    const exp = Math.floor(Date.now() / 1000) - 120;
    expect(await verifier.verify(await sign(valid, { exp }), AUDIENCE)).toEqual({ ok: false, reason: "token expired" });
  });

  it("rejects a token signed by another key", async () => {
    expect(await verifier.verify(await sign(valid, { key: otherKey }), AUDIENCE)).toEqual({ ok: false, reason: "token signature is not valid" });
  });

  it("rejects unsigned and shared-secret tokens", async () => {
    const header = (alg: string) => Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ ...valid, exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url");
    expect((await verifier.verify(`${header("none")}.${body}.`, AUDIENCE)).ok).toBe(false);
    expect((await verifier.verify(`${header("HS256")}.${body}.c2ln`, AUDIENCE)).ok).toBe(false);
  });

  it("rejects garbage", async () => {
    expect(await verifier.verify("not-a-jwt", AUDIENCE)).toEqual({ ok: false, reason: "malformed token" });
  });
});

describe("bearerToken", () => {
  it("reads the token from a Bearer header only", () => {
    expect(bearerToken("Bearer abc.def-ghi")).toBe("abc.def-ghi");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken("Bearer a b")).toBeUndefined();
    expect(bearerToken(null)).toBeUndefined();
  });
});
