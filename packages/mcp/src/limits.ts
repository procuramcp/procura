// Plan limits on one tool call (D-039): the daily and monthly allowances,
// checked and taken before the runtime runs the call.
import type { PlanLimits, TenantId, UserId } from "@procura/core";
import { refundAllowance, takeAllowance, type Database, type UsagePeriods } from "@procura/db";
import type { RuntimeError, ToolResult } from "@procura/runtime";

/**
 * Failures that don't use up an allowance: the call never reached the API
 * (an agent's typo, a missing key, our own throttling), or the API turned it
 * away for being too busy (a 429 is `rate_limited` too). Either way the
 * customer got nothing for it.
 */
const NOT_SENT = new Set<RuntimeError["kind"]>(["invalid_input", "missing_credentials", "rate_limited", "egress_blocked", "unsupported", "audit_failed"]);

export type LimitContext = {
  db: Database;
  tenantId: TenantId;
  userId: UserId;
  now: () => Date;
};

/**
 * Run `call` if the caller's allowances have room, counting it against them.
 * Allowances live in Postgres, so they hold across restarts and instances.
 */
export async function withinLimits(c: LimitContext, limits: PlanLimits, call: () => Promise<ToolResult>): Promise<ToolResult> {
  const now = c.now();
  const allowance = await c.db.withTenant(c.tenantId, (tx) => takeAllowance(tx, c.userId, limits, now));
  if (!allowance.ok) {
    const when = allowance.period === "day" ? "today" : "this month";
    const wait = Math.max(1, Math.ceil((Date.parse(allowance.resetsAt) - now.getTime()) / 1000));
    return refused(
      `You've used all ${allowance.limit} calls your plan allows ${when}. They start over at ${allowance.resetsAt} (in ${duration(wait)}).`,
      // An agent shouldn't keep retrying for hours: it should tell the person.
      { retryable: false, retryAfterSeconds: wait, resetsAt: allowance.resetsAt },
      limits,
    );
  }

  const result = await call();
  if (!result.ok && NOT_SENT.has(result.error.kind)) await refund(c, allowance.periods);
  return result;
}

async function refund(c: LimitContext, periods: UsagePeriods): Promise<void> {
  await c.db.withTenant(c.tenantId, (tx) => refundAllowance(tx, c.userId, periods));
}

function refused(message: string, extra: Partial<RuntimeError>, limits: PlanLimits): ToolResult {
  const upgrade = limits.upgradeUrl ? ` To get more, upgrade at ${limits.upgradeUrl}` : "";
  return {
    ok: false,
    error: { kind: "limit_reached", message: message + upgrade, retryable: false, ...extra, ...(limits.upgradeUrl ? { upgradeUrl: limits.upgradeUrl } : {}) },
  };
}

/** "5h 12m", "3m", "40s". */
export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}
