// The built single-page app (packages/web/dist) under /app, and plain error pages.
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const APP_HEADERS: Record<string, string> = {
  // Scripts only from this origin. Inline styles are allowed: Radix and the code view set them.
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

const NOT_BUILT = "The console isn't built. Run: pnpm --filter @procura/web build";

/** A one-line HTML page with a link back to the console. */
export function page(status: number, message: string): Response {
  const escaped = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(`<!doctype html><meta charset="utf-8"><title>procura</title><p>${escaped}. <a href="/app/">Back to the console</a></p>`, {
    status,
    headers: { ...APP_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Serves files from the built app. Paths can't leave the directory; client-side
 * routes get index.html; hashed assets are cached for good, everything else never.
 */
export function staticFiles(dir: string | undefined): (path: string) => Promise<Response> {
  const root = dir ? resolve(dir) : undefined;
  return async (path) => {
    if (!root) return page(404, NOT_BUILT);
    let decoded;
    try {
      decoded = decodeURIComponent(path.replace(/^\/app\/?/, ""));
    } catch {
      return page(404, "Not found"); // malformed %-encoding
    }
    const relative = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
    let file = join(root, relative);
    if (!file.startsWith(root + sep) && file !== root) return page(404, "Not found");
    const isFile = await stat(file).then((s) => s.isFile(), () => false);
    // Client-side routes get the app shell; missing assets get a 404.
    if (!isFile) {
      if (relative.startsWith("assets")) return page(404, "Not found");
      file = join(root, "index.html");
    }
    let content;
    try {
      content = await readFile(file);
    } catch {
      return page(404, NOT_BUILT);
    }
    const hashed = file.includes(`${sep}assets${sep}`);
    return new Response(new Uint8Array(content), {
      status: 200,
      headers: { ...APP_HEADERS, "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-store" },
    });
  };
}
