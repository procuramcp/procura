// Access profiles and who holds them (D-034).
import type { AccessView } from "@cairnmcp/console-api";
import { AccessProfile, UserId } from "@cairnmcp/core";
import { deleteProfile, ensureMember, listMembers, listOperationEffects, listProfiles, listToolsets, memberProfileIds, memberRole, PG, pgErrorCode, putProfile, setMemberProfiles, type TenantTx } from "@cairnmcp/db";
import { json } from "@cairnmcp/http";
import { issuesText, MemberProfiles, ProfileEdit, readBody } from "./bodies.ts";
import { editorResponse, type ApiRoute, type Session } from "./context.ts";

export const accessRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: /^\/tenants\/([^/]+)\/access$/,
    handle: (api, [tenant]) => editorResponse(api, tenant!, (tx) => accessView(tx, api.user)),
  },
  {
    method: ["PUT", "DELETE"],
    path: /^\/tenants\/([^/]+)\/profiles\/([^/]+)$/,
    handle: async (api, [tenant, profileId]) => {
      const body = api.request.method === "PUT" ? await readBody(api.request, ProfileEdit) : undefined;
      if (body && !body.success) return json(400, { error: "invalid_request", message: issuesText(body.error) });
      return editorResponse(api, tenant!, async (tx) => {
        if (!body) {
          if (!(await deleteProfile(tx, profileId!))) return json(404, { error: "not_found", message: `no profile ${profileId}` });
          return accessView(tx, api.user);
        }
        const { description, ...rest } = body.data!;
        const parsed = AccessProfile.safeParse({ ...rest, ...(description?.trim() ? { description } : {}), id: profileId });
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
  {
    method: "PUT",
    path: /^\/tenants\/([^/]+)\/members\/([^/]+)\/profiles$/,
    handle: async (api, [tenant, userInput]) => {
      const body = await readBody(api.request, MemberProfiles);
      const userId = UserId.safeParse(userInput).data;
      if (!body.success || !userId) return json(400, { error: "invalid_request", message: body.success ? "invalid account id" : issuesText(body.error) });
      return editorResponse(api, tenant!, async (tx) => {
        try {
          // Giving someone a profile makes them a member, like a direct grant does (they must have signed in once).
          if (body.data.profiles.length === 0 && !(await memberRole(tx, userId))) {
            return json(404, { error: "not_found", message: "that account isn't a member of this tenant" });
          }
          await ensureMember(tx, userId);
          await setMemberProfiles(tx, userId, body.data.profiles);
        } catch (e) {
          if (pgErrorCode(e) === PG.FOREIGN_KEY_VIOLATION) return json(404, { error: "not_found", message: "no such account (they need to sign in once first) or no such profile" });
          throw e;
        }
        return accessView(tx, api.user);
      });
    },
  },
];

/** Profiles, who holds them, and what they can point at. */
async function accessView(tx: TenantTx, user: Session): Promise<Response> {
  const profiles = await listProfiles(tx);
  const members = await listMembers(tx);
  const held = await memberProfileIds(tx);
  const toolsets = await listToolsets(tx);
  const effects = await listOperationEffects(tx);
  return json(200, {
    profiles,
    members: members.map((m) => ({ ...m, you: m.userId === user.userId, profiles: held.get(m.userId) ?? [] })),
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
