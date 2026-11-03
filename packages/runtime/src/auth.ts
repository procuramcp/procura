import type { AuthRequirement, AuthScheme, Instant } from "@procura/core";
import { Secret, type Credential } from "@procura/vault";
import { fail } from "./errors.ts";

/** Credentials applied to a request. Values stay wrapped until the request is sent. */
export type AppliedAuth = {
  headers: Record<string, Secret>;
  query: Array<[string, Secret]>;
  cookies: Array<[string, Secret]>;
  /** Raw secret values used, so error bodies echoing them can be scrubbed. */
  secrets: Secret[];
};

/**
 * Pick the first auth alternative the tenant can satisfy and apply it.
 * `[]` and `[[]]` mean no auth. Expired OAuth tokens don't count (refresh is
 * a later milestone).
 */
export function applyAuth(
  requirement: AuthRequirement,
  schemes: AuthScheme[],
  credentials: Map<string, Credential>,
  now: Instant,
): AppliedAuth {
  const empty: AppliedAuth = { headers: {}, query: [], cookies: [], secrets: [] };
  if (requirement.length === 0) return empty;

  const byId = new Map(schemes.map((s) => [s.id as string, s]));
  for (const alternative of requirement) {
    const applied: AppliedAuth = { headers: {}, query: [], cookies: [], secrets: [] };
    const ok = alternative.every((use) => {
      const scheme = byId.get(use.schemeId);
      const credential = credentials.get(use.schemeId);
      return scheme !== undefined && credential !== undefined && applyOne(scheme, credential, now, applied);
    });
    if (ok) return applied;
  }

  const options = requirement.map((alt) => (alt.length === 0 ? "none" : alt.map((u) => u.schemeId).join(" + "))).join(" or ");
  return fail("missing_credentials", `no stored credentials match this API's auth (${options}); add one in the source settings`, {
    retryable: false,
  });
}

function applyOne(scheme: AuthScheme, credential: Credential, now: Instant, out: AppliedAuth): boolean {
  const bearer = (token: Secret) => {
    out.headers["authorization"] = new Secret(`Bearer ${token.reveal()}`);
    out.secrets.push(token);
  };
  switch (scheme.type) {
    case "http_basic": {
      if (credential.kind !== "basic") return false;
      const username = credential.username ?? scheme.fixedUsername;
      if (username === undefined) return false;
      out.headers["authorization"] = new Secret(`Basic ${Buffer.from(`${username}:${credential.password.reveal()}`).toString("base64")}`);
      out.secrets.push(credential.password);
      return true;
    }
    case "http_bearer":
    case "oauth2":
    case "oidc":
      if (credential.kind === "bearer") {
        bearer(credential.token);
        return true;
      }
      // Compare as times, not strings: "…57Z" and "…57.123Z" do not sort lexically.
      if (credential.kind === "oauth2" && (credential.expiresAt === undefined || Date.parse(credential.expiresAt) > Date.parse(now))) {
        bearer(credential.accessToken);
        return true;
      }
      return false;
    case "api_key": {
      if (credential.kind !== "api_key") return false;
      if (scheme.in === "header") out.headers[scheme.name.toLowerCase()] = credential.value;
      else if (scheme.in === "query") out.query.push([scheme.name, credential.value]);
      else out.cookies.push([scheme.name, credential.value]);
      out.secrets.push(credential.value);
      return true;
    }
  }
}
