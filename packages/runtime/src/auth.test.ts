import { AuthScheme, type Instant } from "@procura/core";
import { Secret, type Credential } from "@procura/vault";
import { describe, expect, it } from "vitest";
import { applyAuth } from "./auth.ts";
import { RuntimeFailure } from "./errors.ts";

const NOW = "2026-10-30T12:00:00Z" as Instant;
const schemes = [
  AuthScheme.parse({ id: "APIKey", type: "http_basic", fixedUsername: "API_KEY" }),
  AuthScheme.parse({ id: "AccessToken", type: "http_bearer" }),
  AuthScheme.parse({ id: "QueryKey", type: "api_key", in: "query", name: "key" }),
];
const use = (...ids: string[]) => ids.map((schemeId) => ({ schemeId: schemeId as never, scopes: [] }));
const creds = (entries: Record<string, Credential>) => new Map(Object.entries(entries));

describe("applyAuth", () => {
  it("uses the scheme's fixed username for basic auth", () => {
    const a = applyAuth([use("APIKey")], schemes, creds({ APIKey: { kind: "basic", password: new Secret("k3y") } }), NOW);
    expect(a.headers["authorization"]?.reveal()).toBe(`Basic ${Buffer.from("API_KEY:k3y").toString("base64")}`);
    expect(String(a.headers["authorization"])).toBe("[redacted]");
  });

  it("picks the first alternative the tenant can satisfy", () => {
    const a = applyAuth([use("APIKey"), use("AccessToken")], schemes, creds({ AccessToken: { kind: "bearer", token: new Secret("tok") } }), NOW);
    expect(a.headers["authorization"]?.reveal()).toBe("Bearer tok");
  });

  it("puts query API keys in the query, not headers", () => {
    const a = applyAuth([use("QueryKey")], schemes, creds({ QueryKey: { kind: "api_key", value: new Secret("q") } }), NOW);
    expect(a.query.map(([n, v]) => [n, v.reveal()])).toEqual([["key", "q"]]);
    expect(a.headers).toEqual({});
  });

  it("skips expired OAuth tokens", () => {
    const expired: Credential = { kind: "oauth2", accessToken: new Secret("old"), expiresAt: "2026-10-30T11:59:59.500Z" as Instant };
    expect(() => applyAuth([use("AccessToken")], schemes, creds({ AccessToken: expired }), NOW)).toThrow(RuntimeFailure);
  });

  it("needs nothing when the operation needs no auth", () => {
    expect(applyAuth([], schemes, new Map(), NOW).headers).toEqual({});
    expect(applyAuth([[]], schemes, new Map(), NOW).headers).toEqual({});
  });

  it("explains which credentials are missing, without secrets", () => {
    try {
      applyAuth([use("APIKey"), use("AccessToken")], schemes, new Map(), NOW);
      throw new Error("expected failure");
    } catch (e) {
      expect((e as RuntimeFailure).error).toMatchObject({ kind: "missing_credentials", retryable: false });
      expect((e as RuntimeFailure).error.message).toContain("APIKey or AccessToken");
    }
  });
});
