import type { Diagnostic } from "@procura/core";
import { describe, expect, it } from "vitest";
import { mapSecurityRequirement, mapSecuritySchemes } from "./security.ts";

const BASE = "https://api.example.com";

describe("mapSecuritySchemes", () => {
  it("maps supported schemes and drops unsupported ones with a warning", () => {
    const diagnostics: Diagnostic[] = [];
    const schemes = mapSecuritySchemes(
      {
        basic: { type: "http", scheme: "Basic" },
        bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        key: { type: "apiKey", in: "header", name: "X-Key" },
        digest: { type: "http", scheme: "digest" },
        mtls: { type: "mutualTLS" },
        oauth: {
          type: "oauth2",
          flows: {
            implicit: { authorizationUrl: "https://a.example.com/auth", scopes: {} },
            authorizationCode: { authorizationUrl: "/oauth/authorize", tokenUrl: "/oauth/token", scopes: { read: "Read" } },
          },
        },
        insecure: { type: "openIdConnect", openIdConnectUrl: "http://id.example.com/.well-known/openid-configuration" },
      },
      BASE,
      diagnostics,
    );
    expect([...schemes.keys()]).toEqual(["basic", "bearer", "key", "oauth"]);
    expect(schemes.get("oauth")).toMatchObject({
      flows: { authorizationCode: { authorizationUrl: "https://api.example.com/oauth/authorize", tokenUrl: "https://api.example.com/oauth/token" } },
    });
    expect(diagnostics.map((d) => d.code).sort()).toEqual([
      "invalid_security_scheme",
      "unsupported_oauth_flow",
      "unsupported_security_scheme",
      "unsupported_security_scheme",
    ]);
  });
});

describe("mapSecurityRequirement", () => {
  const diagnostics: Diagnostic[] = [];
  const schemes = mapSecuritySchemes(
    {
      basic: { type: "http", scheme: "basic" },
      bearer: { type: "http", scheme: "bearer" },
      key: { type: "apiKey", in: "header", name: "X-Key" },
      oauth: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "https://a.example.com/token", scopes: { r: "" } } } },
    },
    BASE,
    diagnostics,
  );

  it("keeps ordinary alternatives and conjunctions", () => {
    expect(mapSecurityRequirement([{ basic: [] }, { key: [], oauth: ["r"] }], schemes, "#/security", [])).toEqual([
      [{ schemeId: "basic", scopes: [] }],
      [
        { schemeId: "key", scopes: [] },
        { schemeId: "oauth", scopes: ["r"] },
      ],
    ]);
  });

  it("splits a conjunction of two Authorization-header schemes into alternatives", () => {
    // Intervals.icu declares `security: [{ APIKey: [], AccessToken: [] }]`, which as
    // written means basic AND bearer: impossible with one Authorization header.
    const d: Diagnostic[] = [];
    expect(mapSecurityRequirement([{ basic: [], bearer: [], key: [] }], schemes, "#/security", d)).toEqual([
      [
        { schemeId: "basic", scopes: [] },
        { schemeId: "key", scopes: [] },
      ],
      [
        { schemeId: "bearer", scopes: [] },
        { schemeId: "key", scopes: [] },
      ],
    ]);
    expect(d.map((x) => x.code)).toEqual(["auth_conjunction_unsatisfiable"]);
  });

  it("keeps anonymous access as an alternative", () => {
    expect(mapSecurityRequirement([{}, { basic: [] }], schemes, "#/security", [])).toEqual([[], [{ schemeId: "basic", scopes: [] }]]);
  });

  it("drops alternatives that need an unknown scheme", () => {
    const d: Diagnostic[] = [];
    expect(mapSecurityRequirement([{ nope: [] }, { basic: [] }], schemes, "#/security", d)).toEqual([[{ schemeId: "basic", scopes: [] }]]);
    expect(d[0]?.code).toBe("security_requirement_dropped");
  });
});
