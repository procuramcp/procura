// Test doubles for the sign-in flow. Not exported from the package index.
import { createHash, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

type Pending = { nonce: string | null; challenge: string; redirectUri: string; sub: string; email: string };

/**
 * An in-memory OpenID Connect provider. `openid-client` reaches it through
 * its fetch hook, so the real discovery, token exchange, and ID token checks
 * run with no network. With `plainOAuth2` it's an OAuth 2 provider without
 * OpenID Connect: no discovery or ID tokens, and who signed in comes from
 * `/api/me` (fields `id` and `email`). Refresh tokens rotate and can be revoked.
 */
export class FakeOidcProvider {
  readonly issuer: string;
  readonly plainOAuth2: boolean;
  readonly clientId = "cairnmcp-test";
  readonly clientSecret = "idp-test-secret-not-real";
  /** Extra claims per subject, sent in ID tokens and userinfo; change them to simulate a plan change. */
  readonly claims = new Map<string, Record<string, unknown>>();
  readonly #codes = new Map<string, Pending>();
  readonly #accessTokens = new Map<string, { sub: string; email: string }>();
  readonly #refreshTokens = new Map<string, { sub: string; email: string }>();
  #privateKey!: CryptoKey;
  #jwk!: JWK;
  /** Set to make the next ID token claim a different nonce (replay test). */
  wrongNonce = false;

  constructor(options: { issuer?: string; plainOAuth2?: boolean } = {}) {
    this.issuer = options.issuer ?? "https://idp.test";
    this.plainOAuth2 = options.plainOAuth2 ?? false;
  }

  static async create(options: { issuer?: string; plainOAuth2?: boolean } = {}): Promise<FakeOidcProvider> {
    const op = new FakeOidcProvider(options);
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    op.#privateKey = privateKey;
    op.#jwk = { ...(await exportJWK(publicKey)), kid: "idp-1", alg: "RS256", use: "sig" };
    return op;
  }

  // Shaped like openid-client's CustomFetch (its options are a RequestInit subset).
  readonly fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: unknown; redirect?: string; signal?: AbortSignal }): Promise<Response> =>
    this.#handle(new Request(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body as string } : {}) }));

  /** The user signs in at the provider; returns where the provider sends the browser back to. */
  approve(authorizationUrl: string | URL, user: { sub: string; email: string }): URL {
    const url = new URL(authorizationUrl);
    if (url.origin !== this.issuer) throw new Error(`not this provider: ${url.origin}`);
    const q = url.searchParams;
    if (q.get("code_challenge_method") !== "S256" || (!this.plainOAuth2 && !q.get("nonce")) || !q.get("state")) throw new Error("provider expects PKCE, nonce, and state");
    const code = randomBytes(16).toString("base64url");
    this.#codes.set(code, { nonce: q.get("nonce"), challenge: q.get("code_challenge")!, redirectUri: q.get("redirect_uri")!, ...user });
    const back = new URL(q.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.get("state")!);
    return back;
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/.well-known/openid-configuration" && !this.plainOAuth2) {
      return json({
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        userinfo_endpoint: `${this.issuer}/userinfo`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      });
    }
    if (url.pathname === "/jwks") return json({ keys: [this.#jwk] });
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const basic = request.headers.get("authorization");
      const [id, secret] = basic?.startsWith("Basic ")
        ? Buffer.from(basic.slice(6), "base64").toString().split(":").map(decodeURIComponent)
        : [form.get("client_id"), form.get("client_secret")];
      if (id !== this.clientId || secret !== this.clientSecret) return json({ error: "invalid_client" }, 401);
      if (form.get("grant_type") === "refresh_token") {
        const who = this.#refreshTokens.get(form.get("refresh_token") ?? "");
        if (!who) return json({ error: "invalid_grant" }, 400);
        this.#refreshTokens.delete(form.get("refresh_token")!);
        return json(this.#issue(who));
      }
      const pending = this.#codes.get(form.get("code") ?? "");
      this.#codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (!pending || pending.redirectUri !== form.get("redirect_uri") || createHash("sha256").update(verifier).digest("base64url") !== pending.challenge) {
        return json({ error: "invalid_grant" }, 400);
      }
      const who = { sub: pending.sub, email: pending.email };
      if (this.plainOAuth2) return json(this.#issue(who));
      const idToken = await new SignJWT({ nonce: this.wrongNonce ? "replayed" : pending.nonce, email: pending.email, ...this.claims.get(pending.sub) })
        .setProtectedHeader({ alg: "RS256", kid: "idp-1" })
        .setIssuer(this.issuer)
        .setSubject(pending.sub)
        .setAudience(this.clientId)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(this.#privateKey);
      return json({ ...this.#issue(who), id_token: idToken });
    }
    const bearer = this.#accessTokens.get(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    if (url.pathname === "/userinfo" && !this.plainOAuth2) {
      return bearer ? json({ sub: bearer.sub, email: bearer.email, ...this.claims.get(bearer.sub) }) : json({ error: "invalid_token" }, 401);
    }
    if (url.pathname === "/api/me" && this.plainOAuth2) {
      return bearer ? json({ id: Number(bearer.sub.replace(/\D/g, "")) || bearer.sub, email: bearer.email, ...this.claims.get(bearer.sub) }) : json({ error: "invalid_token" }, 401);
    }
    return json({ error: "not_found" }, 404);
  }

  /** End every refresh token issued to `sub`: their next refresh is refused. */
  revoke(sub: string): void {
    for (const [token, who] of this.#refreshTokens) if (who.sub === sub) this.#refreshTokens.delete(token);
  }

  #issue(who: { sub: string; email: string }): { access_token: string; token_type: string; expires_in: number; refresh_token: string } {
    const access = `idp-at-${randomBytes(8).toString("hex")}`;
    const refresh = `idp-rt-${randomBytes(8).toString("hex")}`;
    this.#accessTokens.set(access, who);
    this.#refreshTokens.set(refresh, who);
    return { access_token: access, token_type: "Bearer", expires_in: 300, refresh_token: refresh };
  }
}

/** Just enough of a browser: keeps cookies, never follows redirects on its own. */
export class TestBrowser {
  readonly #cookies = new Map<string, string>();
  readonly #handler: (request: Request) => Promise<Response>;

  constructor(handler: (request: Request) => Promise<Response>) {
    this.#handler = handler;
  }

  get(url: string | URL): Promise<Response> {
    return this.#send(new Request(url));
  }

  postForm(url: string | URL, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
    return this.#send(new Request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(form).toString() }));
  }

  /** A JSON request as the console's own code sends it (same-origin Origin header). */
  json(method: string, url: string | URL, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const origin = new URL(url).origin;
    return this.#send(
      new Request(url, {
        method,
        headers: { ...(method === "GET" ? {} : { origin, "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }

  forgetCookies(): void {
    this.#cookies.clear();
  }

  async #send(request: Request): Promise<Response> {
    if (this.#cookies.size > 0) request.headers.set("cookie", [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const response = await this.#handler(request);
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair, ...attrs] = setCookie.split(";").map((s) => s.trim());
      const [name, value] = pair!.split("=");
      if (attrs.some((a) => a.toLowerCase() === "max-age=0") || !value) this.#cookies.delete(name!);
      else this.#cookies.set(name!, value);
    }
    return response;
  }
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
