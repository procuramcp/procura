// Access profiles (D-034) and the access page: profiles, the team, and how many customers (D-038).
import type { AccessView } from "@cairnmcp/console-api";
import { AccessProfile } from "@cairnmcp/core";
import { deleteProfile, listCustomers, listOperationEffects, listProfiles, listTeam, listToolsets, putProfile, type TenantTx } from "@cairnmcp/db";
import { json } from "@cairnmcp/http";
import { issuesText, ProfileEdit, readBody } from "./bodies.ts";
import { teamResponse, type ApiRoute, type Session } from "./context.ts";
import { peopleView } from "./people.ts";

export const accessRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: /^\/tenants\/([^/]+)\/access$/,
    handle: (api, [tenant]) => teamResponse(api, tenant!, "viewer", (tx) => accessView(tx, api.user)),
  },
  {
    method: ["PUT", "DELETE"],
    path: /^\/tenants\/([^/]+)\/profiles\/([^/]+)$/,
    handle: async (api, [tenant, profileId]) => {
      const body = api.request.method === "PUT" ? await readBody(api.request, ProfileEdit) : undefined;
      if (body && !body.success) return json(400, { error: "invalid_request", message: issuesText(body.error) });
      return teamResponse(api, tenant!, "editor", async (tx) => {
        if (!body) {
          if (!(await deleteProfile(tx, profileId!))) return json(404, { error: "not_found", message: `no profile ${profileId}` });
          return accessView(tx, api.user);
        }
        const { description, ...rest } = body.data!;
        // Limits and claim rules left out keep their saved values, so an older client can't clear them by accident.
        const saved = (await listProfiles(tx)).find((p) => p.id === profileId);
        const kept = { ...(rest.limits === undefined && saved ? { limits: saved.limits } : {}), ...(rest.claims === undefined && saved ? { claims: saved.claims } : {}) };
        const parsed = AccessProfile.safeParse({ ...rest, ...kept, ...(description?.trim() ? { description } : {}), id: profileId });
        if (!parsed.success) return json(422, { error: "invalid_profile", message: issuesText(parsed.error) });
        // Rules may only name toolsets and operations that exist, so a typo can't silently grant nothing.
        const toolsets = new Map((await listToolsets(tx)).map((t) => [t.id as string, t]));
        for (const rule of parsed.data.rules) {
          const toolset = toolsets.get(rule.toolsetId);
          if (!toolset) return json(422, { error: "invalid_profile", message: `no toolset ${rule.toolsetId}` });
          const bound = new Set(toolset.tools.map((t) => t.operationId as string));
          const unknown = rule.operations?.filter((o) => !bound.has(o)) ?? [];
          if (unknown.length > 0) return json(422, { error: "invalid_profile", message: `${toolset.name} has no tool for ${unknown.join(", ")}` });
        }
        await putProfile(tx, parsed.data);
        return accessView(tx, api.user);
      });
    },
  },
];

/** Profiles, the team, how many customers, and what profiles can point at. */
export async function accessView(tx: TenantTx, user: Session): Promise<Response> {
  const profiles = await listProfiles(tx);
  const team = await listTeam(tx);
  const { total: customers } = await listCustomers(tx, { limit: 1 });
  const toolsets = await listToolsets(tx);
  const effects = await listOperationEffects(tx);
  return json(200, {
    profiles,
    team: await peopleView(tx, team, user.userId),
    customers,
    toolsets: toolsets.map((t) => {
      const ops = effects.get(t.sourceId);
      return {
        id: t.id,
        name: t.name,
        // An operation that vanished from its source is shown as the most dangerous kind.
        tools: t.tools.map((b) => ({ operationId: b.operationId, name: b.name, enabled: b.enabled, sideEffect: ops?.get(b.operationId) ?? "destructive" })),
      };
    }),
  } satisfies AccessView);
}
