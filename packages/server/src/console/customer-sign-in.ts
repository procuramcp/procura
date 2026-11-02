// A tenant's own sign-in for its customers (D-040): which provider, and the
// client secret, sealed in the vault and never sent back.
import { tenantCallbackUrl } from "@cairnmcp/auth";
import type { SignInSettings, SignInView } from "@cairnmcp/console-api";
import { SIGN_IN_SECRET_CONTEXT, SignInConfig, type TenantId } from "@cairnmcp/core";
import { deleteSignIn, getSignIn, listProfiles, putSignIn, type TenantTx } from "@cairnmcp/db";
import { json } from "@cairnmcp/http";
import { issuesText, readBody, SignInEdit } from "./bodies.ts";
import { teamResponse, type ApiRoute, type ConsoleContext } from "./context.ts";

const SIGN_IN = /^\/tenants\/([^/]+)\/sign-in$/;

export const customerSignInRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: SIGN_IN,
    handle: (api, [tenant]) => teamResponse(api, tenant!, "viewer", (tx, tenantId) => signInView(api.ctx, tx, tenantId)),
  },
  {
    // Admins only: this decides who can sign in as a customer.
    method: "PUT",
    path: SIGN_IN,
    handle: async (api, [tenant]) => {
      const body = await readBody(api.request, SignInEdit);
      if (!body.success) return json(400, { error: "invalid_request", message: issuesText(body.error) });
      const { clientSecret, ...settings } = body.data;
      const config = SignInConfig.safeParse(settings);
      if (!config.success) return json(422, { error: "invalid_sign_in", message: issuesText(config.error) });
      return teamResponse(api, tenant!, "admin", async (tx, tenantId) => {
        const existing = await getSignIn(tx);
        if (!clientSecret && !existing?.secret) return json(422, { error: "invalid_sign_in", message: "add the client secret from your provider" });
        const defaultProfile = config.data.defaultProfileId;
        if (defaultProfile && !(await listProfiles(tx)).some((p) => p.id === defaultProfile)) {
          return json(422, { error: "invalid_sign_in", message: `no profile ${defaultProfile}` });
        }
        const sealed = clientSecret ? await api.ctx.vault.sealSecret(tenantId, SIGN_IN_SECRET_CONTEXT, clientSecret) : undefined;
        await putSignIn(tx, config.data, sealed);
        return signInView(api.ctx, tx, tenantId);
      });
    },
  },
  {
    // Customers go back to the console's own sign-in; their accounts, profiles, and grants stay.
    method: "DELETE",
    path: SIGN_IN,
    handle: (api, [tenant]) =>
      teamResponse(api, tenant!, "admin", async (tx, tenantId) => {
        await deleteSignIn(tx);
        return signInView(api.ctx, tx, tenantId);
      }),
  },
];

async function signInView(ctx: ConsoleContext, tx: TenantTx, tenantId: TenantId): Promise<Response> {
  const stored = await getSignIn(tx);
  return json(200, {
    settings: stored ? (stored.config satisfies SignInSettings) : null,
    secretSet: stored?.secret !== undefined,
    callbackUrl: tenantCallbackUrl(ctx.base, tenantId),
  } satisfies SignInView);
}
