import { randomToken } from "@procura/http";
import * as oidc from "openid-client";

/** Who an upstream identity provider says signed in. */
export type UpstreamIdentity = {
  /** The provider's `iss`; with `subject`, the key of a procura user. */
  issuer: string;
  subject: string;
  /** For display on the consent page only (an email or name). Never used for identity. */
  label: string;
};

/**
 * Where people sign in. procura delegates authentication (D-026) and issues
 * its own tokens afterwards; it never sees a password.
 */
export interface IdentityProvider {
  readonly id: string;
  readonly name: string;
  /** `prompt: "login"` asks the provider to show its sign-in page even if it remembers the person. */
  authorizationUrl(input: { redirectUri: string; state: string; nonce: string; codeVerifier: string; prompt?: "login" }): Promise<URL>;
  finish(input: { callbackUrl: URL; redirectUri: string; expectedState: string; expectedNonce: string; codeVerifier: string }): Promise<UpstreamIdentity>;
}

/** The single-use secrets of one sign-in at a provider. Store them (state and browser hashed) until the callback. */
export type SignInSecrets = { state: string; nonce: string; verifier: string; browser: string };

/**
 * Start a sign-in at `provider`: fresh state, nonce, PKCE verifier, and a
 * browser secret (for a cookie that proves the callback lands in the same
 * browser), plus where to send the browser.
 */
export async function startSignIn(provider: IdentityProvider, redirectUri: string, options: { prompt?: "login" } = {}): Promise<{ location: URL; secrets: SignInSecrets }> {
  const secrets = { state: randomToken(32), nonce: randomToken(32), verifier: randomToken(32), browser: randomToken(32) };
  const location = await provider.authorizationUrl({ redirectUri, state: secrets.state, nonce: secrets.nonce, codeVerifier: secrets.verifier, ...options });
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

  async authorizationUrl(input: { redirectUri: string; state: string; nonce: string; codeVerifier: string; prompt?: "login" }): Promise<URL> {
    const config = await this.#configuration();
    return oidc.buildAuthorizationUrl(config, {
      ...(input.prompt ? { prompt: input.prompt } : {}),
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: "openid email profile",
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
    const label = [claims["email"], claims["name"], claims.sub].find((v): v is string => typeof v === "string" && v.length > 0)!;
    return { issuer: claims.iss, subject: claims.sub, label };
  }

  #configuration(): Promise<oidc.Configuration> {
    // Discovery runs once and is cached; a failure is retried on the next sign-in.
    // Plain http reaches here only for a localhost issuer (the server's config refuses
    // others), such as the self-host compose setup's local Dex; openid-client needs leave for it.
    const issuer = new URL(this.#config.issuer);
    const options: oidc.DiscoveryRequestOptions = {
      ...(this.#fetch ? { [oidc.customFetch]: this.#fetch } : {}),
      ...(issuer.protocol === "http:" ? { execute: [oidc.allowInsecureRequests] } : {}),
    };
    this.#discovered ??= oidc
      .discovery(issuer, this.#config.clientId, this.#config.clientSecret, undefined, options)
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
