// Test doubles for the sign-in flow. Not exported from the package index.
import { createHash, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

type Pending = { nonce: string; challenge: string; redirectUri: string; sub: string; email: string };

/**
 * An in-memory OpenID Connect provider. `openid-client` reaches it through
 * its fetch hook, so the real discovery, token exchange, and ID token checks
 * run with no network.
 */
export class FakeOidcProvider {
  readonly issuer = "https://idp.test";
  readonly clientId = "cairnmcp-test";
  readonly clientSecret = "idp-test-secret-not-real";
  readonly #codes = new Map<string, Pending>();
  #privateKey!: CryptoKey;
  #jwk!: JWK;
  /** Set to make the next ID token claim a different nonce (replay test). */
  wrongNonce = false;

  static async create(): Promise<FakeOidcProvider> {
    const op = new FakeOidcProvider();
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
    if (q.get("code_challenge_method") !== "S256" || !q.get("nonce") || !q.get("state")) throw new Error("provider expects PKCE, nonce, and state");
    const code = randomBytes(16).toString("base64url");
    this.#codes.set(code, { nonce: q.get("nonce")!, challenge: q.get("code_challenge")!, redirectUri: q.get("redirect_uri")!, ...user });
    const back = new URL(q.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.get("state")!);
    return back;
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
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
      const pending = this.#codes.get(form.get("code") ?? "");
      this.#codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (!pending || pending.redirectUri !== form.get("redirect_uri") || createHash("sha256").update(verifier).digest("base64url") !== pending.challenge) {
        return json({ error: "invalid_grant" }, 400);
      }
      const idToken = await new SignJWT({ nonce: this.wrongNonce ? "replayed" : pending.nonce, email: pending.email })
        .setProtectedHeader({ alg: "RS256", kid: "idp-1" })
        .setIssuer(this.issuer)
        .setSubject(pending.sub)
        .setAudience(this.clientId)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(this.#privateKey);
      return json({ access_token: "idp-access-token", token_type: "Bearer", expires_in: 300, id_token: idToken });
    }
    return json({ error: "not_found" }, 404);
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

  forgetCookies(): void {
    this.#cookies.clear();
  }

  async #send(request: Request): Promise<Response> {
    if (this.#cookies.size > 0) request.headers.set("cookie", [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const response = await this.#handler(request);
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
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
