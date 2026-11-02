// Drizzle's view of the tables in migrations/*.sql, for typed queries only.
// The SQL files are the source of truth (constraints, RLS, grants live there);
// schema.test.ts checks that every column here exists in the migrated database.
import { bigint, date, foreignKey, integer, jsonb, pgSchema, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { WrappedKey } from "@cairnmcp/vault";

export const cairnmcp = pgSchema("cairnmcp");

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const tenants = cairnmcp.table("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const users = cairnmcp.table("users", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  subject: text("subject").notNull(),
  label: text("label"),
  createdAt: createdAt(),
});

export const memberships = cairnmcp.table(
  "memberships",
  {
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["owner", "admin", "editor", "viewer", "customer"] }).notNull(),
    status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

export const sources = cairnmcp.table(
  "sources",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    ir: jsonb("ir").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const toolsets = cairnmcp.table(
  "toolsets",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    sourceId: text("source_id").notNull(),
    definition: jsonb("definition").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({ columns: [t.tenantId, t.sourceId], foreignColumns: [sources.tenantId, sources.id] }),
  ],
);

export const toolsetAccess = cairnmcp.table(
  "toolset_access",
  {
    tenantId: text("tenant_id").notNull(),
    toolsetId: text("toolset_id").notNull(),
    userId: text("user_id").notNull(),
    level: text("level", { enum: ["use", "use_writes"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.toolsetId, t.userId] }),
    foreignKey({ columns: [t.tenantId, t.toolsetId], foreignColumns: [toolsets.tenantId, toolsets.id] }),
    foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [memberships.tenantId, memberships.userId] }),
  ],
);

export const dataKeys = cairnmcp.table("data_keys", {
  tenantId: text("tenant_id").primaryKey(),
  keyId: text("key_id").notNull(),
  iv: text("iv").notNull(),
  ciphertext: text("ciphertext").notNull(),
  tag: text("tag").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const credentials = cairnmcp.table(
  "credentials",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    sourceId: text("source_id").notNull(),
    schemeId: text("scheme_id").notNull(),
    kind: text("kind", { enum: ["basic", "bearer", "api_key", "oauth2"] }).notNull(),
    iv: text("iv").notNull(),
    ciphertext: text("ciphertext").notNull(),
    tag: text("tag").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({ columns: [t.tenantId, t.sourceId], foreignColumns: [sources.tenantId, sources.id] }),
  ],
);

export const auditEvents = cairnmcp.table(
  "audit_events",
  {
    tenantId: text("tenant_id").notNull(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    invocationId: text("invocation_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    phase: text("phase", { enum: ["intent", "outcome"] }).notNull(),
    sourceId: text("source_id").notNull(),
    toolName: text("tool_name").notNull(),
    operationId: text("operation_id").notNull(),
    sideEffect: text("side_effect", { enum: ["read", "write", "destructive"] }).notNull(),
    method: text("method").notNull(),
    pathTemplate: text("path_template").notNull(),
    input: jsonb("input").notNull(),
    outcome: jsonb("outcome"),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.seq] })],
);

// OAuth authorization server (0002_oauth.sql). Global tables, no tenant_id.

export const oauthClients = cairnmcp.table("oauth_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  createdAt: createdAt(),
});

export const oauthRequests = cairnmcp.table("oauth_requests", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  state: text("state"),
  resource: text("resource").notNull(),
  scope: text("scope").notNull(),
  browserHash: text("browser_hash"),
  provider: text("provider"),
  upstreamStateHash: text("upstream_state_hash"),
  upstreamNonce: text("upstream_nonce"),
  upstreamVerifier: text("upstream_verifier"),
  userId: text("user_id"),
  userLabel: text("user_label"),
  codeHash: text("code_hash"),
  codeExpiresAt: timestamp("code_expires_at", { withTimezone: true }),
  codeUsedAt: timestamp("code_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const oauthRefreshTokens = cairnmcp.table("oauth_refresh_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  familyId: text("family_id").notNull(),
  clientId: text("client_id").notNull(),
  userId: text("user_id").notNull(),
  resource: text("resource").notNull(),
  scope: text("scope").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const oauthSigningKeys = cairnmcp.table("oauth_signing_keys", {
  kid: text("kid").primaryKey(),
  alg: text("alg", { enum: ["ES256"] }).notNull(),
  publicJwk: jsonb("public_jwk").$type<Record<string, unknown>>().notNull(),
  wrappedPrivate: jsonb("wrapped_private").$type<WrappedKey>().notNull(),
  createdAt: createdAt(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
});

export const accessProfiles = cairnmcp.table(
  "access_profiles",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    perDay: integer("per_day"),
    perMonth: integer("per_month"),
    upgradeUrl: text("upgrade_url"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const profileRules = cairnmcp.table(
  "profile_rules",
  {
    tenantId: text("tenant_id").notNull(),
    profileId: text("profile_id").notNull(),
    toolsetId: text("toolset_id").notNull(),
    level: text("level", { enum: ["use", "use_writes"] }).notNull(),
    operations: text("operations").array(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.profileId, t.toolsetId] }),
    foreignKey({ columns: [t.tenantId, t.profileId], foreignColumns: [accessProfiles.tenantId, accessProfiles.id] }),
    foreignKey({ columns: [t.tenantId, t.toolsetId], foreignColumns: [toolsets.tenantId, toolsets.id] }),
  ],
);

export const memberProfiles = cairnmcp.table(
  "member_profiles",
  {
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    profileId: text("profile_id").notNull(),
    via: text("via", { enum: ["manual", "sign_in"] }).notNull().default("manual"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId, t.profileId] }),
    foreignKey({ columns: [t.tenantId, t.profileId], foreignColumns: [accessProfiles.tenantId, accessProfiles.id] }),
    foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [memberships.tenantId, memberships.userId] }),
  ],
);

export const consoleLogins = cairnmcp.table("console_logins", {
  stateHash: text("state_hash").primaryKey(),
  provider: text("provider").notNull(),
  nonce: text("nonce").notNull(),
  verifier: text("verifier").notNull(),
  browserHash: text("browser_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const consoleSessions = cairnmcp.table("console_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull(),
  userLabel: text("user_label").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const usageCounters = cairnmcp.table(
  "usage_counters",
  {
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    period: text("period", { enum: ["day", "month"] }).notNull(),
    periodStart: date("period_start").notNull(),
    calls: bigint("calls", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId, t.period, t.periodStart] })],
);

export const tenantSignIn = cairnmcp.table("tenant_sign_in", {
  tenantId: text("tenant_id").primaryKey(),
  config: jsonb("config").notNull(),
  secretIv: text("secret_iv"),
  secretCiphertext: text("secret_ciphertext"),
  secretTag: text("secret_tag"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const profileClaims = cairnmcp.table(
  "profile_claims",
  {
    tenantId: text("tenant_id").notNull(),
    profileId: text("profile_id").notNull(),
    claim: text("claim").notNull(),
    value: text("value").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.profileId, t.claim, t.value] }),
    foreignKey({ columns: [t.tenantId, t.profileId], foreignColumns: [accessProfiles.tenantId, accessProfiles.id] }),
  ],
);

export const upstreamGrants = cairnmcp.table(
  "upstream_grants",
  {
    tenantId: text("tenant_id").notNull(),
    familyId: text("family_id").notNull(),
    userId: text("user_id").notNull(),
    iv: text("iv").notNull(),
    ciphertext: text("ciphertext").notNull(),
    tag: text("tag").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.familyId] })],
);

export const allTables = {
  tenants,
  users,
  memberships,
  sources,
  toolsets,
  toolsetAccess,
  dataKeys,
  credentials,
  auditEvents,
  oauthClients,
  oauthRequests,
  oauthRefreshTokens,
  oauthSigningKeys,
  consoleLogins,
  consoleSessions,
  accessProfiles,
  profileRules,
  memberProfiles,
  usageCounters,
  tenantSignIn,
  profileClaims,
  upstreamGrants,
};
