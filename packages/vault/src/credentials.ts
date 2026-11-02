import { Instant } from "@cairnmcp/core";
import { z } from "zod";
import { Secret } from "./secret.ts";

/**
 * Credential material, one shape per kind of auth scheme in the IR. This is
 * the plaintext the vault encrypts; it never leaves the vault except as a
 * `Credential` whose secret fields are `Secret`s.
 */
export const CredentialInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("basic"),
    /** Omit when the scheme has a fixed username (Intervals.icu uses `API_KEY`). */
    username: z.string().min(1).optional(),
    password: z.string().min(1),
  }),
  z.object({ kind: z.literal("bearer"), token: z.string().min(1) }),
  z.object({ kind: z.literal("api_key"), value: z.string().min(1) }),
  z.object({
    kind: z.literal("oauth2"),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
    expiresAt: Instant.optional(),
  }),
]);
export type CredentialInput = z.infer<typeof CredentialInput>;

/** A decrypted credential with every secret wrapped. */
export type Credential =
  | { kind: "basic"; username?: string; password: Secret }
  | { kind: "bearer"; token: Secret }
  | { kind: "api_key"; value: Secret }
  | { kind: "oauth2"; accessToken: Secret; refreshToken?: Secret; expiresAt?: Instant };

export function wrapSecrets(input: CredentialInput): Credential {
  switch (input.kind) {
    case "basic":
      return { kind: "basic", ...(input.username !== undefined ? { username: input.username } : {}), password: new Secret(input.password) };
    case "bearer":
      return { kind: "bearer", token: new Secret(input.token) };
    case "api_key":
      return { kind: "api_key", value: new Secret(input.value) };
    case "oauth2":
      return {
        kind: "oauth2",
        accessToken: new Secret(input.accessToken),
        ...(input.refreshToken !== undefined ? { refreshToken: new Secret(input.refreshToken) } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      };
  }
}

/**
 * Which credential kinds fit an auth scheme type (`AuthScheme["type"]` in the
 * IR). OAuth and OIDC schemes take a stored token or a plain bearer token.
 */
export function credentialKindsFor(schemeType: string): Array<CredentialInput["kind"]> {
  switch (schemeType) {
    case "http_basic":
      return ["basic"];
    case "http_bearer":
      return ["bearer"];
    case "api_key":
      return ["api_key"];
    case "oauth2":
    case "oidc":
      return ["oauth2", "bearer"];
    default:
      return [];
  }
}
