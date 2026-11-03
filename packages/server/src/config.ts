import { parseMasterKey } from "@procura/vault";
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
  PROCURA_PUBLIC_URL: PublicUrl,
  PROCURA_DATABASE_URL: z.string().startsWith("postgres", "must be a postgres:// URL"),
  PROCURA_MASTER_KEY: z.string().superRefine((key, ctx) => {
    try {
      parseMasterKey(key);
    } catch (e) {
      // parseMasterKey's messages name the problem, never the value.
      ctx.addIssue({ code: "custom", message: (e as Error).message.replace(/^PROCURA_MASTER_KEY /, "") });
    }
  }),
  PROCURA_OIDC_PROVIDERS: OidcProviders,
  PROCURA_TRUSTED_ISSUERS: TrustedIssuers.optional(),
  PROCURA_ALLOWED_ORIGINS: z
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
  // An empty value counts as unset: .env files and compose pass optional settings as `NAME=`.
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = Env.safeParse(set);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => {
      const name = String(i.path[0] ?? "(env)");
      return `  ${name}: ${i.path.length === 1 && !(name in set) ? "required, but not set" : i.message}`;
    });
    throw new Error(`invalid configuration (every setting is described in .env.example):\n${problems.join("\n")}`);
  }
  const e = parsed.data;
  return {
    publicUrl: e.PROCURA_PUBLIC_URL,
    databaseUrl: e.PROCURA_DATABASE_URL,
    masterKey: e.PROCURA_MASTER_KEY,
    oidcProviders: e.PROCURA_OIDC_PROVIDERS,
    trustedIssuers: e.PROCURA_TRUSTED_ISSUERS ?? [],
    allowedOrigins: e.PROCURA_ALLOWED_ORIGINS,
    port: e.PORT,
  };
}
