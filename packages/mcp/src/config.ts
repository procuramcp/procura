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

const TrustedIssuers = z
  .string()
  .transform((text, ctx) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "must be JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.object({ issuer: z.url(), jwksUri: z.url().refine((u) => u.startsWith("https://") || LOCAL_HOSTS.has(new URL(u).hostname), "must be https") })).min(1));

const Env = z.object({
  CAIRNMCP_PUBLIC_URL: PublicUrl,
  CAIRNMCP_DATABASE_URL: z.string().startsWith("postgres", "must be a postgres:// URL"),
  CAIRNMCP_MASTER_KEY: z.string().min(1),
  CAIRNMCP_TRUSTED_ISSUERS: TrustedIssuers,
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
    trustedIssuers: e.CAIRNMCP_TRUSTED_ISSUERS,
    allowedOrigins: e.CAIRNMCP_ALLOWED_ORIGINS,
    port: e.PORT,
  };
}
