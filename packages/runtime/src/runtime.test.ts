// End to end: real Intervals.icu IR, real vault, fake upstream.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveToolset, TenantId, Toolset, UserId, type Caller, type Instant, type IrDocument, type ResolvedTool, type Source } from "@procura/core";
import { ingestOpenApiText } from "@procura/ingest";
import { InMemoryVaultStore, LocalKeyWrapper, Vault } from "@procura/vault";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryAuditSink, type AuditSink } from "./audit.ts";
import { InMemoryRateLimiter } from "./limiter.ts";
import { Runtime, type RuntimeOptions, type ToolResult } from "./runtime.ts";
import { fakeFetch, json } from "./test-support.ts";

const API_KEY = "test-api-key-not-real-0123456789";
const TENANT = TenantId.parse("tenant-me");
const CALLER: Caller = { userId: UserId.parse("user-me"), claims: { sub: "me" } };
const NOW = "2026-10-30T12:00:00Z" as Instant;

const fixture = new URL("../../ingest/fixtures/intervals-icu/openapi.json", import.meta.url);
const mapped = ingestOpenApiText(readFileSync(fixture, "utf8"), { sourceId: "intervals-icu" });
if (!mapped.ok) throw new Error("fixture failed to map");
const ir: IrDocument = mapped.ir;

// Curation the UI will do: Intervals.icu's basic-auth username is the literal "API_KEY".
const source: Source = {
  ...ir.source,
  authSchemes: ir.source.authSchemes.map((s) => (s.id === "APIKey" && s.type === "http_basic" ? { ...s, fixedUsername: "API_KEY" } : s)),
};

const resolved = resolveToolset(
  Toolset.parse({
    id: "mine",
    sourceId: "intervals-icu",
    name: "Mine",
    tools: [
      { operationId: "list_activities", name: "list_activities", description: "List my activities.", pinnedInputs: { id: "0" } },
      { operationId: "update_activity", name: "update_activity", description: "Update one of my activities." },
      { operationId: "get_activity", name: "get_activity", description: "Get one activity." },
    ],
  }),
  ir,
);
if (!resolved.ok) throw new Error(JSON.stringify(resolved.issues));
const tool = (name: string): ResolvedTool => resolved.tools.find((t) => t.name === name)!;

let vault: Vault;
let audit: InMemoryAuditSink;
let limiter: InMemoryRateLimiter;
let clockMs: number;

beforeEach(async () => {
  vault = new Vault({ store: new InMemoryVaultStore(), keyWrapper: new LocalKeyWrapper(randomBytes(32)) });
  await vault.putCredential({ tenantId: TENANT, sourceId: "intervals-icu", schemeId: "APIKey", credential: { kind: "basic", password: API_KEY } });
  audit = new InMemoryAuditSink();
  clockMs = Date.parse(NOW);
  limiter = new InMemoryRateLimiter({ nowMs: () => clockMs });
});

function runtime(fetch: RuntimeOptions["fetch"], extra: Partial<RuntimeOptions> = {}) {
  let n = 0;
  return new Runtime({ fetch, credentials: vault, limiter, audit, now: () => NOW, newId: () => `inv-${++n}`, ...extra });
}

/** No secret may appear in anything an agent or a log could see. */
function expectNoSecret(...things: unknown[]) {
  for (const t of things) expect(JSON.stringify(t)).not.toContain(API_KEY);
}

describe("Runtime with Intervals.icu", () => {
  it("lists activities: pinned athlete, basic auth, decoded JSON", async () => {
    const { fetch, calls } = fakeFetch(() => json([{ id: "i1", type: "Ride", moving_time: 3600 }]));
    const result = await runtime(fetch).invoke({ tenantId: TENANT, caller: CALLER, source, tool: tool("list_activities"), args: { oldest: "2026-10-23", limit: 5 } });

    expect(result).toEqual({ ok: true, status: 200, contentType: "application/json", data: [{ id: "i1", type: "Ride", moving_time: 3600 }] });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("https://intervals.icu/api/v1/athlete/0/activities?oldest=2026-10-23&limit=5");
    expect(calls[0]?.headers["authorization"]).toBe(`Basic ${Buffer.from(`API_KEY:${API_KEY}`).toString("base64")}`);
    expect(calls[0]?.headers["accept"]).toBe("application/json");
    expectNoSecret(result);
    expect(audit.events).toEqual([]); // reads are not audited
  });

  it("fails closed, with a clear error, when a tool's schema can't be compiled", async () => {
    const { fetch, calls } = fakeFetch(() => json([]));
    const t = tool("list_activities");
    const broken = { ...t, inputSchema: { type: "object", properties: { q: { type: "string", pattern: "^[a\\:]+$" } } } };
    const result = await runtime(fetch).invoke({ tenantId: TENANT, caller: CALLER, source, tool: broken, args: { q: "a" } });
    expect(result).toMatchObject({ ok: false, error: { kind: "unsupported", retryable: false } });
    expect(!result.ok && result.error.message).toContain("can't be checked");
    expect(calls).toHaveLength(0);
  });

  describe("input validation", () => {
    it.each([
      ["missing a required field", {}, "must have required property 'oldest'"],
      ["wrong type", { oldest: "2026-10-23", limit: "five" }, "/limit must be integer"],
      ["an unknown field", { oldest: "2026-10-23", api_key: "x" }, 'must NOT have additional properties "api_key"'],
      ["a pinned field (can't reach other athletes)", { oldest: "2026-10-23", id: "i-someone-else" }, '"id"'],
      ["not an object", "list everything", "must be object"],
    ])("rejects %s before any request", async (_name, args, message) => {
      const { fetch, calls } = fakeFetch(() => json([]));
      const result = await runtime(fetch).invoke({ tenantId: TENANT, caller: CALLER, source, tool: tool("list_activities"), args });
      expect(result).toMatchObject({ ok: false, error: { kind: "invalid_input", retryable: false } });
      expect(!result.ok && result.error.message).toContain(message);
      expect(calls).toHaveLength(0);
    });
  });

  it("reports missing credentials for a tenant with none stored", async () => {
    const { fetch, calls } = fakeFetch(() => json([]));
    const result = await runtime(fetch).invoke({ tenantId: TenantId.parse("tenant-new"), caller: CALLER, source, tool: tool("list_activities"), args: { oldest: "2026-10-23" } });
    expect(result).toMatchObject({ ok: false, error: { kind: "missing_credentials" } });
    expect(calls).toHaveLength(0);
  });

  it("passes the caller to the credential lookup", async () => {
    const seen: unknown[] = [];
    const credentials = { credentialsForSource: async (...args: unknown[]) => (seen.push(args), new Map()) };
    const { fetch } = fakeFetch(() => json([]));
    await runtime(fetch, { credentials }).invoke({ tenantId: TENANT, caller: CALLER, source, tool: tool("list_activities"), args: { oldest: "2026-10-23" } });
    expect(seen).toEqual([[TENANT, "intervals-icu", CALLER]]);
  });

  it("does not use another tenant's credentials", async () => {
    // tenant-me has a key; tenant-other does not and must not borrow it.
    const { fetch, calls } = fakeFetch(() => json([]));
    const result = await runtime(fetch).invoke({ tenantId: TenantId.parse("tenant-other"), caller: CALLER, source, tool: tool("list_activities"), args: { oldest: "2026-10-23" } });
    expect(!result.ok && result.error.kind).toBe("missing_credentials");
    expect(calls).toHaveLength(0);
  });

  describe("upstream errors", () => {
    it("passes the status and an excerpt, scrubbing any echoed key", async () => {
      const { fetch } = fakeFetch(() => new Response(`Invalid API key ${API_KEY}`, { status: 401 }));
      const result = await runtime(fetch).invoke({ tenantId: TENANT, caller: CALLER, source, tool: tool("get_activity"), args: { id: "i1" } });
      expect(result).toMatchObject({ ok: false, error: { kind: "upstream_error", status: 401, retryable: false } });
      expect(!result.ok && result.error.message).toContain("Invalid API key [redacted]");
      expectNoSecret(result);
    });

    it("marks 5xx as retryable", async () => {
      const { fetch } = fakeFetch(() => new Response("oops", { status: 502 }));
      const result = await runtime(fetch).invoke({ tenantId: TENANT, caller: CALLER, source, tool: tool("get_activity"), args: { id: "i1" } });
      expect(result).toMatchObject({ ok: false, error: { kind: "upstream_error", status: 502, retryable: true } });
    });
  });

  describe("throughput", () => {
    it("turns an upstream 429 into a retry hint and cools down the source for every tenant", async () => {
      const { fetch, calls } = fakeFetch(() => new Response("slow down", { status: 429, headers: { "retry-after": "20" } }));
      const rt = runtime(fetch);
      const first = await rt.invoke({ tenantId: TENANT, caller: CALLER, source, tool: tool("get_activity"), args: { id: "i1" } });
      expect(first).toMatchObject({ ok: false, error: { kind: "rate_limited", retryAfterSeconds: 20, retryable: true } });

      await vault.putCredential({ tenantId: TenantId.parse("tenant-friend"), sourceId: "intervals-icu", schemeId: "APIKey", credential: { kind: "basic", password: "friend-key" } });
      const friend = await rt.invoke({ tenantId: TenantId.parse("tenant-friend"), caller: CALLER, source, tool: tool("get_activity"), args: { id: "i2" } });
      expect(friend).toMatchObject({ ok: false, error: { kind: "rate_limited" } });
      expect(calls).toHaveLength(1); // the friend's call never left the process

      clockMs += 20_000;
      await rt.invoke({ tenantId: TENANT, caller: CALLER, source, tool: tool("get_activity"), args: { id: "i1" } });
      expect(calls).toHaveLength(2);
    });

    it("limits each tenant before the shared source limit", async () => {
      const { fetch, calls } = fakeFetch(() => json({}));
      const rt = runtime(fetch, {
        throughput: { perTenant: { requestsPerMinute: 2, maxConcurrent: 4 }, perSource: { requestsPerMinute: 100, maxConcurrent: 16 } },
      });
      const results: ToolResult[] = [];
      for (let i = 0; i < 3; i++) results.push(await rt.invoke({ tenantId: TENANT, caller: CALLER, source, tool: tool("get_activity"), args: { id: "i1" } }));
      expect(results.map((r) => r.ok)).toEqual([true, true, false]);
      expect(calls).toHaveLength(2);
    });
  });

  describe("writes", () => {
    const update = { id: "i1", body: { name: "Morning ride" } };

    it("records intent before and outcome after", async () => {
      const { fetch, calls } = fakeFetch(() => json({ id: "i1", name: "Morning ride" }));
      const result = await runtime(fetch).invoke({ tenantId: TENANT, caller: CALLER, source, tool: tool("update_activity"), args: update });
      expect(result.ok).toBe(true);
      expect(calls[0]).toMatchObject({ method: "PUT", url: "https://intervals.icu/api/v1/activity/i1", body: '{"name":"Morning ride"}' });
      expect(audit.events.map((e) => [e.phase, e.invocationId, e.operationId, e.outcome])).toEqual([
        ["intent", "inv-1", "update_activity", undefined],
        ["outcome", "inv-1", "update_activity", { ok: true, status: 200 }],
      ]);
      expect(audit.events[0]?.input).toEqual(update);
      expect(audit.events.map((e) => e.actorUserId)).toEqual([CALLER.userId, CALLER.userId]);
      expectNoSecret(audit.events);
    });

    it("records failed writes too", async () => {
      const { fetch } = fakeFetch(() => new Response("nope", { status: 403 }));
      await runtime(fetch).invoke({ tenantId: TENANT, caller: CALLER, source, tool: tool("update_activity"), args: update });
      expect(audit.events.at(-1)?.outcome).toEqual({ ok: false, errorKind: "upstream_error", status: 403 });
    });

    it("does not write if the audit log is unavailable", async () => {
      const broken: AuditSink = { record: async () => Promise.reject(new Error("db down")) };
      const { fetch, calls } = fakeFetch(() => json({}));
      const result = await runtime(fetch, { audit: broken }).invoke({ tenantId: TENANT, caller: CALLER, source, tool: tool("update_activity"), args: update });
      expect(result).toMatchObject({ ok: false, error: { kind: "audit_failed" } });
      expect(calls).toHaveLength(0);
    });
  });

  it("keeps path input from changing the host", async () => {
    // Host blocking itself is covered in egress.test.ts; here, input can't smuggle a host into the URL.
    const { fetch, calls } = fakeFetch(() => json({}));
    await runtime(fetch).invoke({ tenantId: TENANT, caller: CALLER, source, tool: tool("get_activity"), args: { id: "@evil.example.com" } });
    expect(calls[0]?.url).toBe("https://intervals.icu/api/v1/activity/%40evil.example.com");
  });
});
