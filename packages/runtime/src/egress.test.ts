import { describe, expect, it } from "vitest";
import { send, type EgressLimits } from "./egress.ts";
import { RuntimeFailure } from "./errors.ts";
import { fakeFetch, json } from "./test-support.ts";

const ORIGIN = "https://intervals.icu";
const limits: EgressLimits = { timeoutMs: 200, maxResponseBytes: 1024, maxRedirects: 2 };
const get = (url: string) => ({ method: "GET", url: new URL(url), headers: {} });

async function errorOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof RuntimeFailure) return e.error;
    throw e;
  }
  throw new Error("expected failure");
}

describe("send", () => {
  it("sends to the allowed origin", async () => {
    const { fetch, calls } = fakeFetch(() => json({ ok: 1 }));
    const r = await send(get(`${ORIGIN}/api/v1/athlete/0`), { fetch, allowedOrigin: ORIGIN, limits });
    expect(r.status).toBe(200);
    expect(calls[0]?.url).toBe(`${ORIGIN}/api/v1/athlete/0`);
  });

  it.each([
    ["another host", "https://evil.example.com/x"],
    ["a lookalike subdomain", "https://intervals.icu.evil.example.com/x"],
    ["plain http", "http://intervals.icu/x"],
    ["another port", "https://intervals.icu:8443/x"],
  ])("blocks %s before sending anything", async (_name, url) => {
    const { fetch, calls } = fakeFetch(() => json({}));
    expect((await errorOf(send(get(url), { fetch, allowedOrigin: ORIGIN, limits }))).kind).toBe("egress_blocked");
    expect(calls).toHaveLength(0);
  });

  it("follows same-origin redirects for reads", async () => {
    const { fetch, calls } = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: "/api/v1/other" } }),
      () => json({ moved: true }),
    );
    const r = await send(get(`${ORIGIN}/api/v1/x`), { fetch, allowedOrigin: ORIGIN, limits });
    expect(JSON.parse(r.body.toString())).toEqual({ moved: true });
    expect(calls.map((c) => c.url)).toEqual([`${ORIGIN}/api/v1/x`, `${ORIGIN}/api/v1/other`]);
  });

  it("does not follow a redirect to another host (credentials would go with it)", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal" } }));
    expect((await errorOf(send(get(`${ORIGIN}/x`), { fetch, allowedOrigin: ORIGIN, limits }))).kind).toBe("egress_blocked");
    expect(calls).toHaveLength(1);
  });

  it("does not follow redirects on writes", async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 307, headers: { location: "/elsewhere" } }));
    const e = await errorOf(send({ method: "PUT", url: new URL(`${ORIGIN}/x`), headers: {}, body: "{}" }, { fetch, allowedOrigin: ORIGIN, limits }));
    expect(e).toMatchObject({ kind: "egress_blocked", retryable: false });
    expect(e.message).toContain("write may not have happened");
  });

  it("stops after too many redirects", async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 302, headers: { location: "/loop" } }));
    expect((await errorOf(send(get(`${ORIGIN}/loop`), { fetch, allowedOrigin: ORIGIN, limits }))).kind).toBe("egress_blocked");
  });

  it("caps response size from content-length", async () => {
    const { fetch } = fakeFetch(() => new Response("x", { headers: { "content-length": "999999" } }));
    expect((await errorOf(send(get(`${ORIGIN}/x`), { fetch, allowedOrigin: ORIGIN, limits }))).kind).toBe("response_too_large");
  });

  it("caps response size while streaming when content-length is missing or wrong", async () => {
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(512));
      },
    });
    const { fetch } = fakeFetch(() => new Response(stream));
    expect((await errorOf(send(get(`${ORIGIN}/x`), { fetch, allowedOrigin: ORIGIN, limits }))).kind).toBe("response_too_large");
  });

  it("times out", async () => {
    const fetch = (_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    expect(await errorOf(send(get(`${ORIGIN}/x`), { fetch, allowedOrigin: ORIGIN, limits }))).toMatchObject({ kind: "timeout", retryable: true });
  });

  it("reports network errors without the URL (it may carry an API key)", async () => {
    const fetch = async () => {
      throw new TypeError("fetch failed: https://intervals.icu/x?key=SECRET", { cause: { code: "ECONNRESET" } });
    };
    const e = await errorOf(send(get(`${ORIGIN}/x?key=SECRET`), { fetch, allowedOrigin: ORIGIN, limits }));
    expect(e.kind).toBe("network_error");
    expect(e.message).toContain("ECONNRESET");
    expect(e.message).not.toContain("SECRET");
  });

  it("runs the guard on every hop", async () => {
    const seen: string[] = [];
    const guard = { check: async (u: URL) => void seen.push(u.pathname) };
    const { fetch } = fakeFetch(() => new Response(null, { status: 301, headers: { location: "/b" } }), () => json({}));
    await send(get(`${ORIGIN}/a`), { fetch, allowedOrigin: ORIGIN, limits, guard });
    expect(seen).toEqual(["/a", "/b"]);
  });
});
