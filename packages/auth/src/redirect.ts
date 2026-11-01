// Which redirect URIs a client may register, and how a requested one is matched.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Schemes that run code or read local data if a browser follows them.
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "filesystem:", "ws:", "wss:", "ftp:"]);

/**
 * Allowed: https URLs; http only on a loopback host (RFC 8252 §7.3, native
 * apps on a local port); and private-use schemes for native apps (§7.1, e.g.
 * `cursor://...`). Never a fragment, credentials, or a dangerous scheme.
 * Returns why a URI is refused, or undefined if it is allowed.
 */
export function redirectUriProblem(uri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "is not a valid URL";
  }
  if (url.hash) return "must not have a fragment";
  if (url.username || url.password) return "must not contain credentials";
  if (url.protocol === "https:") return url.hostname ? undefined : "must have a host";
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname) ? undefined : "http is allowed only for localhost";
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return `scheme ${url.protocol} is not allowed`;
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) ? undefined : "has an invalid scheme";
}

/**
 * Whether `requested` matches a registered URI: exactly, except that a
 * loopback http URI may use any port (native apps pick a free port each run).
 */
export function matchesRegistered(requested: string, registered: string[]): boolean {
  if (registered.includes(requested)) return true;
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (want.protocol !== "http:" || !LOOPBACK.has(want.hostname)) return false;
  return registered.some((r) => {
    const have = new URL(r);
    return have.protocol === "http:" && have.hostname === want.hostname && have.pathname === want.pathname && have.search === want.search;
  });
}
