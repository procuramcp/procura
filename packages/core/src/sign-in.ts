// A tenant's own sign-in (D-040): customers sign in with the account they
// already have at the provider, and their plan follows the claims it sends.
import { z } from "zod";
import { ProfileId } from "./ir/ids.ts";

const httpsUrl = z.url({ protocol: /^https$/ }).max(2000);
const name = z.string().trim().min(1).max(100);
const clientId = z.string().trim().min(1).max(500);
/** A claim or userinfo field name, used as-is (Auth0 namespaces custom claims as URLs). */
const fieldName = z.string().trim().min(1).max(200).regex(/^\S+$/, "no spaces");

const common = {
  /** On the sign-in button and pages, e.g. the provider's product name. */
  name,
  clientId,
  /** Given to everyone who signs in, before any claim rule (a free tier). */
  defaultProfileId: ProfileId.optional(),
};

/**
 * How a tenant's customers sign in. `oidc` is any OpenID Connect provider,
 * found by discovery from its issuer. `oauth2` is plain OAuth 2 without
 * OpenID Connect: who signed in, and their claims, come from a userinfo
 * (profile) URL the provider names. The client secret is stored sealed,
 * apart from this.
 */
export const SignInConfig = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("oidc"),
    ...common,
    issuer: httpsUrl,
    /** `offline_access` asks for the refresh token that keeps plans current (D-040). */
    scopes: z.string().trim().max(1000).default("openid email profile offline_access"),
  }),
  z.object({
    kind: z.literal("oauth2"),
    ...common,
    authorizationUrl: httpsUrl,
    tokenUrl: httpsUrl,
    userinfoUrl: httpsUrl,
    scopes: z.string().trim().max(1000).default(""),
    /** The userinfo field that identifies the person; it must never change for them. */
    subjectField: fieldName.default("id"),
    /** The userinfo field shown as their name in the console. */
    labelField: fieldName.default("email"),
  }),
]);
export type SignInConfig = z.infer<typeof SignInConfig>;

/** One rule of a profile: whoever's sign-in claim `claim` equals `value` holds it. */
export const ClaimRule = z.object({ claim: fieldName, value: z.string().trim().min(1).max(200) });
export type ClaimRule = z.infer<typeof ClaimRule>;

/**
 * The profiles a person's sign-in claims give them (D-040): the tenant's
 * default profile, plus every profile with a rule their claims match. A claim
 * matches when it equals the value, or is a list containing it; numbers and
 * booleans compare as text (`"true"`, `"3"`).
 */
export function profilesForClaims(profiles: ReadonlyArray<{ id: string; claims: readonly ClaimRule[] }>, claims: Readonly<Record<string, unknown>>, defaultProfileId?: string): string[] {
  const matches = (value: unknown, wanted: string): boolean =>
    Array.isArray(value) ? value.some((v) => matches(v, wanted)) : ["string", "number", "boolean"].includes(typeof value) && String(value) === wanted;
  const ids = profiles.filter((p) => p.claims.some((r) => matches(claims[r.claim], r.value))).map((p) => p.id);
  if (defaultProfileId && profiles.some((p) => p.id === defaultProfileId)) ids.unshift(defaultProfileId);
  return [...new Set(ids)];
}

/** Where the vault seals a tenant's sign-in client secret (`Vault.sealSecret` context). */
export const SIGN_IN_SECRET_CONTEXT = "tenant_sign_in:client_secret";
/** Where the vault seals the provider's refresh token for one token family. */
export const upstreamGrantContext = (familyId: string): string => `upstream_grants:${familyId}`;
