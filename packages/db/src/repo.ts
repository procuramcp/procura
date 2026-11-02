// Queries on tenant data. Every function takes a `TenantTx` from
// `Database.withTenant` and writes `tenant_id` from the transaction's own
// setting, so a row can't be written for a tenant other than the current one.
import {
  AccessProfile,
  allowsTool,
  Instant,
  IrDocument,
  SourceId,
  TenantId,
  Toolset,
  ToolsetAccessLevel,
  ToolsetId,
  UserId,
  type AccessRule,
  type SideEffect,
} from "@cairnmcp/core";
import type { AuditEvent } from "@cairnmcp/runtime";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { TenantTx } from "./client.ts";
import { accessProfiles, auditEvents, memberProfiles, memberships, profileRules, sources, toolsetAccess, toolsets } from "./schema.ts";

const currentTenant = sql<string>`cairnmcp.current_tenant_id()`;

export type MemberRole = "owner" | "admin" | "member";

export async function addMember(tx: TenantTx, userId: UserId, role: MemberRole): Promise<void> {
  await tx.insert(memberships).values({ tenantId: currentTenant, userId: UserId.parse(userId), role });
}

export async function removeMember(tx: TenantTx, userId: UserId): Promise<boolean> {
  const rows = await tx.delete(memberships).where(eq(memberships.userId, userId)).returning({ userId: memberships.userId });
  return rows.length > 0;
}

export async function memberRole(tx: TenantTx, userId: UserId): Promise<MemberRole | undefined> {
  const [row] = await tx.select({ role: memberships.role }).from(memberships).where(eq(memberships.userId, userId));
  return row?.role;
}

export type StoredSource = { id: SourceId; name: string; ir: IrDocument };

/** Insert or replace a source's IR. */
export async function putSource(tx: TenantTx, ir: IrDocument): Promise<void> {
  const doc = IrDocument.parse(ir);
  await tx
    .insert(sources)
    .values({ tenantId: currentTenant, id: doc.source.id, name: doc.source.name, ir: doc })
    .onConflictDoUpdate({ target: [sources.tenantId, sources.id], set: { name: doc.source.name, ir: doc, updatedAt: sql`now()` } });
}

export async function getSource(tx: TenantTx, id: string): Promise<StoredSource | undefined> {
  const [row] = await tx.select().from(sources).where(eq(sources.id, id));
  return row ? { id: SourceId.parse(row.id), name: row.name, ir: IrDocument.parse(row.ir) } : undefined;
}

export async function listSources(tx: TenantTx): Promise<StoredSource[]> {
  const rows = await tx.select().from(sources).orderBy(asc(sources.id));
  return rows.map((row) => ({ id: SourceId.parse(row.id), name: row.name, ir: IrDocument.parse(row.ir) }));
}

export async function deleteSource(tx: TenantTx, id: string): Promise<boolean> {
  return (await tx.delete(sources).where(eq(sources.id, id)).returning({ id: sources.id })).length > 0;
}

/** Insert or replace a toolset. Its source must exist in the same tenant. */
export async function putToolset(tx: TenantTx, toolset: Toolset): Promise<void> {
  const ts = Toolset.parse(toolset);
  await tx
    .insert(toolsets)
    .values({ tenantId: currentTenant, id: ts.id, sourceId: ts.sourceId, definition: ts })
    .onConflictDoUpdate({ target: [toolsets.tenantId, toolsets.id], set: { sourceId: ts.sourceId, definition: ts, updatedAt: sql`now()` } });
}

export async function getToolset(tx: TenantTx, id: string): Promise<Toolset | undefined> {
  const [row] = await tx.select().from(toolsets).where(eq(toolsets.id, id));
  return row ? Toolset.parse(row.definition) : undefined;
}

export async function listToolsets(tx: TenantTx): Promise<Toolset[]> {
  const rows = await tx.select().from(toolsets).orderBy(asc(toolsets.id));
  return rows.map((row) => Toolset.parse(row.definition));
}

/** Grant, change, or (with `undefined`) revoke a member's access to a toolset. */
export async function setToolsetAccess(tx: TenantTx, toolsetId: ToolsetId, userId: UserId, level: ToolsetAccessLevel | undefined): Promise<void> {
  const where = and(eq(toolsetAccess.toolsetId, toolsetId), eq(toolsetAccess.userId, userId));
  if (level === undefined) {
    await tx.delete(toolsetAccess).where(where);
    return;
  }
  await tx
    .insert(toolsetAccess)
    .values({ tenantId: currentTenant, toolsetId: ToolsetId.parse(toolsetId), userId: UserId.parse(userId), level: ToolsetAccessLevel.parse(level) })
    .onConflictDoUpdate({ target: [toolsetAccess.tenantId, toolsetAccess.toolsetId, toolsetAccess.userId], set: { level } });
}

export async function toolsetAccessLevel(tx: TenantTx, toolsetId: string, userId: UserId): Promise<ToolsetAccessLevel | undefined> {
  const [row] = await tx
    .select({ level: toolsetAccess.level })
    .from(toolsetAccess)
    .where(and(eq(toolsetAccess.toolsetId, toolsetId), eq(toolsetAccess.userId, userId)));
  return row?.level;
}

/** Where a rule of someone's access comes from: their direct grant, or one of their profiles (D-034). */
export type AccessVia = { kind: "direct" } | { kind: "profile"; profileId: string; profileName: string };
export type GrantedRule = AccessRule & { via: AccessVia };

/**
 * Everything that gives `userId` access to one toolset: their direct grant
 * plus the matching rule of each profile they hold (D-034). No rules, no access.
 */
export async function toolsetAccessFor(tx: TenantTx, toolsetId: string, userId: UserId): Promise<{ rules: GrantedRule[] }> {
  const direct = await toolsetAccessLevel(tx, toolsetId, userId);
  const fromProfiles = await tx
    .select({ level: profileRules.level, operations: profileRules.operations, profileId: accessProfiles.id, profileName: accessProfiles.name })
    .from(memberProfiles)
    .innerJoin(profileRules, and(eq(profileRules.profileId, memberProfiles.profileId), eq(profileRules.toolsetId, toolsetId)))
    .innerJoin(accessProfiles, eq(accessProfiles.id, memberProfiles.profileId))
    .where(eq(memberProfiles.userId, userId))
    .orderBy(asc(accessProfiles.name));
  return {
    rules: [
      ...(direct ? [{ level: direct, operations: null, via: { kind: "direct" as const } }] : []),
      ...fromProfiles.map((r) => ({ level: r.level, operations: r.operations, via: { kind: "profile" as const, profileId: r.profileId, profileName: r.profileName } })),
    ],
  };
}

/** Whether `userId` may call this operation in this toolset (D-023, D-034). Check on every call. */
export async function mayCallTool(tx: TenantTx, input: { toolsetId: string; userId: UserId; operationId: string; sideEffect: SideEffect }): Promise<boolean> {
  return allowsTool(await toolsetAccessFor(tx, input.toolsetId, input.userId), input.operationId, input.sideEffect);
}

// --- Access profiles (D-034) -------------------------------------------------------

export type StoredProfile = AccessProfile & { members: UserId[] };

export async function listProfiles(tx: TenantTx): Promise<StoredProfile[]> {
  const profiles = await tx.select().from(accessProfiles).orderBy(asc(accessProfiles.name));
  const rules = await tx.select().from(profileRules);
  const members = await tx.select().from(memberProfiles);
  return profiles.map((p) => ({
    ...AccessProfile.parse({
      id: p.id,
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
      rules: rules.filter((r) => r.profileId === p.id).map((r) => ({ toolsetId: r.toolsetId, level: r.level, operations: r.operations })),
    }),
    members: members.filter((m) => m.profileId === p.id).map((m) => UserId.parse(m.userId)),
  }));
}

/** Create or replace a profile and its rules. Its members stay. */
export async function putProfile(tx: TenantTx, profile: AccessProfile): Promise<void> {
  const p = AccessProfile.parse(profile);
  await tx
    .insert(accessProfiles)
    .values({ tenantId: currentTenant, id: p.id, name: p.name, description: p.description ?? null })
    .onConflictDoUpdate({ target: [accessProfiles.tenantId, accessProfiles.id], set: { name: p.name, description: p.description ?? null, updatedAt: sql`now()` } });
  await tx.delete(profileRules).where(eq(profileRules.profileId, p.id));
  if (p.rules.length > 0) {
    await tx.insert(profileRules).values(p.rules.map((r) => ({ tenantId: currentTenant, profileId: p.id, toolsetId: r.toolsetId, level: r.level, operations: r.operations })));
  }
}

export async function deleteProfile(tx: TenantTx, id: string): Promise<boolean> {
  const deleted = await tx.delete(accessProfiles).where(eq(accessProfiles.id, id)).returning({ id: accessProfiles.id });
  return deleted.length > 0;
}

/** Replace the profiles a member holds. */
export async function setMemberProfiles(tx: TenantTx, userId: UserId, profileIds: readonly string[]): Promise<void> {
  const user = UserId.parse(userId);
  await tx.delete(memberProfiles).where(eq(memberProfiles.userId, user));
  const ids = [...new Set(profileIds)];
  if (ids.length > 0) await tx.insert(memberProfiles).values(ids.map((profileId) => ({ tenantId: currentTenant, userId: user, profileId })));
}

/** The profile ids each member holds. */
export async function memberProfileIds(tx: TenantTx, userIds?: readonly UserId[]): Promise<Map<UserId, string[]>> {
  const rows = await tx
    .select()
    .from(memberProfiles)
    .where(userIds ? inArray(memberProfiles.userId, [...userIds]) : undefined);
  const out = new Map<UserId, string[]>();
  for (const r of rows) out.set(UserId.parse(r.userId), [...(out.get(UserId.parse(r.userId)) ?? []), r.profileId]);
  return out;
}

/** The audit log in write order. */
export async function listAuditEvents(tx: TenantTx, options: { invocationId?: string; limit?: number } = {}): Promise<AuditEvent[]> {
  const rows = await tx
    .select()
    .from(auditEvents)
    .where(options.invocationId === undefined ? undefined : eq(auditEvents.invocationId, options.invocationId))
    .orderBy(asc(auditEvents.seq))
    .limit(options.limit ?? 1000);
  return rows.map((r) => ({
    invocationId: r.invocationId,
    tenantId: TenantId.parse(r.tenantId),
    actorUserId: UserId.parse(r.actorUserId),
    at: toInstant(r.at),
    phase: r.phase,
    sourceId: r.sourceId,
    toolName: r.toolName,
    operationId: r.operationId,
    sideEffect: r.sideEffect,
    method: r.method,
    pathTemplate: r.pathTemplate,
    input: r.input as AuditEvent["input"],
    ...(r.outcome !== null ? { outcome: r.outcome as NonNullable<AuditEvent["outcome"]> } : {}),
  }));
}

export function toInstant(date: Date): Instant {
  return Instant.parse(date.toISOString().replace(/\.000Z$/, "Z"));
}
