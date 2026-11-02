// One toolset: view, edit, direct access grants, and test calls.
import type { TestResult, ToolsetView } from "@cairnmcp/console-api";
import { canCall, resolveToolset, Toolset, ToolsetId, type Caller, type TenantId } from "@cairnmcp/core";
import { ensureMember, getToolset, getToolsetWithSource, listProfiles, listTeam, PG, pgErrorCode, putToolset, schema, setToolsetAccess, type TenantTx } from "@cairnmcp/db";
import { json } from "@cairnmcp/http";
import { asc, eq } from "drizzle-orm";
import { AccessEdit, issuesText, readBody, ToolsetEdit, ToolTest } from "./bodies.ts";
import { asTeam, endpointUrl, teamResponse, type ApiRequest, type ApiRoute, type ConsoleContext } from "./context.ts";
import { operationView, toolNameAt } from "./views.ts";

const TOOLSET = /^\/tenants\/([^/]+)\/toolsets\/([^/]+)$/;

/** A route on one toolset; an id that can't be a toolset id is a 404 before anything else. */
function onToolset(handle: (api: ApiRequest, tenant: string, toolsetId: ToolsetId) => Promise<Response>): ApiRoute["handle"] {
  return async (api, [tenant, toolset]) => {
    const toolsetId = ToolsetId.safeParse(toolset).data;
    return toolsetId ? handle(api, tenant!, toolsetId) : json(404, { error: "not_found" });
  };
}

const notFound = (toolsetId: string) => json(404, { error: "not_found", message: `no toolset ${toolsetId}` });

export const toolsetRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: TOOLSET,
    handle: onToolset((api, tenant, toolsetId) => teamResponse(api, tenant, "viewer", (tx, tenantId) => toolsetView(api.ctx, tx, tenantId, toolsetId))),
  },
  {
    method: "PUT",
    path: TOOLSET,
    handle: onToolset(async (api, tenant, toolsetId) => {
      const body = await readBody(api.request, ToolsetEdit);
      if (!body.success) return json(400, { error: "invalid_request", message: issuesText(body.error) });
      return teamResponse(api, tenant, "editor", async (tx, tenantId) => {
        const existing = await getToolsetWithSource(tx, toolsetId);
        if (!existing) return notFound(toolsetId);
        const parsed = Toolset.safeParse({ ...body.data, id: toolsetId, sourceId: existing.toolset.sourceId });
        if (!parsed.success) return json(422, { error: "invalid_toolset", issues: parsed.error.issues.map((i) => ({ toolName: toolNameAt(body.data, i.path), message: i.message })) });
        const resolved = resolveToolset(parsed.data, existing.source.ir);
        if (!resolved.ok) return json(422, { error: "invalid_toolset", issues: resolved.issues });
        await putToolset(tx, parsed.data);
        return toolsetView(api.ctx, tx, tenantId, toolsetId);
      });
    }),
  },
  {
    method: "PUT",
    path: /^\/tenants\/([^/]+)\/toolsets\/([^/]+)\/access$/,
    handle: onToolset(async (api, tenant, toolsetId) => {
      const body = await readBody(api.request, AccessEdit);
      if (!body.success) return json(400, { error: "invalid_request", message: issuesText(body.error) });
      return teamResponse(api, tenant, "editor", async (tx, tenantId) => {
        if (!(await getToolset(tx, toolsetId))) return notFound(toolsetId);
        if (body.data.level !== "none") {
          try {
            // Someone new becomes a customer (D-038).
            await ensureMember(tx, body.data.userId);
          } catch (e) {
            // Only someone who has signed in once exists as a user.
            if (pgErrorCode(e) === PG.FOREIGN_KEY_VIOLATION) {
              return json(404, { error: "no_such_user", message: "no account with that id: they need to sign in once first (the No access page shows their account id)" });
            }
            throw e;
          }
        }
        await setToolsetAccess(tx, toolsetId, body.data.userId, body.data.level === "none" ? undefined : body.data.level);
        return toolsetView(api.ctx, tx, tenantId, toolsetId);
      });
    }),
  },
  {
    method: "POST",
    path: /^\/tenants\/([^/]+)\/toolsets\/([^/]+)\/test$/,
    handle: onToolset(testTool),
  },
];

async function toolsetView(ctx: ConsoleContext, tx: TenantTx, tenantId: TenantId, toolsetId: ToolsetId): Promise<Response> {
  const loaded = await getToolsetWithSource(tx, toolsetId);
  if (!loaded) return notFound(toolsetId);
  const { toolset, source } = loaded;
  const { toolsetAccess, memberships, users } = schema;
  const access = await tx
    .select({ userId: toolsetAccess.userId, label: users.label, role: memberships.role, level: toolsetAccess.level })
    .from(toolsetAccess)
    .innerJoin(memberships, eq(memberships.userId, toolsetAccess.userId))
    .leftJoin(users, eq(users.id, toolsetAccess.userId))
    .where(eq(toolsetAccess.toolsetId, toolsetId))
    .orderBy(asc(toolsetAccess.createdAt));
  const resolved = resolveToolset(toolset, source.ir);
  const profiles = (await listProfiles(tx)).flatMap((p) =>
    p.rules.filter((r) => r.toolsetId === toolsetId).map((r) => ({ profileId: p.id, name: p.name, level: r.level, operations: r.operations, members: p.members })),
  );
  return json(200, {
    toolset,
    profiles,
    endpoint: endpointUrl(ctx, tenantId, toolsetId),
    source: { id: source.id, name: source.name, baseUrl: source.ir.source.baseUrl },
    operations: source.ir.operations.map(operationView),
    access,
    team: (await listTeam(tx)).map((m) => ({ userId: m.userId, label: m.label, role: m.role })),
    issues: resolved.ok ? [] : resolved.issues,
  } satisfies ToolsetView);
}

/** Call one tool as edited (saved or not), resolved the way the MCP endpoint would. */
async function testTool(api: ApiRequest, tenant: string, toolsetId: ToolsetId): Promise<Response> {
  const body = await readBody(api.request, ToolTest);
  if (!body.success) return json(400, { error: "invalid_request", message: issuesText(body.error) });
  // Editors only: a test call uses the tenant's upstream key.
  const loaded = await asTeam(api, tenant, "editor", async (tx, tenantId) => {
    const found = await getToolsetWithSource(tx, toolsetId);
    return found ? { tenantId, toolset: found.toolset, ir: found.source.ir } : notFound(toolsetId);
  });
  if (loaded instanceof Response) return loaded;
  const single = Toolset.safeParse({ id: loaded.toolset.id, sourceId: loaded.toolset.sourceId, name: loaded.toolset.name, tools: [{ ...body.data.tool, enabled: true }] });
  if (!single.success) return json(422, { error: "invalid_toolset", issues: single.error.issues.map((i) => ({ toolName: body.data.tool.name, message: i.message })) });
  const resolved = resolveToolset(single.data, loaded.ir);
  if (!resolved.ok) return json(422, { error: "invalid_toolset", issues: resolved.issues });
  const tool = resolved.tools[0]!;
  const effect = tool.operation.sideEffect.class;
  if (!canCall("use", effect) && !body.data.confirm) {
    return json(409, { error: "confirm_required", message: `${tool.name} is a ${effect} tool: running it changes data in ${loaded.ir.source.name}` });
  }
  const caller: Caller = { userId: api.user.userId, claims: { console: true } };
  const outcome = await api.ctx.runtime.invoke({ tenantId: loaded.tenantId, caller, source: loaded.ir.source, tool, args: body.data.args });
  return json(200, { tool: { name: tool.name, sideEffect: effect, pinnedInputs: tool.pinnedInputs }, args: body.data.args, result: outcome } satisfies TestResult);
}
