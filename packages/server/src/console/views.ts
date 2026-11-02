// The JSON shapes the console API returns for IR objects, typed by the shared
// contract (@cairnmcp/console-api) that the web console also uses.
import type { AuthSchemeView, OperationView } from "@cairnmcp/console-api";
import type { AuthScheme, Operation } from "@cairnmcp/core";

export function schemeView(scheme: AuthScheme): AuthSchemeView {
  return {
    id: scheme.id,
    type: scheme.type,
    ...(scheme.description ? { description: scheme.description.slice(0, 500) } : {}),
    ...(scheme.type === "http_basic" && scheme.fixedUsername ? { fixedUsername: scheme.fixedUsername } : {}),
    ...(scheme.type === "api_key" ? { in: scheme.in, name: scheme.name } : {}),
  };
}

export function operationView(op: Operation): OperationView {
  const props = (op.input["properties"] ?? {}) as Record<string, { type?: unknown; description?: string }>;
  const required = new Set((op.input["required"] as string[] | undefined) ?? []);
  return {
    id: op.id,
    title: op.title,
    description: op.description,
    method: op.mapping.method,
    path: op.mapping.pathTemplate,
    tags: op.tags,
    deprecated: op.deprecated,
    sideEffect: op.sideEffect,
    inputs: Object.entries(props).map(([name, schema]) => ({ name, type: typeof schema.type === "string" ? schema.type : "any", description: schema.description ?? "", required: required.has(name) })),
    inputSchema: op.input,
  };
}

/** Which tool a Zod issue path in a toolset edit points at, for error messages. */
export function toolNameAt(body: { tools: unknown[] }, path: PropertyKey[]): string {
  if (path[0] === "tools" && typeof path[1] === "number") {
    const tool = body.tools[path[1]] as { name?: unknown } | undefined;
    return typeof tool?.name === "string" ? tool.name : `tool ${path[1] + 1}`;
  }
  return "toolset";
}
