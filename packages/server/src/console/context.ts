// What every console route needs: the app's services, the signed-in user, and
// the team-role check that runs tenant work inside the tenant (RLS).
import { hasTeamRole, TenantId, type TeamRole, type UserId } from "@cairnmcp/core";
import { memberRole, type Database, type TenantTx } from "@cairnmcp/db";
import { json, type Route } from "@cairnmcp/http";
import type { Runtime } from "@cairnmcp/runtime";
import type { Vault } from "@cairnmcp/vault";
import type { DocumentGetter } from "../fetch-document.ts";

/** Services and settings shared by every console route. */
export type ConsoleContext = {
  db: Database;
  vault: Vault;
  runtime: Runtime;
  getDocument: DocumentGetter;
  /** Public origin, e.g. `https://cairnmcp.example.com`. */
  base: string;
};

export type Session = { userId: UserId; label: string };

/** One authenticated API request. Route params are the path captures, tenant id first. */
export type ApiRequest = { ctx: ConsoleContext; request: Request; user: Session };
export type ApiRoute = Route<ApiRequest>;

/** The MCP endpoint URL of a toolset. */
export function endpointUrl(ctx: ConsoleContext, tenantId: string, toolsetId: string): string {
  return `${ctx.base}/mcp/${tenantId}/${toolsetId}`;
}

/**
 * Run `fn` inside the tenant if the signed-in user is on its active team with
 * at least the role `need` (D-038): `viewer` to look, `editor` to curate tools,
 * plans, and customers, `admin` for keys and the team. Customers, suspended
 * people, and outsiders get the same 404 as a missing tenant: nothing to probe.
 * Returns `fn`'s value, or the refusal as a Response.
 */
export async function asTeam<T>(
  { ctx, user }: ApiRequest,
  tenantInput: string,
  need: TeamRole,
  fn: (tx: TenantTx, tenantId: TenantId, role: TeamRole) => Promise<T | Response>,
): Promise<T | Response> {
  const tenantId = TenantId.safeParse(tenantInput).data;
  if (!tenantId) return json(404, { error: "not_found" });
  return ctx.db.withTenant(tenantId, async (tx) => {
    const role = await memberRole(tx, user.userId);
    if (!role || role === "customer") return json(404, { error: "not_found" });
    if (!hasTeamRole(role, need)) return json(403, { error: "forbidden", message: `only ${ROLE_NEEDED[need]} can do this` });
    return fn(tx, tenantId, role);
  });
}

const ROLE_NEEDED: Record<TeamRole, string> = {
  viewer: "team members",
  editor: "editors, admins, and owners",
  admin: "admins and owners",
  owner: "owners",
};

/** `asTeam` for a route whose whole answer comes from inside the tenant. */
export async function teamResponse<T>(
  api: ApiRequest,
  tenantInput: string,
  need: TeamRole,
  fn: (tx: TenantTx, tenantId: TenantId, role: TeamRole) => Promise<T | Response>,
): Promise<Response> {
  return result(await asTeam(api, tenantInput, need, fn));
}

/** A value as a 200 JSON response, or a Response as-is. */
export function result(value: unknown): Response {
  return value instanceof Response ? value : json(200, value);
}
