import { z } from "zod";
import type { JsonValue } from "./ir/json-schema.ts";
import { OperationId, ProfileId, ToolsetId, type UserId } from "./ir/ids.ts";
import type { SideEffect } from "./ir/side-effect.ts";
import { omitUndefined } from "./util.ts";

/**
 * Who is making a call, after their token was validated (D-022, D-023).
 * `claims` are the validated token's claims; nothing reads them yet, but
 * on-behalf-of credentials and claim-based policies (milestone 3b) will.
 */
export type Caller = {
  userId: UserId;
  claims: Readonly<Record<string, JsonValue>>;
};

/**
 * Someone's role in a tenant (D-038). The team (owner, admin, editor, viewer)
 * may open the console; customers only call tools. Calling tools is decided by
 * grants and profiles for everyone, whatever their role.
 */
export const MemberRole = z.enum(["owner", "admin", "editor", "viewer", "customer"]);
export type MemberRole = z.infer<typeof MemberRole>;
export const TeamRole = MemberRole.exclude(["customer"]);
export type TeamRole = z.infer<typeof TeamRole>;
/** Suspended people are refused everywhere but keep their grants and profiles. */
export const MemberStatus = z.enum(["active", "suspended"]);
export type MemberStatus = z.infer<typeof MemberStatus>;

const TEAM_RANK: Record<MemberRole, number> = { customer: 0, viewer: 1, editor: 2, admin: 3, owner: 4 };

/**
 * Whether `role` may do what `need` may in the console (D-038): viewers look,
 * editors curate tools, plans, and customers, admins also manage keys and the
 * team, owners also manage owners. Customers never pass.
 */
export function hasTeamRole(role: MemberRole | undefined, need: TeamRole): boolean {
  return role !== undefined && role !== "customer" && TEAM_RANK[role] >= TEAM_RANK[need];
}

/**
 * A member's access to one toolset (D-023): `use` calls its read tools,
 * `use_writes` also calls its enabled write and destructive tools.
 * No access at all is the absence of a level.
 */
export const ToolsetAccessLevel = z.enum(["use", "use_writes"]);
export type ToolsetAccessLevel = z.infer<typeof ToolsetAccessLevel>;

/**
 * Whether a member with `level` (or no access, `undefined`) may call a tool
 * with this side effect. Checked on every call, not only when listing tools.
 */
export function canCall(level: ToolsetAccessLevel | undefined, sideEffect: SideEffect): boolean {
  switch (level) {
    case "use_writes":
      return true;
    case "use":
      return sideEffect === "read";
    default:
      return false;
  }
}

/**
 * One grant of access to a toolset (D-034): a level, optionally narrowed to
 * some of its operations. A direct grant is a rule with no operation list.
 */
/**
 * How much one customer may call under a plan (D-039). Each field left out
 * means no limit on it. Allowances count calls across the whole tenant, per
 * UTC day and calendar month.
 */
export const PlanLimits = z.object({
  perDay: z.number().int().min(1).max(1_000_000_000).optional(),
  perMonth: z.number().int().min(1).max(1_000_000_000).optional(),
  /** Where a customer who hits a limit can get more; shown in the limit message. */
  upgradeUrl: z
    .url({ protocol: /^https$/ })
    .max(2000)
    .optional(),
});
export type PlanLimits = z.infer<typeof PlanLimits>;

/** A level on one toolset, optionally narrowed to some operations, and the plan limits that come with it. */
export type AccessRule = { level: ToolsetAccessLevel; operations?: readonly string[] | null; limits?: PlanLimits };

/** Everything that gives a caller access to one toolset; none means no access. */
export type ToolsetAccess = { rules: readonly AccessRule[] };

/**
 * Whether any rule lets the caller call this operation (D-034): its level
 * allows the side effect and, if it lists operations, this one is listed.
 * Lists only narrow: they can't add a write tool to a `use` rule.
 */
export function allowsTool(access: ToolsetAccess, operationId: string, sideEffect: SideEffect): boolean {
  return access.rules.some((r) => canCall(r.level, sideEffect) && (!r.operations || r.operations.includes(operationId)));
}

/**
 * The limits on one call (D-039): of the rules that allow it, the most
 * generous on each count, where a rule without that limit (a direct grant, or
 * a plan that leaves it unset) means no limit. The upgrade link comes from the
 * first allowing rule that has one. Undefined when no rule allows the call.
 */
export function callLimits(access: ToolsetAccess, operationId: string, sideEffect: SideEffect): PlanLimits | undefined {
  const allowing = access.rules.filter((r) => canCall(r.level, sideEffect) && (!r.operations || r.operations.includes(operationId)));
  if (allowing.length === 0) return undefined;
  const loosest = (key: "perDay" | "perMonth") =>
    allowing.every((r) => r.limits?.[key] !== undefined) ? Math.max(...allowing.map((r) => r.limits![key]!)) : undefined;
  const upgradeUrl = allowing.find((r) => r.limits?.upgradeUrl)?.limits?.upgradeUrl;
  return omitUndefined({ perDay: loosest("perDay"), perMonth: loosest("perMonth"), upgradeUrl });
}

/** The highest level among the rules, for display (e.g. "can write" on the consent page). */
export function highestLevel(access: ToolsetAccess): ToolsetAccessLevel | undefined {
  if (access.rules.some((r) => r.level === "use_writes")) return "use_writes";
  return access.rules.length > 0 ? "use" : undefined;
}

/** A rule of an access profile: a level on one toolset, optionally narrowed to some operations. */
export const ProfileRule = z.object({
  toolsetId: ToolsetId,
  level: ToolsetAccessLevel,
  /** Null for every tool the level allows. */
  operations: z.array(OperationId).min(1).max(2000).nullable().default(null),
});
export type ProfileRule = z.infer<typeof ProfileRule>;

/** A named permission set that a tenant assigns to members (D-034). */
export const AccessProfile = z
  .object({
    id: ProfileId,
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    rules: z.array(ProfileRule).max(200),
    /** What a plan allows each customer who holds it (D-039). */
    limits: PlanLimits.default({}),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    p.rules.forEach((r, i) => {
      if (seen.has(r.toolsetId)) ctx.addIssue({ code: "custom", path: ["rules", i, "toolsetId"], message: `more than one rule for toolset ${r.toolsetId}` });
      seen.add(r.toolsetId);
    });
  });
export type AccessProfile = z.infer<typeof AccessProfile>;
