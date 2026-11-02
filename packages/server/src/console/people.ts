// The team and customers (D-038): roles, suspending, notes, removing, and
// which profiles someone holds.
import type { CustomerPage, Person, Removed } from "@cairnmcp/console-api";
import { hasTeamRole, UserId, type MemberRole, type TeamRole } from "@cairnmcp/core";
import {
  ensureMember,
  getMember,
  listCustomers,
  memberProfileIds,
  PG,
  pgErrorCode,
  removeMember,
  setMemberProfiles,
  setMemberRole,
  signInProfileIds,
  updateMember,
  usageFor,
  type Member,
  type TenantTx,
} from "@cairnmcp/db";
import { json } from "@cairnmcp/http";
import { accessView } from "./access.ts";
import { issuesText, MemberEdit, MemberProfiles, readBody, RoleEdit } from "./bodies.ts";
import { asTeam, result, teamResponse, type ApiRequest, type ApiRoute } from "./context.ts";

const MEMBER = /^\/tenants\/([^/]+)\/members\/([^/]+)$/;
const NOT_SIGNED_IN = "no such account: they need to sign in once first (connecting to an MCP URL is enough)";

export const peopleRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: /^\/tenants\/([^/]+)\/customers$/,
    handle: (api, [tenant]) =>
      teamResponse(api, tenant!, "viewer", async (tx) => {
        const params = new URL(api.request.url).searchParams;
        const page = await listCustomers(tx, { query: params.get("q") ?? "", ...(params.get("after") ? { after: params.get("after")! } : {}), limit: 50 });
        const usage = await usageFor(tx, page.customers.map((c) => c.userId), new Date());
        const customers = await peopleView(tx, page.customers, api.user.userId);
        return { ...page, customers: customers.map((c) => ({ ...c, usage: usage.get(c.userId as UserId) ?? { today: 0, month: 0 } })) } satisfies CustomerPage;
      }),
  },
  {
    // Add someone to the team (or make them a customer). Returns the access page.
    method: "PUT",
    path: /^\/tenants\/([^/]+)\/members\/([^/]+)\/role$/,
    handle: async (api, [tenant, userInput]) => {
      const body = await readBody(api.request, RoleEdit);
      const userId = UserId.safeParse(userInput).data;
      if (!body.success || !userId) return json(400, { error: "invalid_request", message: body.success ? "invalid account id" : issuesText(body.error) });
      return teamResponse(api, tenant!, "admin", async (tx, _tenantId, actor) => {
        const target = await getMember(tx, userId);
        const refusal = refuse(api, actor, userId, target?.role, body.data.role);
        if (refusal) return refusal;
        try {
          if (!(await ensureMember(tx, userId, body.data.role))) await setMemberRole(tx, userId, body.data.role);
        } catch (e) {
          if (pgErrorCode(e) === PG.FOREIGN_KEY_VIOLATION) return json(404, { error: "not_found", message: NOT_SIGNED_IN });
          throw e;
        }
        return accessView(tx, api.user);
      });
    },
  },
  {
    method: "PUT",
    path: MEMBER,
    handle: async (api, [tenant, userInput]) => {
      const body = await readBody(api.request, MemberEdit);
      const userId = UserId.safeParse(userInput).data;
      if (!body.success || !userId) return json(400, { error: "invalid_request", message: body.success ? "invalid account id" : issuesText(body.error) });
      return onMember(api, tenant!, userId, async (tx, target) => {
        if (body.data.status !== undefined && userId === api.user.userId) return json(403, { error: "forbidden", message: "you can't suspend or resume yourself" });
        const note = body.data.note === undefined ? undefined : body.data.note || null;
        await updateMember(tx, userId, { ...(body.data.status ? { status: body.data.status } : {}), ...(note !== undefined ? { note } : {}) });
        const updated = (await getMember(tx, userId)) ?? target;
        return (await peopleView(tx, [updated], api.user.userId))[0]! satisfies Person;
      });
    },
  },
  {
    method: "DELETE",
    path: MEMBER,
    handle: async (api, [tenant, userInput]) => {
      const userId = UserId.safeParse(userInput).data;
      if (!userId) return json(400, { error: "invalid_request", message: "invalid account id" });
      return onMember(api, tenant!, userId, async (tx) => {
        if (userId === api.user.userId) return json(403, { error: "forbidden", message: "you can't remove yourself" });
        // Their grants and profiles go with them (foreign keys cascade).
        await removeMember(tx, userId);
        return { ok: true } satisfies Removed;
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
      return teamResponse(api, tenant!, "editor", async (tx) => {
        try {
          // Giving someone a profile adds them as a customer, like a direct grant does.
          if (body.data.profiles.length === 0 && !(await getMember(tx, userId))) {
            return json(404, { error: "not_found", message: "that account isn't in this tenant" });
          }
          await ensureMember(tx, userId);
          await setMemberProfiles(tx, userId, body.data.profiles);
        } catch (e) {
          if (pgErrorCode(e) === PG.FOREIGN_KEY_VIOLATION) return json(404, { error: "not_found", message: `${NOT_SIGNED_IN}, or no such profile` });
          throw e;
        }
        return accessView(tx, api.user);
      });
    },
  },
];

/**
 * Run `fn` for an existing member if the signed-in user may manage them:
 * editors manage customers, admins the team, owners other owners.
 */
async function onMember(api: ApiRequest, tenant: string, userId: UserId, fn: (tx: TenantTx, target: Member) => Promise<unknown>): Promise<Response> {
  return result(
    await asTeam(api, tenant, "editor", async (tx, _tenantId, actor) => {
      const target = await getMember(tx, userId);
      if (!target) return json(404, { error: "not_found", message: "that account isn't in this tenant" });
      return refuse(api, actor, userId, target.role) ?? fn(tx, target);
    }),
  );
}

/** Why `actor` may not act on someone with role `current` (or give them `next`), if they may not. */
function refuse(api: ApiRequest, actor: TeamRole, userId: UserId, current: MemberRole | undefined, next?: MemberRole): Response | undefined {
  if (next !== undefined && userId === api.user.userId) return json(403, { error: "forbidden", message: "you can't change your own role" });
  const need: TeamRole = current === "owner" || next === "owner" ? "owner" : current === "customer" && next === undefined ? "editor" : "admin";
  if (!hasTeamRole(actor, need)) {
    const what = need === "owner" ? "owners" : "admins and owners";
    return json(403, { error: "forbidden", message: `only ${what} can change this person` });
  }
  return undefined;
}

/** Members as the console shows them, with the profiles they hold and which came from sign-in; `me` is the signed-in user. */
export async function peopleView(tx: TenantTx, members: readonly Member[], me: UserId): Promise<Person[]> {
  const ids = members.map((m) => m.userId);
  const held = await memberProfileIds(tx, ids);
  const fromSignIn = await signInProfileIds(tx, ids);
  return members.map((m) => ({
    userId: m.userId,
    label: m.label,
    role: m.role,
    status: m.status,
    note: m.note,
    since: m.createdAt,
    profiles: held.get(m.userId) ?? [],
    signInProfiles: fromSignIn.get(m.userId) ?? [],
    you: m.userId === me,
  }));
}
