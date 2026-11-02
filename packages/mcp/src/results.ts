import { omitUndefined, type ResolvedTool } from "@cairnmcp/core";
import type { ToolResult } from "@cairnmcp/runtime";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

/** A resolved tool as MCP describes it. */
export function toMcpTool(tool: ResolvedTool): Tool {
  return {
    name: tool.name,
    ...(tool.annotations.title !== undefined ? { title: tool.annotations.title } : {}),
    description: tool.description,
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    annotations: tool.annotations,
  };
}

/**
 * A runtime result as an MCP tool result. Output is the upstream's, as-is
 * (D-021): JSON as text plus structured content, which MCP requires to be an
 * object, so anything else is wrapped as `{ result }`. Failures are tool
 * results with `isError`, so the agent can read the message and decide.
 */
export function toCallToolResult(result: ToolResult): CallToolResult {
  if (!result.ok) {
    const { kind, message, retryable, retryAfterSeconds, status, resetsAt, upgradeUrl } = result.error;
    return {
      isError: true,
      content: [{ type: "text", text: message }],
      structuredContent: { error: omitUndefined({ kind, message, retryable, retryAfterSeconds, status, resetsAt, upgradeUrl }) },
    };
  }
  const { data } = result;
  if (typeof data === "string") return { content: [{ type: "text", text: data }] };
  const structured = data !== null && typeof data === "object" && !Array.isArray(data) ? data : { result: data };
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: structured };
}
