import { randomUUID } from "node:crypto";
import type { Caller, Instant, JsonSchema, JsonValue, ResolvedTool, Source, TenantId } from "@cairnmcp/core";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { Credential } from "@cairnmcp/vault";
import { applyAuth } from "./auth.ts";
import type { AuditEvent, AuditSink } from "./audit.ts";
import { send, DEFAULT_EGRESS_LIMITS, type EgressGuard, type EgressLimits, type FetchLike } from "./egress.ts";
import { fail, RuntimeFailure, type RuntimeError } from "./errors.ts";
import { parseRetryAfter, type LimitSettings, type RateLimiter } from "./limiter.ts";
import { buildRequest } from "./request.ts";

/**
 * What the runtime needs from the vault: decrypted credentials for one source,
 * by scheme id. `caller` is passed so on-behalf-of providers (milestone 3b) can
 * derive credentials from the caller's identity; the vault ignores it.
 */
export interface CredentialSource {
  credentialsForSource(tenantId: TenantId, sourceId: string, caller: Caller): Promise<Map<string, Credential>>;
}

export type ThroughputSettings = {
  /** Per tenant and source: one tenant can't starve others. */
  perTenant: LimitSettings;
  /** Per source across all tenants: everyone shares our egress IP, which upstreams rate-limit. */
  perSource: LimitSettings;
};

/**
 * Conservative defaults. Intervals.icu's real limits are still unconfirmed
 * (see ROADMAP open items); these stay well under typical per-IP limits.
 */
export const DEFAULT_THROUGHPUT: ThroughputSettings = {
  perTenant: { requestsPerMinute: 60, maxConcurrent: 4 },
  perSource: { requestsPerMinute: 300, maxConcurrent: 16 },
};

export type RuntimeOptions = {
  fetch: FetchLike;
  credentials: CredentialSource;
  limiter: RateLimiter;
  audit: AuditSink;
  /** Current time as an Instant. Injected for tests. */
  now?: () => Instant;
  newId?: () => string;
  limits?: Partial<EgressLimits>;
  throughput?: ThroughputSettings;
  guard?: EgressGuard;
};

export type ToolResult =
  | { ok: true; status: number; contentType?: string; data: JsonValue }
  | { ok: false; error: RuntimeError };

export type Invocation = {
  tenantId: TenantId;
  /** Who is calling. Authorization (canCall) happens before invoke; this is for credentials and audit. */
  caller: Caller;
  source: Source;
  tool: ResolvedTool;
  /** The agent's arguments, untrusted. */
  args: unknown;
};

const UPSTREAM_ERROR_EXCERPT = 2000;

export class Runtime {
  readonly #o: Required<Omit<RuntimeOptions, "guard" | "limits">> & { guard?: EgressGuard; limits: EgressLimits };
  readonly #validators = new WeakMap<object, ValidateFunction>();
  readonly #ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });

  constructor(options: RuntimeOptions) {
    this.#o = {
      now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z") as Instant,
      newId: randomUUID,
      throughput: DEFAULT_THROUGHPUT,
      ...options,
      limits: { ...DEFAULT_EGRESS_LIMITS, ...options.limits },
    };
  }

  /**
   * Run one tool call. Never throws for expected failures: they come back as
   * `{ ok: false, error }` with a message the agent can act on.
   */
  async invoke(call: Invocation): Promise<ToolResult> {
    const { tenantId, caller, source, tool } = call;
    const op = tool.operation;
    const isWrite = op.sideEffect.class !== "read";
    const invocationId = this.#o.newId();
    let input: Record<string, unknown> | undefined;
    let auditBase: Omit<AuditEvent, "at" | "phase" | "outcome"> | undefined;
    let release: (() => void) | undefined;

    try {
      // 1. Validate what the agent sent against the schema it was shown (pinned inputs hidden).
      this.#validate(tool.inputSchema, call.args, "input");
      // 2. Add pinned inputs, then validate the full operation input.
      input = { ...(call.args as Record<string, unknown>), ...tool.pinnedInputs };
      this.#validate(op.input, input, "input with pinned values");

      // 3. Throttle before touching credentials or the network.
      const keys = [
        { key: `tenant:${tenantId}:source:${source.id}`, limits: this.#o.throughput.perTenant },
        { key: `source:${source.id}`, limits: this.#o.throughput.perSource },
      ];
      const slot = this.#o.limiter.acquire(keys);
      if (!slot.ok) {
        fail("rate_limited", `too many requests to ${source.name} right now; retry in ${slot.retryAfterSeconds}s`, {
          retryAfterSeconds: slot.retryAfterSeconds,
        });
      }
      release = slot.release;

      // 4. Build the request and attach credentials.
      const plan = buildRequest(op, input);
      const credentials = await this.#o.credentials.credentialsForSource(tenantId, source.id, caller);
      const auth = applyAuth(op.auth ?? source.defaultAuth, source.authSchemes, credentials, this.#o.now());

      const url = new URL(source.baseUrl + plan.pathAndQuery);
      for (const [name, value] of auth.query) url.searchParams.append(name, value.reveal());
      const headers: Record<string, string> = { ...plan.headers };
      for (const [name, value] of Object.entries(auth.headers)) headers[name] = value.reveal();
      const cookies = [...plan.cookies, ...auth.cookies.map(([n, v]) => `${n}=${encodeURIComponent(v.reveal())}`)];
      if (cookies.length > 0) headers["cookie"] = cookies.join("; ");

      // 5. Writes are recorded before they happen; if the log is down, the write doesn't happen.
      if (isWrite) {
        auditBase = {
          invocationId,
          tenantId,
          actorUserId: caller.userId,
          sourceId: source.id,
          toolName: tool.name,
          operationId: op.id,
          sideEffect: op.sideEffect.class,
          method: op.mapping.method,
          pathTemplate: op.mapping.pathTemplate,
          input: input as JsonValue,
        };
        await this.#audit({ ...auditBase, at: this.#o.now(), phase: "intent" }, true);
      }

      // 6. Send under egress rules.
      const response = await send(
        { method: plan.method, url, headers, ...(plan.body !== undefined ? { body: plan.body } : {}) },
        { fetch: this.#o.fetch, allowedOrigin: source.baseUrl, limits: this.#o.limits, ...(this.#o.guard ? { guard: this.#o.guard } : {}) },
      );

      // 7. Back off when the upstream says so (applies to every tenant: the limit is usually per IP).
      if (response.status === 429 || response.status === 503) {
        const wait = parseRetryAfter(response.headers.get("retry-after"), Date.parse(this.#o.now())) ?? (response.status === 429 ? 30 : undefined);
        if (wait !== undefined) for (const { key } of keys) this.#o.limiter.coolDown(key, wait);
        if (response.status === 429) {
          fail("rate_limited", `${source.name} is rate limiting requests; retry in ${wait}s`, { retryAfterSeconds: wait!, status: 429 });
        }
      }

      const result = this.#decode(response.status, response.headers, response.body, op.mapping.response.decode, auth.secrets.map((s) => s.reveal()));
      if (auditBase) await this.#audit({ ...auditBase, at: this.#o.now(), phase: "outcome", outcome: outcomeOf(result) }, false);
      return result;
    } catch (e) {
      const error: RuntimeError =
        e instanceof RuntimeFailure ? e.error : { kind: "network_error", message: "unexpected runtime error", retryable: false };
      const result: ToolResult = { ok: false, error };
      if (auditBase && error.kind !== "audit_failed") {
        await this.#audit({ ...auditBase, at: this.#o.now(), phase: "outcome", outcome: outcomeOf(result) }, false);
      }
      return result;
    } finally {
      release?.();
    }
  }

  #validate(schema: JsonSchema, value: unknown, what: string): void {
    let validate = this.#validators.get(schema);
    if (!validate) {
      validate = this.#ajv.compile(schema);
      this.#validators.set(schema, validate);
    }
    if (validate(value)) return;
    const details = (validate.errors ?? []).slice(0, 5).map((e) => {
      const where = e.instancePath || "(root)";
      const extra = e.keyword === "additionalProperties" ? ` "${String((e.params as { additionalProperty?: string }).additionalProperty)}"` : "";
      return `${where} ${e.message ?? "is invalid"}${extra}`;
    });
    fail("invalid_input", `invalid ${what}: ${details.join("; ")}`, { retryable: false, details });
  }

  #decode(status: number, headers: Headers, body: Buffer, decode: string, secrets: string[]): ToolResult {
    const contentType = headers.get("content-type") ?? undefined;
    if (status < 200 || status >= 300) {
      const excerpt = scrub(body.toString("utf8").slice(0, UPSTREAM_ERROR_EXCERPT), secrets);
      fail("upstream_error", `upstream returned HTTP ${status}${excerpt ? `: ${excerpt}` : ""}`, {
        status,
        retryable: status >= 500,
      });
    }
    const ct = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
    const as =
      decode !== "auto" ? decode : body.length === 0 ? "none" : ct === "application/json" || ct.endsWith("+json") ? "json" : ct.startsWith("text/") ? "text" : "binary";
    const base = { ok: true as const, status, ...(contentType ? { contentType } : {}) };
    switch (as) {
      case "none":
        return { ...base, data: null };
      case "json":
        if (body.length === 0) return { ...base, data: null };
        try {
          return { ...base, data: JSON.parse(body.toString("utf8")) as JsonValue };
        } catch {
          return fail("invalid_upstream_response", "upstream said JSON but the body did not parse", { retryable: false });
        }
      case "text":
        return { ...base, data: scrub(body.toString("utf8"), secrets) };
      default:
        return { ...base, data: { encoding: "base64", bytes: body.length, base64: body.toString("base64") } };
    }
  }

  async #audit(event: AuditEvent, required: boolean): Promise<void> {
    try {
      await this.#o.audit.record(event);
    } catch {
      if (required) fail("audit_failed", "the action was not attempted because it could not be recorded in the audit log", { retryable: true });
      // An outcome that fails to record is left as intent-only, which reviewers treat as "unknown result".
    }
  }
}

function outcomeOf(result: ToolResult): NonNullable<AuditEvent["outcome"]> {
  return result.ok
    ? { ok: true, status: result.status }
    : { ok: false, errorKind: result.error.kind, ...(result.error.status !== undefined ? { status: result.error.status } : {}) };
}

/** Replace any credential value the upstream echoed back (some APIs include the key in error messages). */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("[redacted]");
  return out;
}
