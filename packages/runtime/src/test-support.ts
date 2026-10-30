// Shared helpers for runtime tests. Not exported from the package index.
import type { FetchLike } from "./egress.ts";

export type RecordedCall = { url: string; method: string; headers: Record<string, string>; body?: string };

/** A fake upstream: answers each call with the next handler's response and records what was sent. */
export function fakeFetch(...handlers: Array<(call: RecordedCall) => Response | Promise<Response>>) {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: RecordedCall = { url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) };
    calls.push(call);
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    if (!handler) throw new Error("no handler");
    if (init.signal.aborted) throw new DOMException("aborted", "AbortError");
    return handler(call);
  };
  return { fetch, calls };
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
