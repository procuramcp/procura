import { z } from "zod";
import type { IrDocument } from "./document.ts";
import { OperationId, SourceId, ToolName, ToolsetId } from "./ids.ts";
import { JsonValue, type JsonSchema } from "./json-schema.ts";
import type { Operation } from "./operation.ts";

/** One operation exposed as one tool, renamed and re-described for agents. */
export const ToolBinding = z.object({
  operationId: OperationId,
  name: ToolName,
  title: z.string().max(200).optional(),
  /** Agent-facing description. Written for models: explicit, short, with an example if useful. */
  description: z.string().min(1).max(4000),
  /** The only switch. `defaultToolset` enables read tools; users can enable anything else. */
  enabled: z.boolean().default(true),
  /**
   * Input values fixed by the toolset and hidden from the agent. Used to
   * narrow an operation, e.g. pin `id: "0"` so an Intervals.icu tool can only
   * address the authenticated athlete.
   */
  pinnedInputs: z.record(z.string(), JsonValue).default({}),
});
export type ToolBinding = z.infer<typeof ToolBinding>;

/** A curated subset of one source's operations that a tenant's MCP endpoint serves. */
export const Toolset = z
  .object({
    id: ToolsetId,
    sourceId: SourceId,
    name: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    tools: z.array(ToolBinding),
  })
  .superRefine((ts, ctx) => {
    const names = new Set<string>();
    ts.tools.forEach((t, i) => {
      if (names.has(t.name)) ctx.addIssue({ code: "custom", path: ["tools", i, "name"], message: `duplicate tool name "${t.name}"` });
      names.add(t.name);
    });
  });
export type Toolset = z.infer<typeof Toolset>;

/** MCP tool annotations (protocol 2025-11-25). Hints for clients, not a security boundary. */
export type ToolAnnotations = {
  title?: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

/** A tool ready to be served: everything the MCP layer needs. */
export type ResolvedTool = {
  name: ToolName;
  description: string;
  /** Operation input with pinned properties removed. */
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  pinnedInputs: Record<string, JsonValue>;
  operation: Operation;
};

export type ToolsetIssue = {
  toolName: string;
  code: "source_mismatch" | "unknown_operation" | "unknown_pinned_input";
  message: string;
};

export type ResolveResult = { ok: true; tools: ResolvedTool[] } | { ok: false; issues: ToolsetIssue[] };

/**
 * Starting toolset for a source: every operation becomes a tool, and only
 * read operations are enabled. This is the one safety default (DECISIONS
 * D-016); users can enable any other tool directly, with no further opt-in.
 */
export function defaultToolset(ir: IrDocument, options: { id: string; name: string }): Toolset {
  return Toolset.parse({
    id: options.id,
    sourceId: ir.source.id,
    name: options.name,
    tools: ir.operations.map((op) => ({
      operationId: op.id,
      name: op.id,
      title: op.title,
      description: op.description.length <= 4000 ? op.description : `${op.description.slice(0, 3999)}…`,
      enabled: op.sideEffect.class === "read",
    })),
  });
}

/**
 * Check a toolset against the IR it curates and produce the tools to serve.
 * Disabled tools are skipped. Side effects never block a tool: enabling it is
 * the user's decision, and the MCP annotations tell clients what it does.
 * Structural issues (unknown operation, bad pin) fail the whole toolset, so a
 * broken edit never silently serves a partial set.
 */
export function resolveToolset(toolset: Toolset, ir: IrDocument): ResolveResult {
  const issues: ToolsetIssue[] = [];
  if (toolset.sourceId !== ir.source.id) {
    issues.push({
      toolName: "*",
      code: "source_mismatch",
      message: `toolset is for source "${toolset.sourceId}", IR is "${ir.source.id}"`,
    });
    return { ok: false, issues };
  }

  const byId = new Map(ir.operations.map((op) => [op.id as string, op]));
  const tools: ResolvedTool[] = [];

  for (const binding of toolset.tools) {
    if (!binding.enabled) continue;
    const op = byId.get(binding.operationId);
    const issue = (code: ToolsetIssue["code"], message: string) => issues.push({ toolName: binding.name, code, message });

    if (!op) {
      issue("unknown_operation", `operation "${binding.operationId}" does not exist in source "${ir.source.id}"`);
      continue;
    }
    const props = inputProperties(op.input);
    for (const key of Object.keys(binding.pinnedInputs)) {
      if (!(key in props)) issue("unknown_pinned_input", `pinned input "${key}" is not an input of "${op.id}"`);
    }

    tools.push({
      name: binding.name,
      description: binding.description,
      inputSchema: withoutProperties(op.input, Object.keys(binding.pinnedInputs)),
      annotations: toolAnnotations(op, binding.title),
      pinnedInputs: binding.pinnedInputs,
      operation: op,
    });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, tools };
}

/**
 * Derive MCP annotations from the IR. `destructiveHint` defaults to true in
 * the MCP spec, so it is always set explicitly. Idempotency follows HTTP
 * semantics (PUT and DELETE are idempotent; POST and PATCH are not).
 */
export function toolAnnotations(op: Operation, title?: string): ToolAnnotations {
  const effect = op.sideEffect.class;
  const method = op.mapping.method;
  const annotations: ToolAnnotations = {
    readOnlyHint: effect === "read",
    destructiveHint: effect === "destructive",
    idempotentHint: effect === "read" || method === "PUT" || method === "DELETE",
    openWorldHint: true,
  };
  const t = title ?? op.title;
  if (t) annotations.title = t;
  return annotations;
}

function inputProperties(schema: JsonSchema): Record<string, unknown> {
  const props = schema["properties"];
  return typeof props === "object" && props !== null && !Array.isArray(props) ? props : {};
}

function withoutProperties(schema: JsonSchema, names: string[]): JsonSchema {
  if (names.length === 0) return schema;
  const drop = new Set(names);
  const props = Object.fromEntries(Object.entries(inputProperties(schema)).filter(([k]) => !drop.has(k)));
  const required = Array.isArray(schema["required"]) ? schema["required"].filter((r) => typeof r !== "string" || !drop.has(r)) : undefined;
  const out: JsonSchema = { ...schema, properties: props as JsonSchema };
  if (required !== undefined) out["required"] = required;
  return out;
}
