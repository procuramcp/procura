// What every console route needs: the app's services, the signed-in user, and
// the editor check that runs tenant work inside the tenant (RLS).
import { TenantId, type UserId } from "@cairnmcp/core";
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
 * Run `fn` inside the tenant if the signed-in user may edit it (owner or
 * admin). Returns `fn`'s value, or the refusal as a Response.
 */
export async function asEditor<T>(
  { ctx, user }: ApiRequest,
  tenantInput: string,
  fn: (tx: TenantTx, tenantId: TenantId) => Promise<T | Response>,
): Promise<T | Response> {
  const tenantId = TenantId.safeParse(tenantInput).data;
  if (!tenantId) return json(404, { error: "not_found" });
  return ctx.db.withTenant(tenantId, async (tx) => {
    const role = await memberRole(tx, user.userId);
    // Same answer for "no such tenant" and "not a member": nothing to probe.
    if (!role) return json(404, { error: "not_found" });
    if (role === "member") return json(403, { error: "forbidden", message: "only owners and admins can edit this tenant" });
    return fn(tx, tenantId);
  });
}

/** `asEditor` for a route whose whole answer comes from inside the tenant. */
export async function editorResponse<T>(api: ApiRequest, tenantInput: string, fn: (tx: TenantTx, tenantId: TenantId) => Promise<T | Response>): Promise<Response> {
  return result(await asEditor(api, tenantInput, fn));
}

/** A value as a 200 JSON response, or a Response as-is. */
export function result(value: unknown): Response {
  return value instanceof Response ? value : json(200, value);
}
