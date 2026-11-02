import { describe, expect, it } from "vitest";
import { BodyError, dispatch, json, readCookie, readForm, readJson, safeEqual, setCookie, sha256Base64url, sha256Hex, type Route } from "./index.ts";

const post = (body: string, headers: Record<string, string> = {}) => new Request("https://x.test/", { method: "POST", body, headers });

describe("http helpers", () => {
  it("json responses are uncached and unsniffable", async () => {
    const r = json(201, { a: 1 }, { "x-extra": "1" });
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-extra")).toBe("1");
    expect(await r.json()).toEqual({ a: 1 });
  });

  it("reads JSON under the cap and refuses oversized or malformed bodies", async () => {
    expect(await readJson(post('{"a":1}'), 100)).toEqual({ a: 1 });
    await expect(readJson(post("x".repeat(101)), 100)).rejects.toBeInstanceOf(BodyError);
    await expect(readJson(post("{nope"), 100)).rejects.toThrow("must be JSON");
  });

  it("reads forms only when the content type says so", async () => {
    expect(await readForm(post("a=1"), 100)).toBeUndefined();
    expect((await readForm(post("a=1&b=2", { "content-type": "application/x-www-form-urlencoded" }), 100))?.get("b")).toBe("2");
  });

  it("reads and writes cookies", () => {
    const request = new Request("https://x.test/", { headers: { cookie: "a=1; b=x=y; c=" } });
    expect(readCookie(request, "b")).toBe("x=y");
    expect(readCookie(request, "c")).toBeUndefined();
    expect(setCookie("s", "v", { path: "/", maxAgeSeconds: 60, secure: true })).toBe("s=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure");
  });

  it("hashes in both stored encodings and compares safely", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Base64url("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "ab")).toBe(false);
  });

  it("dispatches to the first matching route with its captures", async () => {
    const routes: Route<string>[] = [
      { method: "GET", path: /^\/a\/([^/]+)$/, handle: async (c, [id]) => json(200, { c, id }) },
      { method: ["PUT", "DELETE"], path: /^\/a\/([^/]+)$/, handle: async () => json(200, { deleted: true }) },
    ];
    expect(await (await dispatch(routes, "ctx", "GET", "/a/7"))?.json()).toEqual({ c: "ctx", id: "7" });
    expect(await (await dispatch(routes, "ctx", "DELETE", "/a/7"))?.json()).toEqual({ deleted: true });
    expect(dispatch(routes, "ctx", "POST", "/a/7")).toBeUndefined();
  });
});
