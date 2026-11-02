import { describe, expect, it } from "vitest";
import { profilesForClaims, SignInConfig } from "./sign-in.ts";

describe("profilesForClaims (D-040)", () => {
  const profiles = [
    { id: "free", claims: [] },
    { id: "pro", claims: [{ claim: "plan", value: "pro" }] },
    { id: "team", claims: [{ claim: "https://example.com/roles", value: "admin" }, { claim: "seats", value: "5" }] },
    { id: "beta", claims: [{ claim: "beta", value: "true" }] },
  ];

  it("gives the default profile, then every profile a claim matches", () => {
    expect(profilesForClaims(profiles, { plan: "pro" }, "free")).toEqual(["free", "pro"]);
    expect(profilesForClaims(profiles, { plan: "basic" }, "free")).toEqual(["free"]);
    expect(profilesForClaims(profiles, {})).toEqual([]);
  });

  it("matches inside lists, and numbers and booleans as text", () => {
    expect(profilesForClaims(profiles, { "https://example.com/roles": ["user", "admin"] })).toEqual(["team"]);
    expect(profilesForClaims(profiles, { seats: 5, beta: true })).toEqual(["team", "beta"]);
  });

  it("never matches objects or partial text, and ignores a default profile that doesn't exist", () => {
    expect(profilesForClaims(profiles, { plan: { name: "pro" } })).toEqual([]);
    expect(profilesForClaims(profiles, { plan: "pro-trial" })).toEqual([]);
    expect(profilesForClaims(profiles, {}, "deleted")).toEqual([]);
  });
});

describe("SignInConfig", () => {
  it("fills in OIDC scopes that ask for a refresh token", () => {
    const config = SignInConfig.parse({ kind: "oidc", name: "Acme", issuer: "https://login.acme.test", clientId: "abc" });
    expect(config).toMatchObject({ scopes: "openid email profile offline_access" });
  });

  it("needs https everywhere for plain OAuth 2, and defaults the userinfo fields", () => {
    const base = { kind: "oauth2", name: "Acme", clientId: "abc", authorizationUrl: "https://acme.test/oauth/authorize", tokenUrl: "https://acme.test/oauth/token" };
    expect(SignInConfig.parse({ ...base, userinfoUrl: "https://acme.test/api/me" })).toMatchObject({ subjectField: "id", labelField: "email" });
    expect(SignInConfig.safeParse({ ...base, userinfoUrl: "http://acme.test/api/me" }).success).toBe(false);
  });
});
