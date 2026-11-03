// Fetch an API description from a URL someone typed into the console (D-035),
// and find the OpenAPI document behind a Swagger UI page or an API's base URL.
//
// The URL is untrusted: it must not reach this server's own network (cloud
// metadata, the database, localhost). So: https only; the host is resolved
// once and every address must be public; the connection is pinned to that
// address (no DNS rebinding between the check and the request); redirects are
// re-checked hop by hop; and the size and time are capped.
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

export const MAX_DOCUMENT_FETCH_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;

export class FetchRefused extends Error {}

export type Fetched = { url: string; status: number; contentType: string; text: string };
/** One GET of an untrusted URL. Injected in tests. */
export type DocumentGetter = (url: string) => Promise<Fetched>;

// Addresses a URL from outside must never reach.
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, including cloud metadata (169.254.169.254)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
// IPv4-mapped IPv6 (::ffff:a.b.c.d) is checked as IPv4 in isPublicAddress, not listed here:
// BlockList matches every IPv4 address against an ::ffff:0:0/96 rule.
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** Whether an IP address is on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]!);
    return !blocked.check(address, "ipv6");
  }
  return false;
}

/** Check a URL and resolve its host to one public address, or refuse. */
export async function vetUrl(raw: string, resolve = lookup): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchRefused("that isn't a URL");
  }
  if (url.protocol !== "https:") throw new FetchRefused("only https URLs can be fetched");
  if (url.username || url.password) throw new FetchRefused("URLs with a username or password aren't fetched");
  if (url.port && url.port !== "443") throw new FetchRefused("only the standard https port (443) is allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) as 4 | 6 }] : await resolve(host, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new FetchRefused(`couldn't find ${host}`);
  // Every address must be public, so a name that also points inward is refused outright.
  const inward = addresses.find((a) => !isPublicAddress(a.address));
  if (inward) throw new FetchRefused(`${host} points to a private or internal address`);
  const first = addresses[0]!;
  return { url, address: first.address, family: first.family === 6 ? 6 : 4 };
}

/** GET an untrusted https URL safely (see the top of this file). */
export const safeGet: DocumentGetter = async (raw) => {
  let current = raw;
  const deadline = Date.now() + TIMEOUT_MS;
  for (let hop = 0; ; hop++) {
    const { url, address, family } = await vetUrl(current);
    const response = await getPinned(url, address, family, Math.max(1, deadline - Date.now()));
    if (response.status >= 300 && response.status < 400 && response.location) {
      if (hop >= MAX_REDIRECTS) throw new FetchRefused("too many redirects");
      current = new URL(response.location, url).toString();
      continue;
    }
    return { url: url.toString(), status: response.status, contentType: response.contentType, text: response.text };
  }
};

function getPinned(url: URL, address: string, family: 4 | 6, timeoutMs: number): Promise<{ status: number; contentType: string; text: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: { accept: "application/json, application/yaml, text/yaml, text/html;q=0.5, */*;q=0.1", "user-agent": "procura-ingest" },
        // Connect to the address we checked, whatever DNS says now. TLS still verifies the hostname.
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) =>
          opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)) as never,
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers["content-type"] ?? "");
        const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_DOCUMENT_FETCH_BYTES) {
            req.destroy(new FetchRefused(`the document is larger than ${MAX_DOCUMENT_FETCH_BYTES / 1024 / 1024} MB`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, contentType, text: Buffer.concat(chunks).toString("utf8"), ...(location ? { location } : {}) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new FetchRefused("the server took too long to answer")));
    req.on("error", (e) => reject(e instanceof FetchRefused ? e : new FetchRefused(`couldn't fetch ${url.host}: ${e.message}`)));
    req.end();
  });
}

// --- Discovery ----------------------------------------------------------------------------

export type Discovered = { documentUrl: string; text: string; via: string; tried: string[] };

/** Whether text parses as an OpenAPI or Swagger document (cheap check; the ingestor does the rest). */
export function looksLikeOpenApi(text: string): boolean {
  const head = text.trimStart();
  if (head.startsWith("{")) {
    try {
      const doc = JSON.parse(head) as Record<string, unknown>;
      return typeof doc["openapi"] === "string" || typeof doc["swagger"] === "string";
    } catch {
      return false;
    }
  }
  return /^(openapi|swagger)\s*:/m.test(head.slice(0, 4096));
}

const COMMON_PATHS = ["/openapi.json", "/openapi.yaml", "/swagger.json", "/v3/api-docs", "/api-docs", "/docs/openapi.json"];

/**
 * Find the OpenAPI document for a URL: the document itself, a Swagger UI page
 * (through its swagger-config), or an API's base URL (common paths). Tries at
 * most a dozen URLs, all through `get`.
 */
export async function discoverDocument(input: string, get: DocumentGetter = safeGet): Promise<Discovered> {
  const tried: string[] = [];
  const attempt = async (url: string): Promise<Fetched | undefined> => {
    if (tried.includes(url) || tried.length >= 12) return undefined;
    tried.push(url);
    try {
      const r = await get(url);
      return r.status >= 200 && r.status < 300 ? r : undefined;
    } catch (e) {
      // The URL the person typed must itself be allowed; later guesses may just fail.
      if (tried.length === 1 && e instanceof FetchRefused) throw e;
      return undefined;
    }
  };
  const found = (r: Fetched, via: string): Discovered => ({ documentUrl: r.url, text: r.text, via, tried });

  const first = await attempt(input);
  if (first && looksLikeOpenApi(first.text)) return found(first, "the URL is the document");

  // A Swagger UI page: ask its config where the document is.
  const base = new URL(first?.url ?? input);
  const uiPrefix = base.pathname.includes("/swagger-ui") ? base.pathname.slice(0, base.pathname.indexOf("/swagger-ui")) : undefined;
  const configs = [
    ...(uiPrefix !== undefined ? [`${uiPrefix}/swagger-config`] : []),
    ...[...(first?.text ?? "").matchAll(/["']?configUrl["']?\s*[:=]\s*["']([^"']+)["']/g)].map((m) => m[1]!),
  ];
  for (const configPath of configs) {
    const config = await attempt(new URL(configPath, base).toString());
    if (!config) continue;
    let docPath: string | undefined;
    try {
      const c = JSON.parse(config.text) as { url?: unknown; urls?: Array<{ url?: unknown }> };
      docPath = typeof c.url === "string" ? c.url : typeof c.urls?.[0]?.url === "string" ? (c.urls[0].url as string) : undefined;
    } catch {
      continue;
    }
    if (!docPath) continue;
    const doc = await attempt(new URL(docPath, config.url).toString());
    if (doc && looksLikeOpenApi(doc.text)) return found(doc, "Swagger UI's config");
  }
  // A Swagger UI page that names its document directly (url: "..."), ignoring the petstore placeholder.
  for (const m of (first?.text ?? "").matchAll(/\burl\s*:\s*["']([^"']+\.(?:json|ya?ml))["']/g)) {
    if (m[1]!.includes("petstore")) continue;
    const doc = await attempt(new URL(m[1]!, base).toString());
    if (doc && looksLikeOpenApi(doc.text)) return found(doc, "the Swagger UI page");
  }

  // A base URL: the usual places, under the given path and at the root.
  const prefixes = [...new Set([uiPrefix ?? base.pathname.replace(/\/$/, ""), ""])];
  for (const prefix of prefixes) {
    for (const path of COMMON_PATHS) {
      const doc = await attempt(new URL(`${prefix}${path}`, base).toString());
      if (doc && looksLikeOpenApi(doc.text)) return found(doc, `the common path ${path}`);
    }
  }
  throw new FetchRefused(`no OpenAPI document found at ${input} (tried ${tried.length} URLs)`);
}
