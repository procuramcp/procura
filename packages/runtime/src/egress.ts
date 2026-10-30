import { fail, RuntimeFailure } from "./errors.ts";

/** The subset of `fetch` the runtime uses. Injected so tests and the egress proxy can replace it. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; redirect: "manual"; signal: AbortSignal },
) => Promise<Response>;

/**
 * Last check before a request leaves the process. The default allows the
 * source's own origin only. Milestone 3 adds a guard that resolves DNS and
 * blocks private, loopback, and link-local addresses (and rebinding).
 */
export interface EgressGuard {
  check(url: URL): Promise<void>;
}

export type EgressLimits = {
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
};

export const DEFAULT_EGRESS_LIMITS: EgressLimits = {
  timeoutMs: 15_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
};

export type OutboundRequest = {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
};

export type InboundResponse = {
  status: number;
  headers: Headers;
  body: Buffer;
};

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Send one request under the egress rules:
 * - https only, and only to `allowedOrigin` (the source's base URL), checked
 *   before the first request and before following each redirect;
 * - redirects are followed manually, same origin only, for GET/HEAD only;
 * - one overall timeout covers redirects and reading the body;
 * - the body is read as a stream and abandoned past `maxResponseBytes`.
 */
export async function send(
  request: OutboundRequest,
  options: { fetch: FetchLike; allowedOrigin: string; limits: EgressLimits; guard?: EgressGuard },
): Promise<InboundResponse> {
  const { limits } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  try {
    let url = request.url;
    let method = request.method;
    let body = request.body;
    for (let hop = 0; ; hop++) {
      await checkDestination(url, options.allowedOrigin, options.guard);
      let response: Response;
      try {
        response = await options.fetch(url.toString(), {
          method,
          headers: request.headers,
          ...(body !== undefined ? { body } : {}),
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (e) {
        if (controller.signal.aborted) fail("timeout", `upstream did not respond within ${limits.timeoutMs / 1000}s`);
        // The underlying message can include the URL (and a query-string API key), so it is not passed on.
        fail("network_error", `could not reach the upstream API (${errorCode(e)})`);
      }

      if (REDIRECTS.has(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) fail("invalid_upstream_response", `upstream sent a ${response.status} redirect without a location`);
        if (hop >= limits.maxRedirects) fail("egress_blocked", `too many redirects (limit ${limits.maxRedirects})`, { retryable: false });
        const next = new URL(location, url);
        if (method !== "GET" && method !== "HEAD" && response.status !== 303) {
          fail("egress_blocked", `upstream redirected a ${method} request; not followed, so the write may not have happened`, { retryable: false });
        }
        if (response.status === 303) {
          method = "GET";
          body = undefined;
        }
        url = next;
        continue;
      }

      return { status: response.status, headers: response.headers, body: await readCapped(response, limits.maxResponseBytes, controller) };
    }
  } catch (e) {
    if (e instanceof RuntimeFailure) throw e;
    if (controller.signal.aborted) fail("timeout", `upstream did not respond within ${limits.timeoutMs / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function checkDestination(url: URL, allowedOrigin: string, guard?: EgressGuard): Promise<void> {
  if (url.protocol !== "https:") fail("egress_blocked", "only https requests are allowed", { retryable: false });
  if (url.origin !== new URL(allowedOrigin).origin) {
    // Name the host, never the full URL.
    fail("egress_blocked", `request to ${url.host} blocked: this source may only call ${new URL(allowedOrigin).host}`, { retryable: false });
  }
  if (url.username || url.password) fail("egress_blocked", "URLs with embedded credentials are not allowed", { retryable: false });
  await guard?.check(url);
}

async function readCapped(response: Response, max: number, controller: AbortController): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    controller.abort();
    fail("response_too_large", tooLarge(max), { retryable: false });
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      controller.abort();
      fail("response_too_large", tooLarge(max), { retryable: false });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function tooLarge(max: number): string {
  return `upstream response is larger than ${Math.round(max / 1024)} KB; narrow the request (e.g. a shorter date range, fewer fields, or a limit)`;
}

function errorCode(e: unknown): string {
  const cause = e instanceof Error ? (e.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === "string" ? cause.code : "connection failed";
}
