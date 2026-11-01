// Drizzle's view of the tables in migrations/*.sql, for typed queries only.
// The SQL files are the source of truth (constraints, RLS, grants live there);
// schema.test.ts checks that every column here exists in the migrated database.
import { bigint, foreignKey, jsonb, pgSchema, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

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
  createdAt: createdAt(),
});

export const memberships = cairnmcp.table(
  "memberships",
  {
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
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

export const allTables = { tenants, users, memberships, sources, toolsets, toolsetAccess, dataKeys, credentials, auditEvents };
