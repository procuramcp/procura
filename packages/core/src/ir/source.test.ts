import { describe, expect, it } from "vitest";
import { AuthScheme, BaseUrl, Source } from "./source.ts";
import { rawSource } from "./test-helpers.ts";

describe("BaseUrl", () => {
  it.each(["https://intervals.icu", "https://api.example.com/v1", "https://localhost:8443"])("accepts %s", (url) => {
    expect(BaseUrl.safeParse(url).success).toBe(true);
  });

  it.each([
    ["http://api.example.com", "must use https"],
    ["https://user:pw@api.example.com", "must not contain credentials"],
    ["https://api.example.com/v1?key=1", "must not contain a query"],
    ["https://api.example.com/v1#x", "must not contain a fragment"],
    ["https://api.example.com/v1/", "must not end with a slash"],
    ["/api/v1", "must be an absolute URL"],
    ["file:///etc/passwd", "must use https"],
  ])("rejects %s", (url, message) => {
    const r = BaseUrl.safeParse(url);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toContain(message);
  });
});

describe("AuthScheme", () => {
  it("requires at least one supported OAuth flow", () => {
    expect(AuthScheme.safeParse({ id: "o", type: "oauth2", flows: {} }).success).toBe(false);
    expect(
      AuthScheme.safeParse({
        id: "o",
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: "https://example.com/authorize",
            tokenUrl: "https://example.com/token",
            scopes: { read: "Read data" },
          },
        },
      }).success,
    ).toBe(true);
  });

  it("has no field for credential values", () => {
    const parsed = AuthScheme.parse({ id: "b", type: "http_basic", fixedUsername: "API_KEY", password: "secret" });
    expect(parsed).not.toHaveProperty("password");
  });
});

describe("Source", () => {
  it("parses a valid source", () => {
    expect(Source.safeParse(rawSource()).success).toBe(true);
  });

  it("requires a slug id", () => {
    expect(Source.safeParse({ ...rawSource(), id: "Intervals ICU" }).success).toBe(false);
  });
});
