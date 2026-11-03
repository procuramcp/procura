import { AuthScheme, omitUndefined, type AuthRequirement, type AuthUse, type Diagnostic } from "@procura/core";
import { OaSecurityScheme } from "./document.ts";
import { escapePointerToken } from "./refs.ts";

type SchemeMap = Map<string, AuthScheme>;

/**
 * Map `components.securitySchemes`. Unsupported schemes (digest, mutual TLS,
 * OAuth implicit/password flows) are dropped with a warning; requirements that
 * need them are dropped later.
 */
export function mapSecuritySchemes(
  raw: Record<string, unknown> | undefined,
  baseUrl: string,
  diagnostics: Diagnostic[],
): SchemeMap {
  const schemes: SchemeMap = new Map();
  for (const [id, value] of Object.entries(raw ?? {})) {
    const pointer = `#/components/securitySchemes/${escapePointerToken(id)}`;
    const warn = (code: string, message: string) => diagnostics.push({ severity: "warning", code, message, pointer });
    const parsed = OaSecurityScheme.safeParse(value);
    if (!parsed.success) {
      warn("unsupported_security_scheme", `security scheme "${id}" is not a supported type; dropped`);
      continue;
    }
    const s = parsed.data;
    const description = s.description !== undefined ? { description: s.description } : {};
    let candidate: unknown;
    switch (s.type) {
      case "http": {
        const scheme = s.scheme.toLowerCase();
        if (scheme === "basic") candidate = { id, type: "http_basic", ...description };
        else if (scheme === "bearer") {
          candidate = { id, type: "http_bearer", ...description, ...(s.bearerFormat ? { bearerFormat: s.bearerFormat } : {}) };
        } else {
          warn("unsupported_security_scheme", `HTTP auth scheme "${s.scheme}" (${id}) is not supported; dropped`);
          continue;
        }
        break;
      }
      case "apiKey":
        candidate = { id, type: "api_key", in: s.in, name: s.name, ...description };
        break;
      case "oauth2": {
        for (const flow of ["implicit", "password"] as const) {
          if (s.flows[flow]) warn("unsupported_oauth_flow", `OAuth ${flow} flow (${id}) is removed in OAuth 2.1; dropped`);
        }
        const abs = (u: string | undefined) => (u === undefined ? undefined : absolute(u, baseUrl));
        const flows: Record<string, unknown> = {};
        const ac = s.flows.authorizationCode;
        if (ac) {
          flows["authorizationCode"] = omitUndefined({
            authorizationUrl: abs(ac.authorizationUrl),
            tokenUrl: abs(ac.tokenUrl),
            refreshUrl: abs(ac.refreshUrl),
            scopes: ac.scopes,
          });
        }
        const cc = s.flows.clientCredentials;
        if (cc) flows["clientCredentials"] = omitUndefined({ tokenUrl: abs(cc.tokenUrl), refreshUrl: abs(cc.refreshUrl), scopes: cc.scopes });
        candidate = { id, type: "oauth2", flows, ...description };
        break;
      }
      case "openIdConnect":
        candidate = { id, type: "oidc", openIdConnectUrl: absolute(s.openIdConnectUrl, baseUrl), ...description };
        break;
      case "mutualTLS":
        warn("unsupported_security_scheme", `mutual TLS (${id}) is not supported; dropped`);
        continue;
    }
    const result = AuthScheme.safeParse(candidate);
    if (result.success) schemes.set(id, result.data);
    else warn("invalid_security_scheme", `security scheme "${id}" is invalid (${result.error.issues[0]?.message}); dropped`);
  }
  return schemes;
}

// Schemes that put a credential in the Authorization header. A request has
// only one such header, so a conjunction of two of these can never be met.
const AUTHORIZATION_HEADER_TYPES = new Set<AuthScheme["type"]>(["http_basic", "http_bearer", "oauth2", "oidc"]);

/**
 * Map an OpenAPI `security` array (alternatives of conjunctions).
 *
 * If one alternative requires two schemes that both use the Authorization
 * header, it cannot be satisfied as written. Specs that do this almost always
 * mean "either one" (Intervals.icu lists API key and OAuth bearer this way),
 * so it is split into alternatives and reported as a warning.
 */
export function mapSecurityRequirement(
  requirements: Record<string, string[]>[],
  schemes: SchemeMap,
  pointer: string,
  diagnostics: Diagnostic[],
  operationId?: string,
): AuthRequirement {
  const where = operationId !== undefined ? { pointer, operationId } : { pointer };
  const out: AuthUse[][] = [];
  for (const alternative of requirements) {
    const ids = Object.keys(alternative);
    const missing = ids.filter((id) => !schemes.has(id));
    if (missing.length > 0) {
      diagnostics.push({
        severity: "warning",
        code: "security_requirement_dropped",
        message: `security alternative needs unknown or unsupported scheme(s) ${missing.join(", ")}; dropped`,
        ...where,
      });
      continue;
    }
    const uses = ids.map((id) => ({ schemeId: id, scopes: alternative[id] ?? [] }) as AuthUse);
    const headerUses = uses.filter((u) => AUTHORIZATION_HEADER_TYPES.has(schemes.get(u.schemeId)!.type));
    if (headerUses.length > 1) {
      diagnostics.push({
        severity: "warning",
        code: "auth_conjunction_unsatisfiable",
        message: `security requires ${headerUses.map((u) => u.schemeId).join(" AND ")}, which all use the Authorization header; treated as alternatives`,
        ...where,
      });
      const others = uses.filter((u) => !headerUses.includes(u));
      for (const h of headerUses) out.push([h, ...others]);
    } else {
      out.push(uses);
    }
  }
  return dedupe(out);
}

function dedupe(req: AuthUse[][]): AuthRequirement {
  const seen = new Set<string>();
  return req.filter((alt) => {
    const key = JSON.stringify(alt.map((u) => [u.schemeId, [...u.scopes].sort()]).sort());
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function absolute(url: string, base: string): string {
  return URL.canParse(url) ? url : new URL(url, `${base}/`).toString();
}
