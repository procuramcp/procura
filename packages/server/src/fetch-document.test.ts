// Fetching API descriptions from untrusted URLs (D-035): the address checks,
// and finding the document behind a Swagger UI page or a base URL.
import { describe, expect, it } from "vitest";
import { discoverDocument, FetchRefused, isPublicAddress, looksLikeOpenApi, publicFetch, vetUrl, type DocumentGetter } from "./fetch-document.ts";

const OPENAPI = JSON.stringify({ openapi: "3.0.1", info: { title: "T", version: "1" }, paths: {} });

/** A fake web: URL -> body. Anything else is a 404. */
function web(pages: Record<string, string>): DocumentGetter & { calls: string[] } {
  const calls: string[] = [];
  const get = (async (url: string) => {
    calls.push(url);
    const text = pages[url];
    return text === undefined ? { url, status: 404, contentType: "text/plain", text: "" } : { url, status: 200, contentType: "application/json", text };
  }) as DocumentGetter & { calls: string[] };
  get.calls = calls;
  return get;
}

describe("address checks", () => {
  it("allows public addresses only", () => {
    for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPublicAddress(a), a).toBe(true);
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "nonsense"]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });

  it("refuses non-https, odd ports, credentials, and names that point inward", async () => {
    const resolve = (async (host: string) => (host === "inward.test" ? [{ address: "10.0.0.5", family: 4 }, { address: "8.8.8.8", family: 4 }] : [{ address: "93.184.215.14", family: 4 }])) as never;
    await expect(vetUrl("http://example.com/x", resolve)).rejects.toThrow(/only https/);
    await expect(vetUrl("https://example.com:8443/x", resolve)).rejects.toThrow(/port/);
    await expect(vetUrl("https://u:p@example.com/x", resolve)).rejects.toThrow(/username or password/);
    await expect(vetUrl("https://169.254.169.254/latest/meta-data", resolve)).rejects.toThrow(/private or internal/);
    await expect(vetUrl("https://[::1]/x", resolve)).rejects.toThrow(/private or internal/);
    await expect(vetUrl("https://inward.test/x", resolve)).rejects.toThrow(/private or internal/);
    await expect(vetUrl("not a url", resolve)).rejects.toThrow(FetchRefused);
    expect((await vetUrl("https://example.com/openapi.json", resolve)).address).toBe("93.184.215.14");
  });
  it("refuses unsafe sign-in provider URLs before connecting (D-040)", async () => {
    await expect(publicFetch("http://login.example.com/token", { method: "POST" })).rejects.toThrow(/only https/);
    await expect(publicFetch("https://127.0.0.1/userinfo")).rejects.toThrow(/private or internal/);
    await expect(publicFetch("https://169.254.169.254/latest/meta-data")).rejects.toThrow(/private or internal/);
  });
});

describe("finding the document", () => {
  it("recognizes OpenAPI and Swagger, in JSON or YAML", () => {
    expect(looksLikeOpenApi(OPENAPI)).toBe(true);
    expect(looksLikeOpenApi("openapi: 3.1.0\ninfo: {}")).toBe(true);
    expect(looksLikeOpenApi('{"swagger":"2.0"}')).toBe(true);
    expect(looksLikeOpenApi("<html>docs</html>")).toBe(false);
  });

  it("takes a URL that is the document", async () => {
    const get = web({ "https://api.test/openapi.json": OPENAPI });
    expect(await discoverDocument("https://api.test/openapi.json", get)).toMatchObject({ documentUrl: "https://api.test/openapi.json", via: "the URL is the document" });
  });

  it("follows a Swagger UI page to its document through swagger-config (the Intervals.icu shape)", async () => {
    const get = web({
      "https://intervals.test/api/v1/docs/swagger-ui/index.html": "<html><script src='./swagger-initializer.js'></script></html>",
      "https://intervals.test/api/v1/docs/swagger-config": JSON.stringify({ configUrl: "/api/v1/docs/swagger-config", url: "/api/v1/docs" }),
      "https://intervals.test/api/v1/docs": OPENAPI,
    });
    const found = await discoverDocument("https://intervals.test/api/v1/docs/swagger-ui/index.html", get);
    expect(found).toMatchObject({ documentUrl: "https://intervals.test/api/v1/docs", via: "Swagger UI's config" });
  });

  it("tries the common paths under a base URL, and stops after a dozen", async () => {
    const get = web({ "https://api.test/v3/api-docs": OPENAPI });
    expect((await discoverDocument("https://api.test/", get)).documentUrl).toBe("https://api.test/v3/api-docs");
    const nothing = web({});
    await expect(discoverDocument("https://empty.test/some/path", nothing)).rejects.toThrow(/no OpenAPI document found/);
    expect(nothing.calls.length).toBeLessThanOrEqual(12);
  });

  it("refuses when the typed URL itself isn't allowed", async () => {
    const get: DocumentGetter = async () => {
      throw new FetchRefused("internal.test points to a private or internal address");
    };
    await expect(discoverDocument("https://internal.test/", get)).rejects.toThrow(/private or internal/);
  });
});
