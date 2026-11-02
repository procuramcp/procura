// Console sign-in through an OIDC provider, and the session cookie it sets.
// Login state and sessions are stored only as hashes (base64url SHA-256).
import type { LoggedOut } from "@cairnmcp/console-api";
import { finishSignIn, startSignIn, type IdentityProvider } from "@cairnmcp/auth";
import { UserId } from "@cairnmcp/core";
import { schema, type Database } from "@cairnmcp/db";
import { json, randomToken, readCookie, redirect, safeEqual, setCookie, sha256Base64url as sha256 } from "@cairnmcp/http";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Session } from "./context.ts";
import { page } from "./static.ts";

const LOGIN_SECONDS = 10 * 60;
const SESSION_SECONDS = 8 * 60 * 60;

const { consoleLogins: logins, consoleSessions: sessions } = schema;

export type SignInOptions = { db: Database; base: string; providers: IdentityProvider[]; now: () => number };

export function signIn({ db, base, providers: list, now }: SignInOptions) {
  const providers = new Map(list.map((p) => [p.id, p]));
  const secure = base.startsWith("https://");
  const at = (offsetSeconds = 0) => new Date(now() + offsetSeconds * 1000);
  // __Host- cookies need Secure, so plain-http development uses plain names.
  const SESSION_COOKIE = secure ? "__Host-cairnmcp_session" : "cairnmcp_session";
  const LOGIN_COOKIE = secure ? "__Host-cairnmcp_login" : "cairnmcp_login";
  const cookie = (name: string, value: string, maxAgeSeconds: number) => setCookie(name, value, { path: "/", maxAgeSeconds, secure });
  const callbackUri = (providerId: string) => `${base}/app/callback/${providerId}`;

  return {
    /** Where the console's sign-in buttons point. */
    providerList: [...providers.values()].map((p) => ({ id: p.id, name: p.name, href: `/app/login/${p.id}` })),

    /** The signed-in user, from the session cookie. */
    async session(request: Request): Promise<Session | undefined> {
      const token = readCookie(request, SESSION_COOKIE);
      if (!token) return undefined;
      const [row] = await db.withoutTenant((tx) => tx.select().from(sessions).where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, at()))));
      return row ? { userId: UserId.parse(row.userId), label: row.userLabel } : undefined;
    },

    async login(providerId: string): Promise<Response> {
      const provider = providers.get(providerId);
      if (!provider) return page(404, "Unknown sign-in provider");
      const { location, secrets } = await startSignIn(provider, callbackUri(provider.id));
      const { state, nonce, verifier, browser } = secrets;
      await db.withoutTenant((tx) =>
        tx.insert(logins).values({ stateHash: sha256(state), provider: provider.id, nonce, verifier, browserHash: sha256(browser), expiresAt: at(LOGIN_SECONDS) }),
      );
      return redirect(location.toString(), { "set-cookie": cookie(LOGIN_COOKIE, browser, LOGIN_SECONDS) });
    },

    async callback(request: Request, url: URL, providerId: string): Promise<Response> {
      const provider = providers.get(providerId);
      const state = url.searchParams.get("state") ?? "";
      if (!provider || !state) return page(400, "This sign-in has expired");
      // Single use: the row is gone whatever happens next.
      const [row] = await db.withoutTenant((tx) => tx.delete(logins).where(and(eq(logins.stateHash, sha256(state)), gt(logins.expiresAt, at()))).returning());
      if (!row || row.provider !== provider.id) return page(400, "This sign-in has expired");
      const browser = readCookie(request, LOGIN_COOKIE);
      if (!browser || !safeEqual(sha256(browser), row.browserHash)) return page(400, "Sign-in has to finish in the same browser it started in");
      if (url.searchParams.has("error")) return redirect(`${base}/app/`, { "set-cookie": cookie(LOGIN_COOKIE, "", 0) });

      const identity = await finishSignIn(provider, { callbackUrl: url, redirectUri: callbackUri(provider.id), state, nonce: row.nonce, verifier: row.verifier });
      if (!identity) return page(502, `${provider.name} didn't confirm the sign-in`);
      const userId = await db.ensureUser(identity.issuer, identity.subject, identity.label);
      const token = randomToken(32);
      await db.withoutTenant((tx) => tx.insert(sessions).values({ tokenHash: sha256(token), userId, userLabel: identity.label, expiresAt: at(SESSION_SECONDS) }));
      const headers = new Headers({ location: `${base}/app/`, "cache-control": "no-store" });
      headers.append("set-cookie", cookie(SESSION_COOKIE, token, SESSION_SECONDS));
      headers.append("set-cookie", cookie(LOGIN_COOKIE, "", 0));
      return new Response(null, { status: 302, headers });
    },

    async logout(request: Request): Promise<Response> {
      const token = readCookie(request, SESSION_COOKIE);
      if (token) await db.withoutTenant((tx) => tx.delete(sessions).where(eq(sessions.tokenHash, sha256(token))));
      return json(200, { ok: true } satisfies LoggedOut, { "set-cookie": cookie(SESSION_COOKIE, "", 0) });
    },
  };
}

/** Delete finished or expired console sign-ins and sessions. */
export async function purgeExpiredConsoleState(db: Database, now = new Date()): Promise<void> {
  await db.withoutTenant(async (tx) => {
    await tx.delete(logins).where(lt(logins.expiresAt, now));
    await tx.delete(sessions).where(lt(sessions.expiresAt, now));
  });
}
