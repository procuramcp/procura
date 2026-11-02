import { z } from "zod";
import type { JsonValue } from "./ir/json-schema.ts";
import { OperationId, ProfileId, ToolsetId, type UserId } from "./ir/ids.ts";
import type { SideEffect } from "./ir/side-effect.ts";

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
export type AccessRule = { level: ToolsetAccessLevel; operations?: readonly string[] | null };

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
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    p.rules.forEach((r, i) => {
      if (seen.has(r.toolsetId)) ctx.addIssue({ code: "custom", path: ["rules", i, "toolsetId"], message: `more than one rule for toolset ${r.toolsetId}` });
      seen.add(r.toolsetId);
    });
  });
export type AccessProfile = z.infer<typeof AccessProfile>;
