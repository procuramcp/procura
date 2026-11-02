import type { SignInConfig } from "@cairnmcp/core";
import { randomToken } from "@cairnmcp/http";
import * as oidc from "openid-client";

/** Who an upstream identity provider says signed in. */
export type UpstreamIdentity = {
  /** The provider's `iss`; with `subject`, the key of a cairnmcp user. */
  issuer: string;
  subject: string;
  /** For display on the consent page only (an email or name). Never used for identity. */
  label: string;
  /** Everything the provider said about them (ID token and userinfo), for plans from claims (D-040). */
  claims: Record<string, unknown>;
  /** The provider's refresh token, if it gave one: how claims are re-read later. */
  refreshToken?: string;
};

/** What a provider says now about someone who signed in earlier (D-040). */
export type RefreshedIdentity = { subject: string; claims: Record<string, unknown>; refreshToken?: string };

/**
 * Where people sign in. cairnmcp delegates authentication (D-026) and issues
 * its own tokens afterwards; it never sees a password.
 */
export interface IdentityProvider {
  readonly id: string;
  readonly name: string;
  authorizationUrl(input: { redirectUri: string; state: string; nonce: string; codeVerifier: string }): Promise<URL>;
  finish(input: { callbackUrl: URL; redirectUri: string; expectedState: string; expectedNonce: string; codeVerifier: string }): Promise<UpstreamIdentity>;
  /** Re-read someone's claims with the provider's refresh token. Throws if the provider refuses (they lost access). */
  refresh?(refreshToken: string): Promise<RefreshedIdentity>;
}

/** How providers' URLs are fetched (openid-client's fetch hook). */
export type ProviderFetch = oidc.CustomFetch;

/** The single-use secrets of one sign-in at a provider. Store them (state and browser hashed) until the callback. */
export type SignInSecrets = { state: string; nonce: string; verifier: string; browser: string };

/**
 * Start a sign-in at `provider`: fresh state, nonce, PKCE verifier, and a
 * browser secret (for a cookie that proves the callback lands in the same
 * browser), plus where to send the browser.
 */
export async function startSignIn(provider: IdentityProvider, redirectUri: string): Promise<{ location: URL; secrets: SignInSecrets }> {
  const secrets = { state: randomToken(32), nonce: randomToken(32), verifier: randomToken(32), browser: randomToken(32) };
  const location = await provider.authorizationUrl({ redirectUri, state: secrets.state, nonce: secrets.nonce, codeVerifier: secrets.verifier });
  return { location, secrets };
}

/** Finish a sign-in from the provider's callback, or undefined if the provider didn't confirm it. */
export async function finishSignIn(
  provider: IdentityProvider,
  input: { callbackUrl: URL; redirectUri: string; state: string; nonce: string; verifier: string },
): Promise<UpstreamIdentity | undefined> {
  try {
    return await provider.finish({ callbackUrl: input.callbackUrl, redirectUri: input.redirectUri, expectedState: input.state, expectedNonce: input.nonce, codeVerifier: input.verifier });
  } catch {
    return undefined;
  }
}

export type OidcProviderConfig = {
  /** Slug used in URLs, e.g. `google`. */
  id: string;
  /** Button label, e.g. `Google`. */
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Space-separated. Defaults to `openid email profile`. */
  scopes?: string;
};

/**
 * Any OpenID Connect provider (Google, Okta, Entra, Auth0, Keycloak, ...),
 * with the authorization code flow, PKCE, state, and nonce. ID tokens are
 * validated by `openid-client`.
 */
export class OidcIdentityProvider implements IdentityProvider {
  readonly id: string;
  readonly name: string;
  readonly #config: OidcProviderConfig;
  readonly #fetch: oidc.CustomFetch | undefined;
  #discovered: Promise<oidc.Configuration> | undefined;

  /** `fetch` replaces network access (tests use an in-memory provider). */
  constructor(config: OidcProviderConfig, options: { fetch?: oidc.CustomFetch } = {}) {
    this.id = config.id;
    this.name = config.name;
    this.#config = config;
    this.#fetch = options.fetch;
  }

  async authorizationUrl(input: { redirectUri: string; state: string; nonce: string; codeVerifier: string }): Promise<URL> {
    const config = await this.#configuration();
    return oidc.buildAuthorizationUrl(config, {
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: this.#config.scopes || "openid email profile",
      state: input.state,
      nonce: input.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(input.codeVerifier),
      code_challenge_method: "S256",
    });
  }

  async finish(input: { callbackUrl: URL; redirectUri: string; expectedState: string; expectedNonce: string; codeVerifier: string }): Promise<UpstreamIdentity> {
    const config = await this.#configuration();
    const tokens = await oidc.authorizationCodeGrant(
      config,
      input.callbackUrl,
      { pkceCodeVerifier: input.codeVerifier, expectedState: input.expectedState, expectedNonce: input.expectedNonce, idTokenExpected: true },
      { redirect_uri: input.redirectUri },
    );
    const claims = tokens.claims();
    if (!claims) throw new Error("identity provider returned no ID token");
    // Some providers put custom claims (a plan, roles) only in userinfo.
    const all = { ...(await this.#userInfo(config, tokens.access_token, claims.sub)), ...claims };
    const label = [claims["email"], claims["name"], claims.sub].find((v): v is string => typeof v === "string" && v.length > 0)!;
    return { issuer: claims.iss, subject: claims.sub, label, claims: all, ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}) };
  }

  async refresh(refreshToken: string): Promise<RefreshedIdentity> {
    const config = await this.#configuration();
    const tokens = await oidc.refreshTokenGrant(config, refreshToken);
    const idClaims = tokens.claims();
    const info = await this.#userInfo(config, tokens.access_token, idClaims?.sub);
    const subject = idClaims?.sub ?? (typeof info["sub"] === "string" ? info["sub"] : undefined);
    if (!subject) throw new Error("the provider said nothing about who this is");
    return { subject, claims: { ...info, ...(idClaims ?? {}) }, ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}) };
  }

  /** Userinfo claims if the provider has a userinfo endpoint, checked against `subject` when known. */
  async #userInfo(config: oidc.Configuration, accessToken: string, subject: string | undefined): Promise<Record<string, unknown>> {
    if (!config.serverMetadata().userinfo_endpoint) return {};
    return (await oidc.fetchUserInfo(config, accessToken, subject ?? oidc.skipSubjectCheck)) as Record<string, unknown>;
  }

  #configuration(): Promise<oidc.Configuration> {
    // Discovery runs once and is cached; a failure is retried on the next sign-in.
    this.#discovered ??= oidc
      .discovery(new URL(this.#config.issuer), this.#config.clientId, this.#config.clientSecret, undefined, this.#fetch ? { [oidc.customFetch]: this.#fetch } : {})
      .then((config) => {
        if (this.#fetch) config[oidc.customFetch] = this.#fetch;
        return config;
      })
      .catch((e: unknown) => {
        this.#discovered = undefined;
        throw e;
      });
    return this.#discovered;
  }
}

export type OAuth2ProviderConfig = {
  id: string;
  name: string;
  authorizationUrl: string;
  tokenUrl: string;
  /** Answers GET with a bearer token: a JSON object about who signed in. */
  userinfoUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  /** The userinfo field that identifies the person (never changes for them), and the one to show. */
  subjectField: string;
  labelField: string;
};

/**
 * Plain OAuth 2 sign-in, for providers without OpenID Connect (D-040): the
 * authorization code flow with PKCE and state, then who signed in and their
 * claims from the provider's userinfo URL. Users from it are keyed by the
 * provider id, that URL, and the ID field (`issuer`), so no other provider,
 * or tenant, ever shares a subject with it.
 */
export class OAuth2IdentityProvider implements IdentityProvider {
  readonly id: string;
  readonly name: string;
  readonly #config: OAuth2ProviderConfig;
  readonly #fetch: oidc.CustomFetch | undefined;
  readonly #client: oidc.Configuration;

  constructor(config: OAuth2ProviderConfig, options: { fetch?: oidc.CustomFetch } = {}) {
    this.id = config.id;
    this.name = config.name;
    this.#config = config;
    this.#fetch = options.fetch;
    this.#client = new oidc.Configuration(
      { issuer: new URL(config.authorizationUrl).origin, authorization_endpoint: config.authorizationUrl, token_endpoint: config.tokenUrl },
      config.clientId,
      config.clientSecret,
    );
    if (options.fetch) this.#client[oidc.customFetch] = options.fetch;
  }

  /**
   * The issuer users from this provider are stored under. Everything that
   * decides who someone is goes in it, including the provider id (for a
   * tenant's sign-in, `tenant:{id}`): a tenant admin picks the URL and the ID
   * field, so another tenant entering the same URL with a different field
   * must never land on someone else's user.
   */
  get issuer(): string {
    return `oauth2:${this.id}:${this.#config.userinfoUrl}#${this.#config.subjectField}`;
  }

  async authorizationUrl(input: { redirectUri: string; state: string; nonce: string; codeVerifier: string }): Promise<URL> {
    return oidc.buildAuthorizationUrl(this.#client, {
      redirect_uri: input.redirectUri,
      response_type: "code",
      ...(this.#config.scopes ? { scope: this.#config.scopes } : {}),
      state: input.state,
      code_challenge: await oidc.calculatePKCECodeChallenge(input.codeVerifier),
      code_challenge_method: "S256",
    });
  }

  async finish(input: { callbackUrl: URL; redirectUri: string; expectedState: string; expectedNonce: string; codeVerifier: string }): Promise<UpstreamIdentity> {
    const tokens = await oidc.authorizationCodeGrant(
      this.#client,
      input.callbackUrl,
      { pkceCodeVerifier: input.codeVerifier, expectedState: input.expectedState, idTokenExpected: false },
      { redirect_uri: input.redirectUri },
    );
    const { subject, claims } = await this.#whoIs(tokens.access_token);
    const label = typeof claims[this.#config.labelField] === "string" && claims[this.#config.labelField] ? (claims[this.#config.labelField] as string) : subject;
    return { issuer: this.issuer, subject, label, claims, ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}) };
  }

  async refresh(refreshToken: string): Promise<RefreshedIdentity> {
    const tokens = await oidc.refreshTokenGrant(this.#client, refreshToken);
    return { ...(await this.#whoIs(tokens.access_token)), ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}) };
  }

  async #whoIs(accessToken: string): Promise<{ subject: string; claims: Record<string, unknown> }> {
    const response = await (this.#fetch ?? fetch)(this.#config.userinfoUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      redirect: "manual",
    } as never);
    if (!response.ok) throw new Error(`the userinfo URL answered ${response.status}`);
    const claims: unknown = await response.json();
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw new Error("the userinfo URL didn't answer with a JSON object");
    const id = (claims as Record<string, unknown>)[this.#config.subjectField];
    if ((typeof id !== "string" && typeof id !== "number") || String(id).length === 0) {
      throw new Error(`the userinfo answer has no ${this.#config.subjectField} to identify the person by`);
    }
    return { subject: String(id), claims: claims as Record<string, unknown> };
  }
}

/** The identity provider for a tenant's own sign-in settings (D-040). `fetch` must refuse private addresses. */
export function tenantIdentityProvider(id: string, config: SignInConfig, clientSecret: string, fetch: oidc.CustomFetch): IdentityProvider {
  return config.kind === "oidc"
    ? new OidcIdentityProvider({ id, name: config.name, issuer: config.issuer, clientId: config.clientId, clientSecret, scopes: config.scopes }, { fetch })
    : new OAuth2IdentityProvider(
        {
          id,
          name: config.name,
          authorizationUrl: config.authorizationUrl,
          tokenUrl: config.tokenUrl,
          userinfoUrl: config.userinfoUrl,
          clientId: config.clientId,
          clientSecret,
          scopes: config.scopes,
          subjectField: config.subjectField,
          labelField: config.labelField,
        },
        { fetch },
      );
}
