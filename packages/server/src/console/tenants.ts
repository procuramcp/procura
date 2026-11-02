// The tenant overview and creating a toolset from a source.
import type { CreatedToolset, TenantView } from "@cairnmcp/console-api";
import { defaultToolset } from "@cairnmcp/core";
import { getSource, getToolset, listMembers, listSourceSummaries, listToolsets, putToolset, setToolsetAccess, tenantName } from "@cairnmcp/db";
import { json } from "@cairnmcp/http";
import { issuesText, NewToolset, readBody } from "./bodies.ts";
import { editorResponse, endpointUrl, type ApiRoute } from "./context.ts";

export const tenantRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: /^\/tenants\/([^/]+)$/,
    handle: (api, [tenant]) =>
      editorResponse(api, tenant!, async (tx, tenantId) => {
        const sources = await listSourceSummaries(tx);
        const toolsets = await listToolsets(tx);
        const members = await listMembers(tx);
        return {
          tenant: { id: tenantId, name: (await tenantName(tx)) ?? tenantId },
          sources: sources.map((s) => ({ id: s.id, name: s.name, operations: s.operations.total, reads: s.operations.read })),
          toolsets: toolsets.map((t) => ({ id: t.id, name: t.name, sourceId: t.sourceId, enabledTools: t.tools.filter((b) => b.enabled).length, endpoint: endpointUrl(api.ctx, tenantId, t.id) })),
          members: members.map((m) => ({ ...m, you: m.userId === api.user.userId })),
        } satisfies TenantView;
      }),
  },
  {
    method: "POST",
    path: /^\/tenants\/([^/]+)\/toolsets$/,
    handle: async (api, [tenant]) => {
      const body = await readBody(api.request, NewToolset);
      if (!body.success) return json(400, { error: "invalid_request", message: issuesText(body.error) });
      return editorResponse(api, tenant!, async (tx, tenantId) => {
        if (await getToolset(tx, body.data.id)) return json(409, { error: "conflict", message: `a toolset ${body.data.id} already exists` });
        const source = await getSource(tx, body.data.sourceId);
        if (!source) return json(404, { error: "not_found", message: `no source ${body.data.sourceId}` });
        const toolset = defaultToolset(source.ir, { id: body.data.id, name: body.data.name });
        await putToolset(tx, toolset);
        // The creator can use it right away.
        await setToolsetAccess(tx, toolset.id, api.user.userId, "use");
        return json(201, { id: toolset.id, endpoint: endpointUrl(api.ctx, tenantId, toolset.id) } satisfies CreatedToolset);
      });
    },
  },
];
