import { z } from "zod";
import { Instant } from "../time.ts";
import { AuthSchemeId, SourceId } from "./ids.ts";

/** An absolute `https:` URL with no credentials or fragment. */
export const HttpsUrl = z.string().superRefine((value, ctx) => {
  if (!URL.canParse(value)) {
    ctx.addIssue({ code: "custom", message: "must be an absolute URL" });
    return;
  }
  const url = new URL(value);
  if (url.protocol !== "https:") ctx.addIssue({ code: "custom", message: "must use https" });
  if (url.username || url.password) ctx.addIssue({ code: "custom", message: "must not contain credentials" });
  if (url.hash || value.includes("#")) ctx.addIssue({ code: "custom", message: "must not contain a fragment" });
});

/**
 * Base URL of a source: an `HttpsUrl` with no query and no trailing slash,
 * so `baseUrl + pathTemplate` is unambiguous.
 *
 * This is a shape check only. Egress policy (private ranges, DNS rebinding,
 * redirects, host allowlists) is enforced by the runtime at request time.
 */
export const BaseUrl = HttpsUrl.superRefine((value, ctx) => {
  if (value.includes("?")) ctx.addIssue({ code: "custom", message: "must not contain a query" });
  if (value.endsWith("/")) ctx.addIssue({ code: "custom", message: "must not end with a slash" });
});

const schemeBase = {
  id: AuthSchemeId,
  description: z.string().max(4000).optional(),
};

const OAuthScopes = z.record(z.string(), z.string());

/**
 * How a source can be authenticated. Describes the shape only: credential
 * values never appear in the IR; the runtime fetches them from the vault.
 *
 * OAuth implicit and password flows are deliberately absent (removed in
 * OAuth 2.1); ingestors drop them with a warning.
 */
export const AuthScheme = z.discriminatedUnion("type", [
  z.object({
    ...schemeBase,
    type: z.literal("http_basic"),
    /**
     * Fixed username when the API uses one (Intervals.icu uses `API_KEY`).
     * Specs usually put this in prose, so it is set by curation, not ingest.
     */
    fixedUsername: z.string().optional(),
  }),
  z.object({
    ...schemeBase,
    type: z.literal("http_bearer"),
    bearerFormat: z.string().optional(),
  }),
  z.object({
    ...schemeBase,
    type: z.literal("api_key"),
    in: z.enum(["header", "query", "cookie"]),
    name: z.string().min(1),
  }),
  z.object({
    ...schemeBase,
    type: z.literal("oauth2"),
    flows: z
      .object({
        authorizationCode: z
          .object({
            authorizationUrl: HttpsUrl,
            tokenUrl: HttpsUrl,
            refreshUrl: HttpsUrl.optional(),
            scopes: OAuthScopes,
          })
          .optional(),
        clientCredentials: z
          .object({
            tokenUrl: HttpsUrl,
            refreshUrl: HttpsUrl.optional(),
            scopes: OAuthScopes,
          })
          .optional(),
      })
      .refine((f) => f.authorizationCode !== undefined || f.clientCredentials !== undefined, {
        message: "at least one supported OAuth flow is required",
      }),
  }),
  z.object({
    ...schemeBase,
    type: z.literal("oidc"),
    openIdConnectUrl: HttpsUrl,
  }),
]);
export type AuthScheme = z.infer<typeof AuthScheme>;

/** Use of one scheme, with the OAuth scopes needed (empty for non-OAuth). */
export const AuthUse = z.object({
  schemeId: AuthSchemeId,
  scopes: z.array(z.string()),
});
export type AuthUse = z.infer<typeof AuthUse>;

/**
 * Alternatives of conjunctions, as in OpenAPI `security`: the request is
 * authorized if ALL uses in ANY ONE inner array are satisfied.
 * `[]` means no auth; `[[]]` means anonymous access is one of the options.
 */
export const AuthRequirement = z.array(z.array(AuthUse));
export type AuthRequirement = z.infer<typeof AuthRequirement>;

/**
 * A rate limit the upstream applies. OpenAPI has no standard field for this,
 * so these usually come from docs or observation, and `basis` says which.
 */
export const RateLimitHint = z.object({
  scope: z.enum(["ip", "credential", "application", "global"]),
  maxRequests: z.number().int().positive(),
  windowSeconds: z.number().int().positive(),
  basis: z.enum(["documented", "observed", "assumed"]),
  note: z.string().max(1000).optional(),
});
export type RateLimitHint = z.infer<typeof RateLimitHint>;

/** How this IR was produced, so it can be reproduced or re-ingested and diffed. */
export const Derivation = z.object({
  ingestor: z.enum(["openapi", "graphql", "postman", "har", "curl", "docs"]),
  ingestorVersion: z.string().min(1),
  /** Where the source document came from, if fetched. */
  documentUrl: z.url().optional(),
  /** SHA-256 of the raw source document bytes, lowercase hex. */
  documentSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** Version of the description format, e.g. OpenAPI `3.0.1`. */
  formatVersion: z.string().optional(),
  /** Version the API declares for itself, e.g. `info.version`. */
  apiVersion: z.string().optional(),
  /** Passed in by the caller; core never reads the clock. */
  derivedAt: Instant.optional(),
});
export type Derivation = z.infer<typeof Derivation>;

export const Source = z.object({
  id: SourceId,
  name: z.string().min(1).max(200),
  description: z.string().max(10_000).optional(),
  baseUrl: BaseUrl,
  authSchemes: z.array(AuthScheme),
  /** Applies to every operation that does not declare its own `auth`. */
  defaultAuth: AuthRequirement,
  rateLimits: z.array(RateLimitHint),
  derivation: Derivation,
});
export type Source = z.infer<typeof Source>;
