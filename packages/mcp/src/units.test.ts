import type { AddressInfo } from "node:net";
import type { Database } from "@cairnmcp/db";
import type { Runtime } from "@cairnmcp/runtime";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { createMcpHandler } from "./handler.ts";
import { serve } from "./node-http.ts";
import { toCallToolResult } from "./results.ts";
import { TokenVerifier } from "./token.ts";

const env = {
  CAIRNMCP_PUBLIC_URL: "https://cairn.example.com/",
  CAIRNMCP_DATABASE_URL: "postgres://app@db/cairnmcp",
  CAIRNMCP_MASTER_KEY: "c2VjcmV0",
  CAIRNMCP_TRUSTED_ISSUERS: JSON.stringify([{ issuer: "https://auth.example.com", jwksUri: "https://auth.example.com/jwks" }]),
};

describe("loadConfig", () => {
  it("reads a valid environment", () => {
    expect(loadConfig({ ...env, CAIRNMCP_ALLOWED_ORIGINS: "https://a.test, https://b.test", PORT: "3000" })).toEqual({
      publicUrl: "https://cairn.example.com",
      databaseUrl: env.CAIRNMCP_DATABASE_URL,
      masterKey: env.CAIRNMCP_MASTER_KEY,
      trustedIssuers: [{ issuer: "https://auth.example.com", jwksUri: "https://auth.example.com/jwks" }],
      allowedOrigins: ["https://a.test", "https://b.test"],
      port: 3000,
    });
  });

  it("lists every problem without echoing values", () => {
    const run = () => loadConfig({ CAIRNMCP_PUBLIC_URL: "http://cairn.example.com", CAIRNMCP_MASTER_KEY: "c2VjcmV0", CAIRNMCP_TRUSTED_ISSUERS: "[" });
    expect(run).toThrow(/CAIRNMCP_PUBLIC_URL: must be https[\s\S]*CAIRNMCP_DATABASE_URL[\s\S]*CAIRNMCP_TRUSTED_ISSUERS: must be JSON/);
    expect(run).not.toThrow(/c2VjcmV0/);
  });

  it("allows http only for localhost, and only a bare origin", () => {
    expect(loadConfig({ ...env, CAIRNMCP_PUBLIC_URL: "http://localhost:8080" }).publicUrl).toBe("http://localhost:8080");
    expect(() => loadConfig({ ...env, CAIRNMCP_PUBLIC_URL: "https://cairn.example.com/api" })).toThrow(/just the origin/);
  });
});

describe("toCallToolResult", () => {
  it("wraps non-object JSON so structured content is an object", () => {
    expect(toCallToolResult({ ok: true, status: 200, data: [1, 2] })).toEqual({ content: [{ type: "text", text: "[1,2]" }], structuredContent: { result: [1, 2] } });
    expect(toCallToolResult({ ok: true, status: 200, data: { a: 1 } }).structuredContent).toEqual({ a: 1 });
    expect(toCallToolResult({ ok: true, status: 200, data: "plain" })).toEqual({ content: [{ type: "text", text: "plain" }] });
  });

  it("returns failures as tool errors the agent can act on", () => {
    const result = toCallToolResult({ ok: false, error: { kind: "rate_limited", message: "retry in 5s", retryable: true, retryAfterSeconds: 5 } });
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "retry in 5s" }],
      structuredContent: { error: { kind: "rate_limited", message: "retry in 5s", retryable: true, retryAfterSeconds: 5 } },
    });
  });
});

describe("serve (node:http)", () => {
  it("serves the handler and passes the auth challenge through", async () => {
    // Nothing here reaches the database or runtime: every request stops before auth succeeds.
    const handler = createMcpHandler({ db: {} as Database, runtime: {} as Runtime, publicUrl: "https://cairn.example.com", verifier: new TokenVerifier([]) });
    const server = serve(handler, { port: 0, host: "127.0.0.1", publicUrl: "https://cairn.example.com" });
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()).toBe("ok");
      const response = await fetch(`http://127.0.0.1:${port}/mcp/tenant-a/mine`, { method: "POST", headers: { host: "evil.test" }, body: "{}" });
      expect(response.status).toBe(401);
      // The resource comes from the configured public URL, never the Host header.
      expect(response.headers.get("www-authenticate")).toContain('resource_metadata="https://cairn.example.com/.well-known/oauth-protected-resource/mcp/tenant-a/mine"');
      expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
