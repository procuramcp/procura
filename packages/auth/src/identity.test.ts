import { describe, expect, it } from "vitest";
import { OidcIdentityProvider } from "./identity.ts";

/** Just enough of a provider for discovery; sign-in itself is covered in packages/server. */
function discoveryOnly(issuer: string) {
  return async (url: string): Promise<Response> => {
    if (new URL(url).pathname.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/keys`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    return new Response("not found", { status: 404 });
  };
}

const input = { redirectUri: "http://localhost:8080/app/callback/dex", state: "s", nonce: "n", codeVerifier: "v".repeat(43) };

describe("OidcIdentityProvider", () => {
  it("accepts a plain-http localhost issuer, like the self-host setup's Dex", async () => {
    const issuer = "http://localhost:5556/dex";
    const provider = new OidcIdentityProvider({ id: "dex", name: "Dex", issuer, clientId: "procura", clientSecret: "x" }, { fetch: discoveryOnly(issuer) });
    const url = await provider.authorizationUrl(input);
    expect(url.origin + url.pathname).toBe(`${issuer}/auth`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("asks for the sign-in page with prompt=login, and only then", async () => {
    const issuer = "https://idp.example";
    const provider = new OidcIdentityProvider({ id: "idp", name: "IdP", issuer, clientId: "procura", clientSecret: "x" }, { fetch: discoveryOnly(issuer) });
    expect((await provider.authorizationUrl({ ...input, prompt: "login" })).searchParams.get("prompt")).toBe("login");
    expect((await provider.authorizationUrl(input)).searchParams.has("prompt")).toBe(false);
  });

  it("uses https issuers as before", async () => {
    const issuer = "https://idp.example";
    const provider = new OidcIdentityProvider({ id: "idp", name: "IdP", issuer, clientId: "procura", clientSecret: "x" }, { fetch: discoveryOnly(issuer) });
    expect((await provider.authorizationUrl(input)).origin).toBe(issuer);
  });
});
