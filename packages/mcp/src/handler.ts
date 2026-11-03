import { allowsTool, callLimits, TenantId, ToolsetId, UserId, type Caller, type IrDocument, type ResolvedTool, type Toolset, type ToolsetAccess } from "@procura/core";
import { getToolsetWithSource, memberRole, toolsetAccessFor, toolsetVersion, type Database } from "@procura/db";
import { json } from "@procura/http";
import type { Runtime } from "@procura/runtime";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ToolsetCache } from "./cache.ts";
import { withinLimits } from "./limits.ts";
import { toCallToolResult, toMcpTool } from "./results.ts";
import { bearerToken, type TokenVerifier } from "./token.ts";

export type McpHandlerOptions = {
  db: Database;
  verifier: TokenVerifier;
  runtime: Runtime;
  /** Public base URL, e.g. `https://procura.example.com`. Resource URLs and token audiences derive from it. */
  publicUrl: string;
  /** Browser origins allowed to call the endpoint. Requests with any other `Origin` are refused (DNS rebinding). */
  allowedOrigins?: string[];
  version?: string;
  /** Resolved toolsets reused across requests. Injected for tests; one per handler by default. */
  cache?: ToolsetCache;
  /** The clock for allowances. Injected for tests. */
  now?: () => Date;
};

const METADATA_PREFIX = "/.well-known/oauth-protected-resource";

/**
 * The MCP endpoint, one per toolset: `/mcp/{tenantId}/{toolsetId}`.
 *
 * It is an OAuth resource server (D-022): every request carries a bearer
 * token from a trusted issuer whose audience is that endpoint's URL. The
 * token resolves to a user, the user must be a member of the tenant with
 * access to the toolset, and the tools they see and may call follow their
 * access level (D-023). Stateless: each HTTP request checks membership and
 * access fresh, so a revoked grant applies to the very next call. The toolset
 * itself is resolved once per version and reused (`ToolsetCache`).
 */
export function createMcpHandler(options: McpHandlerOptions): (request: Request) => Promise<Response> {
  const base = options.publicUrl.replace(/\/+$/, "");
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const issuers = options.verifier.issuers;
  const cache = options.cache ?? new ToolsetCache();
  const now = options.now ?? (() => new Date());

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok", { status: 200 });

    const origin = request.headers.get("origin");
    if (origin !== null && !allowedOrigins.has(origin)) return json(403, { error: "forbidden", error_description: "origin not allowed" });

    // Protected-resource metadata (RFC 9728), path-inserted: tells clients which issuers to get tokens from.
    if (url.pathname.startsWith(`${METADATA_PREFIX}/`)) {
      const route = parseRoute(url.pathname.slice(METADATA_PREFIX.length));
      if (!route || request.method !== "GET") return json(404, { error: "not_found" });
      return json(200, {
        resource: `${base}${route.path}`,
        authorization_servers: issuers,
        bearer_methods_supported: ["header"],
        scopes_supported: ["mcp"],
        resource_name: "procura",
      });
    }

    const route = parseRoute(url.pathname);
    if (!route) return json(404, { error: "not_found" });
    if (request.method !== "POST") {
      // Stateless JSON responses: no server-initiated stream (GET) and no sessions to end (DELETE).
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }

    const resource = `${base}${route.path}`;
    const challenge = (params: string) => `Bearer ${params}${params ? ", " : ""}resource_metadata="${base}${METADATA_PREFIX}${route.path}"`;
    const token = bearerToken(request.headers.get("authorization"));
    if (!token) return json(401, { error: "unauthorized", error_description: "a bearer token is required" }, { "www-authenticate": challenge("") });
    const checked = await options.verifier.verify(token, resource);
    if (!checked.ok) {
      return json(401, { error: "invalid_token", error_description: checked.reason }, { "www-authenticate": challenge(`error="invalid_token", error_description="${checked.reason}"`) });
    }

    // Same answer for "no such user", "no such tenant", and "not a member": nothing to probe.
    const forbidden = () => json(403, { error: "forbidden", error_description: "you are not a member of this tenant" });
    const { token: verified } = checked;
    const userId = verified.subjectIsUserId
      ? UserId.safeParse(verified.subject).data
      : await options.db.findUser(verified.issuer, verified.subject);
    if (!userId) return forbidden();
    const loaded = await options.db.withTenant(route.tenantId, async (tx) => {
      if (!(await memberRole(tx, userId))) return "forbidden" as const;
      const version = await toolsetVersion(tx, route.toolsetId);
      const entry =
        version &&
        (await cache.get(route.tenantId, route.toolsetId, version, async () => {
          const found = await getToolsetWithSource(tx, route.toolsetId);
          return found && { toolset: found.toolset, ir: found.source.ir };
        }));
      if (!entry) return "not_found" as const;
      return { entry, access: await toolsetAccessFor(tx, route.toolsetId, userId) };
    });
    if (loaded === "forbidden") return forbidden();
    if (loaded === "not_found") return json(404, { error: "not_found", error_description: "no such toolset" });
    if (loaded.access.rules.length === 0) return json(403, { error: "forbidden", error_description: "you don't have access to this toolset" });

    const { toolset, ir, resolved } = loaded.entry;
    if (!resolved.ok) return json(500, { error: "toolset_invalid", error_description: "this toolset has problems and can't be served; fix it in the toolset settings" });

    const caller: Caller = { userId, claims: verified.claims };
    return serveMcp(request, { ...options, now, tenantId: route.tenantId, caller, toolset, ir, access: loaded.access, tools: resolved.tools });
  };
}

type Session = McpHandlerOptions & {
  now: () => Date;
  tenantId: TenantId;
  caller: Caller;
  toolset: Toolset;
  ir: IrDocument;
  /** The caller's direct grant and profile rules for this toolset (D-034). */
  access: ToolsetAccess;
  tools: ResolvedTool[];
};

async function serveMcp(request: Request, s: Session): Promise<Response> {
  // Tools the caller may not call are hidden, and calling one by name gets the same answer as a tool that doesn't exist.
  const visible = new Map(s.tools.filter((t) => allowsTool(s.access, t.operation.id, t.operation.sideEffect.class)).map((t) => [t.name as string, t]));

  const server = new Server(
    { name: "procura", title: s.toolset.name, version: s.version ?? "0.0.0" },
    { capabilities: { tools: {} }, ...(s.toolset.description ? { instructions: s.toolset.description } : {}) },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...visible.values()].map(toMcpTool) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = visible.get(req.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${req.params.name}`);
    // The plan's limits for this tool: the most generous of the rules that allow it (D-039).
    const limits = callLimits(s.access, tool.operation.id, tool.operation.sideEffect.class) ?? {};
    const result = await withinLimits({ db: s.db, tenantId: s.tenantId, userId: s.caller.userId, now: s.now }, limits, () =>
      s.runtime.invoke({ tenantId: s.tenantId, caller: s.caller, source: s.ir.source, tool, args: req.params.arguments ?? {} }),
    );
    return toCallToolResult(result);
  });

  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true }) // no sessionIdGenerator: stateless;
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

type Route = { tenantId: TenantId; toolsetId: ToolsetId; path: string };

/**
 * The MCP endpoint a resource URL names (RFC 8707), or undefined if it isn't
 * exactly one of ours: same origin as `publicUrl`, no query or fragment.
 * The authorization server uses this so it only issues tokens for real endpoints.
 */
export function parseMcpResource(publicUrl: string, resource: string): { tenantId: TenantId; toolsetId: ToolsetId; resource: string } | undefined {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return undefined;
  }
  const base = new URL(publicUrl);
  if (url.origin !== base.origin || url.search || url.hash || url.username || url.password) return undefined;
  const route = parseRoute(url.pathname);
  return route && { tenantId: route.tenantId, toolsetId: route.toolsetId, resource: `${base.origin}${route.path}` };
}

function parseRoute(pathname: string): Route | undefined {
  const match = /^\/mcp\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return undefined;
  const tenantId = TenantId.safeParse(match[1]);
  const toolsetId = ToolsetId.safeParse(match[2]);
  if (!tenantId.success || !toolsetId.success) return undefined;
  return { tenantId: tenantId.data, toolsetId: toolsetId.data, path: `/mcp/${tenantId.data}/${toolsetId.data}` };
}
