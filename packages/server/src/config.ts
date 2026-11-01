import { z } from "zod";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const PublicUrl = z
  .url()
  .refine((u) => {
    const url = new URL(u);
    return url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
  }, "must be https (http is allowed only for localhost)")
  .refine((u) => {
    const url = new URL(u);
    return url.pathname === "/" && !url.search && !url.hash;
  }, "must be just the origin, with no path, query, or fragment")
  .transform((u) => u.replace(/\/+$/, ""));

const httpsUrl = z.url().refine((u) => u.startsWith("https://") || LOCAL_HOSTS.has(new URL(u).hostname), "must be https");

/** A JSON environment value checked against `shape`. */
const jsonEnv = <T extends z.ZodType>(shape: T) =>
  z
    .string()
    .transform((text, ctx) => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "must be JSON" });
        return z.NEVER;
      }
    })
    .pipe(shape);

const OidcProviders = jsonEnv(
  z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]{1,32}$/, "id must be a short lowercase slug"),
        name: z.string().min(1).max(60),
        issuer: httpsUrl,
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
      }),
    )
    .min(1, "configure at least one sign-in provider")
    .refine((ps) => new Set(ps.map((p) => p.id)).size === ps.length, "provider ids must be unique"),
);

const TrustedIssuers = jsonEnv(z.array(z.object({ issuer: z.url(), jwksUri: httpsUrl })));

const Env = z.object({
  CAIRNMCP_PUBLIC_URL: PublicUrl,
  CAIRNMCP_DATABASE_URL: z.string().startsWith("postgres", "must be a postgres:// URL"),
  CAIRNMCP_MASTER_KEY: z.string().min(1),
  CAIRNMCP_OIDC_PROVIDERS: OidcProviders,
  CAIRNMCP_TRUSTED_ISSUERS: TrustedIssuers.optional(),
  CAIRNMCP_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((s) => (s ?? "").split(",").map((o) => o.trim()).filter(Boolean)),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
});

export type ServerConfig = {
  publicUrl: string;
  databaseUrl: string;
  masterKey: string;
  /** Where people sign in to the embedded authorization server. */
  oidcProviders: Array<{ id: string; name: string; issuer: string; clientId: string; clientSecret: string }>;
  /** Other issuers whose tokens the MCP endpoint accepts, besides the embedded one. */
  trustedIssuers: Array<{ issuer: string; jwksUri: string }>;
  allowedOrigins: string[];
  port: number;
};

/**
 * Read and validate the server's settings from the environment. Throws one
 * error listing every problem, never echoing values (they include secrets).
 */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(env)"}: ${i.message}`);
    throw new Error(`invalid configuration:\n${problems.join("\n")}`);
  }
  const e = parsed.data;
  return {
    publicUrl: e.CAIRNMCP_PUBLIC_URL,
    databaseUrl: e.CAIRNMCP_DATABASE_URL,
    masterKey: e.CAIRNMCP_MASTER_KEY,
    oidcProviders: e.CAIRNMCP_OIDC_PROVIDERS,
    trustedIssuers: e.CAIRNMCP_TRUSTED_ISSUERS ?? [],
    allowedOrigins: e.CAIRNMCP_ALLOWED_ORIGINS,
    port: e.PORT,
  };
}
