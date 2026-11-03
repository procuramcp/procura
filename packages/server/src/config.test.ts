import type { AddressInfo } from "node:net";
import type { Database } from "@procura/db";
import { createMcpHandler, TokenVerifier } from "@procura/mcp";
import type { Runtime } from "@procura/runtime";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { serve } from "./node-http.ts";

const provider = { id: "google", name: "Google", issuer: "https://accounts.google.com", clientId: "id", clientSecret: "shh-not-real" };
// 32 bytes of zeros, base64: shaped like a real key, used for nothing.
const KEY = Buffer.alloc(32).toString("base64");
const env = {
  PROCURA_PUBLIC_URL: "https://procura.example.com/",
  PROCURA_DATABASE_URL: "postgres://app@db/procura",
  PROCURA_MASTER_KEY: KEY,
  PROCURA_OIDC_PROVIDERS: JSON.stringify([provider]),
  PROCURA_TRUSTED_ISSUERS: JSON.stringify([{ issuer: "https://auth.example.com", jwksUri: "https://auth.example.com/jwks" }]),
};

describe("loadConfig", () => {
  it("reads a valid environment", () => {
    expect(loadConfig({ ...env, PROCURA_ALLOWED_ORIGINS: "https://a.test, https://b.test", PORT: "3000" })).toEqual({
      publicUrl: "https://procura.example.com",
      databaseUrl: env.PROCURA_DATABASE_URL,
      masterKey: env.PROCURA_MASTER_KEY,
      oidcProviders: [provider],
      trustedIssuers: [{ issuer: "https://auth.example.com", jwksUri: "https://auth.example.com/jwks" }],
      allowedOrigins: ["https://a.test", "https://b.test"],
      port: 3000,
    });
  });

  it("lists every problem without echoing values", () => {
    const run = () => loadConfig({ PROCURA_PUBLIC_URL: "http://procura.example.com", PROCURA_MASTER_KEY: "c2VjcmV0", PROCURA_OIDC_PROVIDERS: "[" });
    expect(run).toThrow(/PROCURA_PUBLIC_URL: must be https[\s\S]*PROCURA_DATABASE_URL[\s\S]*PROCURA_OIDC_PROVIDERS: must be JSON/);
    expect(run).not.toThrow(/c2VjcmV0/);
  });

  it("says which required settings are missing, and counts empty values as unset", () => {
    expect(() => loadConfig({})).toThrow(/PROCURA_PUBLIC_URL: required, but not set[\s\S]*PROCURA_DATABASE_URL: required[\s\S]*PROCURA_MASTER_KEY: required[\s\S]*PROCURA_OIDC_PROVIDERS: required/);
    // As in .env.example, which lists optional settings with no value.
    const config = loadConfig({ ...env, PROCURA_TRUSTED_ISSUERS: "", PROCURA_ALLOWED_ORIGINS: "", PORT: "" });
    expect(config).toMatchObject({ trustedIssuers: [], allowedOrigins: [], port: 8080 });
    expect(() => loadConfig({ ...env, PROCURA_MASTER_KEY: " " })).toThrow(/PROCURA_MASTER_KEY: required/);
  });

  it("checks the master key's shape at startup, without echoing it", () => {
    const short = Buffer.from("not-32-bytes").toString("base64");
    expect(() => loadConfig({ ...env, PROCURA_MASTER_KEY: short })).toThrow(/PROCURA_MASTER_KEY: must decode to 32 bytes/);
    expect(() => loadConfig({ ...env, PROCURA_MASTER_KEY: short })).not.toThrow(new RegExp(short.replace(/[+/=]/g, ".")));
    expect(() => loadConfig({ ...env, PROCURA_MASTER_KEY: "not base64!" })).toThrow(/must be base64/);
  });

  it("requires a sign-in provider; other trusted issuers are optional", () => {
    const { PROCURA_TRUSTED_ISSUERS: _, ...withoutIssuers } = env;
    expect(loadConfig(withoutIssuers).trustedIssuers).toEqual([]);
    expect(() => loadConfig({ ...env, PROCURA_OIDC_PROVIDERS: "[]" })).toThrow(/at least one sign-in provider/);
    expect(() => loadConfig({ ...env, PROCURA_OIDC_PROVIDERS: JSON.stringify([provider, provider]) })).toThrow(/unique/);
    expect(() => loadConfig({ ...env, PROCURA_OIDC_PROVIDERS: JSON.stringify([{ ...provider, issuer: "http://idp.example.com" }]) })).toThrow(/https/);
  });

  it("allows http only for localhost, and only a bare origin", () => {
    expect(loadConfig({ ...env, PROCURA_PUBLIC_URL: "http://localhost:8080" }).publicUrl).toBe("http://localhost:8080");
    expect(() => loadConfig({ ...env, PROCURA_PUBLIC_URL: "https://procura.example.com/api" })).toThrow(/just the origin/);
  });
});

describe("serve (node:http)", () => {
  it("serves the handler and passes the auth challenge through", async () => {
    // Nothing here reaches the database or runtime: every request stops before auth succeeds.
    const handler = createMcpHandler({ db: {} as Database, runtime: {} as Runtime, publicUrl: "https://procura.example.com", verifier: new TokenVerifier([]) });
    const server = serve(handler, { port: 0, host: "127.0.0.1", publicUrl: "https://procura.example.com" });
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()).toBe("ok");
      const response = await fetch(`http://127.0.0.1:${port}/mcp/tenant-a/mine`, { method: "POST", headers: { host: "evil.test" }, body: "{}" });
      expect(response.status).toBe(401);
      // The resource comes from the configured public URL, never the Host header.
      expect(response.headers.get("www-authenticate")).toContain('resource_metadata="https://procura.example.com/.well-known/oauth-protected-resource/mcp/tenant-a/mine"');
      expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("sends every Set-Cookie, not just the last one", async () => {
    const handler = async () => {
      const headers = new Headers({ location: "/app/" });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=; Path=/; Max-Age=0");
      return new Response(null, { status: 302, headers });
    };
    const server = serve(handler, { port: 0, host: "127.0.0.1", publicUrl: "https://procura.example.com" });
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
      expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=; Path=/; Max-Age=0"]);
    } finally {
      server.close();
    }
  });
});
