// Queries on tenant data. Every function takes a `TenantTx` from
// `Database.withTenant` and writes `tenant_id` from the transaction's own
// setting, so a row can't be written for a tenant other than the current one.
import {
  AccessProfile,
  allowsTool,
  instantOf,
  IrDocument,
  MemberRole,
  MemberStatus,
  omitUndefined,
  type PlanLimits,
  SourceId,
  TenantId,
  Toolset,
  ToolsetAccessLevel,
  ToolsetId,
  UserId,
  type AccessRule,
  type Instant,
  type SideEffect,
  type SideEffectCounts,
} from "@cairnmcp/core";
import type { AuditEvent } from "@cairnmcp/runtime";
import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import type { TenantTx } from "./client.ts";
import { accessProfiles, auditEvents, memberProfiles, memberships, profileRules, sources, tenants, toolsetAccess, toolsets, usageCounters, users } from "./schema.ts";

const currentTenant = sql<string>`cairnmcp.current_tenant_id()`;

// --- People: the team and customers (D-038) ---------------------------------------

export type Member = { userId: UserId; label: string | null; role: MemberRole; status: MemberStatus; note: string | null; createdAt: Instant };

const memberColumns = {
  userId: memberships.userId,
  label: users.label,
  role: memberships.role,
  status: memberships.status,
  note: memberships.note,
  createdAt: memberships.createdAt,
};
type MemberRow = { userId: string; label: string | null; role: MemberRole; status: MemberStatus; note: string | null; createdAt: Date };
const toMember = (r: MemberRow): Member => ({ ...r, userId: UserId.parse(r.userId), createdAt: instantOf(r.createdAt) });

export async function addMember(tx: TenantTx, userId: UserId, role: MemberRole): Promise<void> {
  await tx.insert(memberships).values({ tenantId: currentTenant, userId: UserId.parse(userId), role: MemberRole.parse(role) });
}

export async function removeMember(tx: TenantTx, userId: UserId): Promise<boolean> {
  const rows = await tx.delete(memberships).where(eq(memberships.userId, userId)).returning({ userId: memberships.userId });
  return rows.length > 0;
}

/**
 * The role of an active member, or undefined for non-members and suspended
 * people. Every access check goes through this, so suspending someone shuts
 * them out of the MCP endpoint, consent, and the console at once.
 */
export async function memberRole(tx: TenantTx, userId: UserId): Promise<MemberRole | undefined> {
  const [row] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.status, "active")));
  return row?.role;
}

/** Someone's membership whatever their status, with their label. */
export async function getMember(tx: TenantTx, userId: UserId): Promise<Member | undefined> {
  const [row] = await tx.select(memberColumns).from(memberships).leftJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.userId, userId));
  return row && toMember(row);
}

/**
 * Add `userId` with `role` (a customer unless said otherwise) unless they're
 * already in the tenant, in any role or status. Returns whether they were
 * added. Throws a foreign-key violation (`PG.FOREIGN_KEY_VIOLATION`) if no
 * such user exists: they have to sign in once first.
 */
export async function ensureMember(tx: TenantTx, userId: UserId, role: MemberRole = "customer"): Promise<boolean> {
  const rows = await tx
    .insert(memberships)
    .values({ tenantId: currentTenant, userId: UserId.parse(userId), role: MemberRole.parse(role) })
    .onConflictDoNothing()
    .returning({ userId: memberships.userId });
  return rows.length > 0;
}

/** Change someone's role. False if they aren't in the tenant. */
export async function setMemberRole(tx: TenantTx, userId: UserId, role: MemberRole): Promise<boolean> {
  const rows = await tx.update(memberships).set({ role: MemberRole.parse(role) }).where(eq(memberships.userId, userId)).returning({ userId: memberships.userId });
  return rows.length > 0;
}

/** Suspend or resume someone, or change the team's note on them (`null` clears it). */
export async function updateMember(tx: TenantTx, userId: UserId, change: { status?: MemberStatus; note?: string | null }): Promise<boolean> {
  if (change.status === undefined && change.note === undefined) return (await getMember(tx, userId)) !== undefined;
  const rows = await tx
    .update(memberships)
    .set(omitUndefined({ status: change.status === undefined ? undefined : MemberStatus.parse(change.status), note: change.note }))
    .where(eq(memberships.userId, userId))
    .returning({ userId: memberships.userId });
  return rows.length > 0;
}

/** Active owners. A tenant must always keep at least one. */
export async function countOwners(tx: TenantTx): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.role, "owner"), eq(memberships.status, "active")));
  return row?.n ?? 0;
}

/** Everyone who isn't a customer, oldest first. A team is small, so no paging. */
export async function listTeam(tx: TenantTx): Promise<Member[]> {
  const rows = await tx
    .select(memberColumns)
    .from(memberships)
    .leftJoin(users, eq(users.id, memberships.userId))
    .where(ne(memberships.role, "customer"))
    .orderBy(asc(memberships.createdAt), asc(memberships.userId));
  return rows.map(toMember);
}

export type CustomerPage = { customers: Member[]; total: number; next?: string };

/**
 * One page of customers, newest first. `query` matches the label, account id,
 * or note (case-insensitive, substring). `after` is the `next` of the previous
 * page.
 */
export async function listCustomers(tx: TenantTx, options: { query?: string; after?: string; limit?: number } = {}): Promise<CustomerPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const query = options.query?.trim();
  const like = query ? `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : undefined;
  const matches = like ? or(ilike(users.label, like), ilike(memberships.userId, like), ilike(memberships.note, like)) : undefined;
  const cursor = options.after ? decodeCursor(options.after) : undefined;
  const before = cursor
    ? sql`(${memberships.createdAt}, ${memberships.userId}) < (${cursor.at}::timestamptz, ${cursor.userId})`
    : undefined;
  const isCustomer = eq(memberships.role, "customer");

  const rows = await tx
    // The cursor keeps Postgres's own text for the time: a JS Date would drop microseconds.
    .select({ ...memberColumns, at: sql<string>`${memberships.createdAt}::text` })
    .from(memberships)
    .leftJoin(users, eq(users.id, memberships.userId))
    .where(and(isCustomer, matches, before))
    .orderBy(desc(memberships.createdAt), desc(memberships.userId))
    .limit(limit + 1);
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .leftJoin(users, eq(users.id, memberships.userId))
    .where(and(isCustomer, matches));
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return omitUndefined({
    customers: page.map(({ at: _, ...r }) => toMember(r)),
    total: count?.n ?? 0,
    next: rows.length > limit && last ? encodeCursor(last.at, last.userId) : undefined,
  });
}

// Keyset paging on (created_at, user_id), newest first. Opaque to callers.
function encodeCursor(at: string, userId: string): string {
  return Buffer.from(JSON.stringify([at, userId])).toString("base64url");
}
function decodeCursor(value: string): { at: string; userId: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString());
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return undefined;
    // Only a timestamp reaches the ::timestamptz cast, so a bad cursor can't make the query fail.
    return Number.isNaN(Date.parse(parsed[0])) ? undefined : { at: parsed[0], userId: parsed[1] };
  } catch {
    return undefined;
  }
}

/** The current tenant's display name. */
export async function tenantName(tx: TenantTx): Promise<string | undefined> {
  const [row] = await tx.select({ name: tenants.name }).from(tenants);
  return row?.name;
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

/**
 * Every source with its full, validated IR. Loads and parses every document,
 * which is slow for big APIs: prefer `listSourceSummaries`, `listSourceIds`,
 * or `listOperationEffects` when they are enough.
 */
export async function listSources(tx: TenantTx): Promise<StoredSource[]> {
  const rows = await tx.select().from(sources).orderBy(asc(sources.id));
  return rows.map((row) => ({ id: SourceId.parse(row.id), name: row.name, ir: IrDocument.parse(row.ir) }));
}

export async function listSourceIds(tx: TenantTx): Promise<SourceId[]> {
  const rows = await tx.select({ id: sources.id }).from(sources).orderBy(asc(sources.id));
  return rows.map((r) => SourceId.parse(r.id));
}

export type SourceSummary = { id: SourceId; name: string; operations: SideEffectCounts };

/** Each source's name and operation counts, computed in Postgres without loading the IR. */
export async function listSourceSummaries(tx: TenantTx): Promise<SourceSummary[]> {
  const count = (effect: SideEffect) =>
    sql<number>`(SELECT count(*)::int FROM jsonb_array_elements(${sources.ir}->'operations') o WHERE o->'sideEffect'->>'class' = ${effect})`;
  const rows = await tx
    .select({
      id: sources.id,
      name: sources.name,
      total: sql<number>`jsonb_array_length(${sources.ir}->'operations')`,
      read: count("read"),
      write: count("write"),
      destructive: count("destructive"),
    })
    .from(sources)
    .orderBy(asc(sources.id));
  return rows.map((r) => ({ id: SourceId.parse(r.id), name: r.name, operations: { total: r.total, read: r.read, write: r.write, destructive: r.destructive } }));
}

/** Each source's operations and their side effects (source id → operation id → effect), without loading the IR. */
export async function listOperationEffects(tx: TenantTx): Promise<Map<string, Map<string, SideEffect>>> {
  const { rows } = await tx.execute<{ source_id: string; operation_id: string; effect: SideEffect }>(sql`
    SELECT s.id AS source_id, o->>'id' AS operation_id, o->'sideEffect'->>'class' AS effect
    FROM ${sources} s, jsonb_array_elements(s.ir->'operations') o`);
  const out = new Map<string, Map<string, SideEffect>>();
  for (const r of rows) {
    const ops = out.get(r.source_id) ?? new Map<string, SideEffect>();
    ops.set(r.operation_id, r.effect);
    out.set(r.source_id, ops);
  }
  return out;
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

/** A toolset with the source it curates, or undefined if either is missing. */
export async function getToolsetWithSource(tx: TenantTx, toolsetId: string): Promise<{ toolset: Toolset; source: StoredSource } | undefined> {
  const toolset = await getToolset(tx, toolsetId);
  const source = toolset && (await getSource(tx, toolset.sourceId));
  return toolset && source ? { toolset, source } : undefined;
}

/**
 * A version of a toolset and its source together: it changes whenever either
 * row is written (Postgres `xmin` is the writing transaction). Cheap, so
 * callers can cache what they derive from the full rows and check it per request.
 */
export async function toolsetVersion(tx: TenantTx, toolsetId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ version: sql<string>`${toolsets}.xmin::text || ':' || ${sources}.xmin::text` })
    .from(toolsets)
    .innerJoin(sources, and(eq(sources.tenantId, toolsets.tenantId), eq(sources.id, toolsets.sourceId)))
    .where(eq(toolsets.id, toolsetId));
  return row?.version;
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
    .select({ level: profileRules.level, operations: profileRules.operations, profileId: accessProfiles.id, profileName: accessProfiles.name, ...limitColumns })
    .from(memberProfiles)
    .innerJoin(profileRules, and(eq(profileRules.profileId, memberProfiles.profileId), eq(profileRules.toolsetId, toolsetId)))
    .innerJoin(accessProfiles, eq(accessProfiles.id, memberProfiles.profileId))
    .where(eq(memberProfiles.userId, userId))
    .orderBy(asc(accessProfiles.name));
  return {
    rules: [
      ...(direct ? [{ level: direct, operations: null, via: { kind: "direct" as const } }] : []),
      ...fromProfiles.map((r) => ({
        level: r.level,
        operations: r.operations,
        limits: limitsOf(r),
        via: { kind: "profile" as const, profileId: r.profileId, profileName: r.profileName },
      })),
    ],
  };
}

/** Whether `userId` may call this operation in this toolset (D-023, D-034). Check on every call. */
export async function mayCallTool(tx: TenantTx, input: { toolsetId: string; userId: UserId; operationId: string; sideEffect: SideEffect }): Promise<boolean> {
  return allowsTool(await toolsetAccessFor(tx, input.toolsetId, input.userId), input.operationId, input.sideEffect);
}

// --- Access profiles (D-034) -------------------------------------------------------

export type StoredProfile = AccessProfile & { members: UserId[] };

const limitColumns = {
  requestsPerMinute: accessProfiles.requestsPerMinute,
  perDay: accessProfiles.perDay,
  perMonth: accessProfiles.perMonth,
  upgradeUrl: accessProfiles.upgradeUrl,
};
type LimitRow = { requestsPerMinute: number | null; perDay: number | null; perMonth: number | null; upgradeUrl: string | null };
const limitsOf = (r: LimitRow): PlanLimits =>
  omitUndefined({
    requestsPerMinute: r.requestsPerMinute ?? undefined,
    perDay: r.perDay ?? undefined,
    perMonth: r.perMonth ?? undefined,
    upgradeUrl: r.upgradeUrl ?? undefined,
  });

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
      limits: limitsOf(p),
    }),
    members: members.filter((m) => m.profileId === p.id).map((m) => UserId.parse(m.userId)),
  }));
}

/** Create or replace a profile and its rules. Its members stay. */
export async function putProfile(tx: TenantTx, profile: AccessProfile): Promise<void> {
  const p = AccessProfile.parse(profile);
  await tx
    .insert(accessProfiles)
    .values({ tenantId: currentTenant, id: p.id, name: p.name, description: p.description ?? null, ...limitValues(p.limits) })
    .onConflictDoUpdate({
      target: [accessProfiles.tenantId, accessProfiles.id],
      set: { name: p.name, description: p.description ?? null, ...limitValues(p.limits), updatedAt: sql`now()` },
    });
  await tx.delete(profileRules).where(eq(profileRules.profileId, p.id));
  if (p.rules.length > 0) {
    await tx.insert(profileRules).values(p.rules.map((r) => ({ tenantId: currentTenant, profileId: p.id, toolsetId: r.toolsetId, level: r.level, operations: r.operations })));
  }
}

function limitValues(l: PlanLimits): LimitRow {
  return { requestsPerMinute: l.requestsPerMinute ?? null, perDay: l.perDay ?? null, perMonth: l.perMonth ?? null, upgradeUrl: l.upgradeUrl ?? null };
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
  for (const r of rows) {
    const user = UserId.parse(r.userId);
    out.set(user, [...(out.get(user) ?? []), r.profileId]);
  }
  return out;
}

// --- Usage and allowances (D-039) -------------------------------------------------------

export type UsagePeriods = { day: string; month: string };

/** The UTC day and calendar month `now` falls in (as `YYYY-MM-DD` starts), and when each ends. */
export function usagePeriods(now: Date): UsagePeriods & { dayEnds: Instant; monthEnds: Instant } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  return {
    day: iso(new Date(Date.UTC(y, m, d))),
    month: iso(new Date(Date.UTC(y, m, 1))),
    dayEnds: instantOf(new Date(Date.UTC(y, m, d + 1))),
    monthEnds: instantOf(new Date(Date.UTC(y, m + 1, 1))),
  };
}

export type Allowance =
  | { ok: true; periods: UsagePeriods }
  | { ok: false; period: "day" | "month"; limit: number; resetsAt: Instant };

/**
 * Count one call for `userId`, unless that would go over a daily or monthly
 * allowance. Each counter only goes up while it's under its limit, in one
 * statement, so concurrent calls can't overshoot. Every call counts, limited
 * or not. Pass `periods` from an `ok` answer to `refundAllowance` if the call
 * never reached the API.
 */
export async function takeAllowance(tx: TenantTx, userId: UserId, limits: Pick<PlanLimits, "perDay" | "perMonth">, now: Date): Promise<Allowance> {
  const p = usagePeriods(now);
  if (!(await bump(tx, userId, "month", p.month, limits.perMonth))) return { ok: false, period: "month", limit: limits.perMonth!, resetsAt: p.monthEnds };
  if (!(await bump(tx, userId, "day", p.day, limits.perDay))) {
    await unbump(tx, userId, "month", p.month);
    return { ok: false, period: "day", limit: limits.perDay!, resetsAt: p.dayEnds };
  }
  return { ok: true, periods: { day: p.day, month: p.month } };
}

/** Give back a call `takeAllowance` counted. */
export async function refundAllowance(tx: TenantTx, userId: UserId, periods: UsagePeriods): Promise<void> {
  await unbump(tx, userId, "month", periods.month);
  await unbump(tx, userId, "day", periods.day);
}

async function bump(tx: TenantTx, userId: UserId, period: "day" | "month", start: string, limit: number | undefined): Promise<boolean> {
  const rows = await tx
    .insert(usageCounters)
    .values({ tenantId: currentTenant, userId: UserId.parse(userId), period, periodStart: start, calls: 1 })
    .onConflictDoUpdate({
      target: [usageCounters.tenantId, usageCounters.userId, usageCounters.period, usageCounters.periodStart],
      set: { calls: sql`${usageCounters.calls} + 1` },
      ...(limit === undefined ? {} : { setWhere: sql`${usageCounters.calls} < ${limit}` }),
    })
    .returning({ calls: usageCounters.calls });
  return rows.length > 0;
}

async function unbump(tx: TenantTx, userId: UserId, period: "day" | "month", start: string): Promise<void> {
  await tx
    .update(usageCounters)
    .set({ calls: sql`${usageCounters.calls} - 1` })
    .where(and(eq(usageCounters.userId, userId), eq(usageCounters.period, period), eq(usageCounters.periodStart, start), sql`${usageCounters.calls} > 0`));
}

/** Calls each user made today and this month (UTC). Users with none are left out. */
export async function usageFor(tx: TenantTx, userIds: readonly UserId[], now: Date): Promise<Map<UserId, { today: number; month: number }>> {
  const out = new Map<UserId, { today: number; month: number }>();
  if (userIds.length === 0) return out;
  const p = usagePeriods(now);
  const rows = await tx
    .select({ userId: usageCounters.userId, period: usageCounters.period, calls: usageCounters.calls })
    .from(usageCounters)
    .where(
      and(
        inArray(usageCounters.userId, [...userIds]),
        or(and(eq(usageCounters.period, "day"), eq(usageCounters.periodStart, p.day)), and(eq(usageCounters.period, "month"), eq(usageCounters.periodStart, p.month))),
      ),
    );
  for (const r of rows) {
    const user = UserId.parse(r.userId);
    const entry = out.get(user) ?? { today: 0, month: 0 };
    if (r.period === "day") entry.today = r.calls;
    else entry.month = r.calls;
    out.set(user, entry);
  }
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
    at: instantOf(r.at),
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
