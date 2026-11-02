// Minimal server-rendered pages for sign-in and consent. Every value is
// escaped; pages can't be framed (the consent button must not be clickjacked)
// and load nothing from elsewhere.

const STYLE = `
:root{color-scheme:light dark;--fg:#1b1b1f;--muted:#5d5d66;--bg:#fafaf9;--card:#fff;--line:#e3e3e0;--accent:#2f5d50;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--fg:#ececee;--muted:#a3a3ad;--bg:#141416;--card:#1d1d20;--line:#2e2e33;--accent:#7fb8a6;--accent-fg:#0d1513}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:28rem;margin:10vh auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:1.25rem;margin:0 0 12px}p{margin:0 0 12px;color:var(--muted)}strong{color:var(--fg);font-weight:600}
dl{margin:16px 0;display:grid;grid-template-columns:auto 1fr;gap:6px 16px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.actions{display:flex;flex-direction:column;gap:10px;margin-top:20px}
button,.button{display:block;width:100%;padding:11px 14px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);font:inherit;text-align:center;text-decoration:none;cursor:pointer}
.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}
.brand{font-weight:700;letter-spacing:.02em;margin-bottom:16px;color:var(--muted)}`;

export const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  // Not no-referrer: with it, browsers send `Origin: null` on the consent form's
  // post, which the cross-site check refuses. same-origin keeps the URLs (with
  // codes and state) from leaking to other sites all the same.
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · cairnmcp</title><style>${STYLE}</style></head>
<body><main><div class="brand">cairnmcp</div><div class="card">${body}</div></main></body></html>`;
}

export function htmlResponse(status: number, html: string, headers: Record<string, string> = {}): Response {
  return new Response(html, { status, headers: { ...PAGE_HEADERS, ...headers } });
}

export function errorPage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

/** Signed in, but no access: show the account id, which is what an owner needs to grant access. */
export function noAccessPage(input: { userLabel: string; userId: string }): string {
  return page(
    "No access",
    `<h1>No access</h1><p>${escapeHtml(input.userLabel)} doesn't have access to this toolset. Ask its owner to add you, then connect again.</p>
<dl><dt>Your account id</dt><dd><code>${escapeHtml(input.userId)}</code></dd></dl>`,
  );
}

export function chooserPage(input: { clientName: string; providers: Array<{ name: string; href: string }> }): string {
  const buttons = input.providers.map((p) => `<a class="button" href="${escapeHtml(p.href)}">Continue with ${escapeHtml(p.name)}</a>`).join("");
  return page(
    "Sign in",
    `<h1>Sign in</h1><p><strong>${escapeHtml(input.clientName)}</strong> wants to connect to cairnmcp. Sign in to continue.</p><div class="actions">${buttons}</div>`,
  );
}

export function consentPage(input: {
  requestId: string;
  clientName: string;
  redirectTarget: string;
  userLabel: string;
  tenantName: string;
  toolsetName: string;
  canWrite: boolean;
}): string {
  const access = input.canWrite ? "Read and change data through its tools" : "Read data through its tools";
  return page(
    "Allow access",
    `<h1>Allow ${escapeHtml(input.clientName)}?</h1>
<p>It will act as you with the access you have on this toolset.</p>
<dl><dt>Signed in as</dt><dd>${escapeHtml(input.userLabel)}</dd>
<dt>Toolset</dt><dd>${escapeHtml(input.toolsetName)} (${escapeHtml(input.tenantName)})</dd>
<dt>Access</dt><dd>${escapeHtml(access)}</dd>
<dt>Returns to</dt><dd>${escapeHtml(input.redirectTarget)}</dd></dl>
<p>Only allow apps you started connecting yourself.</p>
<form method="post" action="/oauth/consent" class="actions">
<input type="hidden" name="request" value="${escapeHtml(input.requestId)}">
<button class="primary" type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`,
  );
}
