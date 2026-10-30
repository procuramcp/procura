import type { Instant, JsonValue, SideEffect, TenantId } from "@cairnmcp/core";

/**
 * One entry in the tenant-scoped audit log. Every non-read tool call writes an
 * `intent` entry before the upstream request and an `outcome` entry after.
 * Inputs are recorded (they are the agent's arguments, never credentials).
 */
export type AuditEvent = {
  invocationId: string;
  tenantId: TenantId;
  at: Instant;
  phase: "intent" | "outcome";
  sourceId: string;
  toolName: string;
  operationId: string;
  sideEffect: SideEffect;
  method: string;
  pathTemplate: string;
  input: JsonValue;
  outcome?: { ok: boolean; status?: number; errorKind?: string };
};

export interface AuditSink {
  /** Must durably record before resolving; a rejection stops the write from happening. */
  record(event: AuditEvent): Promise<void>;
}

export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
}
