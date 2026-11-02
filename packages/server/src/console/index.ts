// The curation console (D-033): browser sign-in, sessions, the JSON API under
// /app/api, and the built single-page app under /app. Editing is for tenant
// owners and admins; every tenant read and write runs inside the tenant (RLS).
//
// Adding an API route: declare its body and response types in the contract
// (packages/console-api), put the route in the table of its area (tenants.ts,
// toolsets.ts, access.ts, sources.ts) with `satisfies` on the body it sends, add
// the call to packages/web/src/lib/api.ts, and cover it in console.test.ts.
import type { IdentityProvider } from "@cairnmcp/auth";
import type { ApiErrorBody, Me } from "@cairnmcp/console-api";
import type { Database } from "@cairnmcp/db";
import { BodyError, dispatch, json, redirect } from "@cairnmcp/http";
import type { Runtime } from "@cairnmcp/runtime";
import type { Vault } from "@cairnmcp/vault";
import { safeGet, type DocumentGetter } from "../fetch-document.ts";
import { accessRoutes } from "./access.ts";
import { customerSignInRoutes } from "./customer-sign-in.ts";
import { peopleRoutes } from "./people.ts";
import type { ApiRoute, ConsoleContext } from "./context.ts";
import { signIn } from "./sign-in.ts";
import { sourceRoutes } from "./sources.ts";
import { staticFiles } from "./static.ts";
import { tenantRoutes } from "./tenants.ts";
import { toolsetRoutes } from "./toolsets.ts";

export { purgeExpiredConsoleState } from "./sign-in.ts";

export type ConsoleOptions = {
  db: Database;
  vault: Vault;
  /** How API descriptions are fetched from URLs (D-035). Injected in tests. */
  getDocument?: DocumentGetter;
  publicUrl: string;
  providers: IdentityProvider[];
  runtime: Runtime;
  /** The built app (packages/web/dist). Without it, /app explains how to build it. */
  staticDir?: string;
  now?: () => number;
};

const API_ROUTES: readonly ApiRoute[] = [...tenantRoutes, ...toolsetRoutes, ...accessRoutes, ...peopleRoutes, ...customerSignInRoutes, ...sourceRoutes];

export function createConsoleHandler(options: ConsoleOptions): (request: Request) => Promise<Response | undefined> {
  const base = new URL(options.publicUrl).origin;
  const ctx: ConsoleContext = { db: options.db, vault: options.vault, runtime: options.runtime, getDocument: options.getDocument ?? safeGet, base };
  const auth = signIn({ db: options.db, base, providers: options.providers, now: options.now ?? Date.now });
  const staticFile = staticFiles(options.staticDir);

  async function api(request: Request, path: string): Promise<Response> {
    const method = request.method;
    if (method !== "GET" && method !== "HEAD") {
      // CSRF: with SameSite=Lax cookies, a same-origin Origin and a JSON body together rule out other sites.
      if (request.headers.get("origin") !== base) return json(403, { error: "forbidden", message: "requests must come from the console itself" });
      if (method !== "DELETE" && !(request.headers.get("content-type") ?? "").startsWith("application/json")) return json(415, { error: "unsupported_media_type" });
    }
    const user = await auth.session(request);
    if (!user) return json(401, { error: "signed_out", providers: auth.providerList } satisfies ApiErrorBody);
    if (path === "/me" && method === "GET") {
      const tenants = await options.db.userTenants(user.userId);
      return json(200, { user: { id: user.userId, label: user.label }, tenants: tenants.map((t) => ({ id: t.tenantId, name: t.name, role: t.role })) } satisfies Me);
    }
    if (path === "/logout" && method === "POST") return auth.logout(request);
    return (await dispatch(API_ROUTES, { ctx, request, user }, method, path)) ?? json(404, { error: "not_found" });
  }

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/app") return redirect(`${base}/app/`);
    if (!path.startsWith("/app/")) return undefined;
    if (path.startsWith("/app/api/")) {
      try {
        return await api(request, path.slice("/app/api".length));
      } catch (e) {
        if (e instanceof BodyError) return json(400, { error: "invalid_request", message: e.message });
        throw e;
      }
    }
    const login = /^\/app\/login\/([a-z0-9-]+)$/.exec(path);
    if (login && request.method === "GET") return auth.login(login[1]!);
    const callback = /^\/app\/callback\/([a-z0-9-]+)$/.exec(path);
    if (callback && request.method === "GET") return auth.callback(request, url, callback[1]!);
    if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method_not_allowed" });
    return staticFile(path);
  };
}
