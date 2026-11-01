import { z } from "zod";
import type { JsonValue } from "./ir/json-schema.ts";
import type { UserId } from "./ir/ids.ts";
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
