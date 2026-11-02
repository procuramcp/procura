// The curation console (D-033): browser sign-in, sessions, the JSON API under
// /app/api, and the built single-page app under /app. Editing is for tenant
// owners and admins; every tenant read and write runs inside the tenant (RLS).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { IdentityProvider } from "@cairnmcp/auth";
import {
  AccessProfile,
  canCall,
  defaultToolset,
  resolveToolset,
  SourceId,
  TenantId,
  ToolBinding,
  Toolset,
  ToolsetAccessLevel,
  ToolsetId,
  UserId,
  type Caller,
  type Operation,
} from "@cairnmcp/core";
import {
  addMember,
  deleteProfile,
  getSource,
  getToolset,
  listProfiles,
  listSources,
  listToolsets,
  memberProfileIds,
  memberRole,
  putProfile,
  putSource,
  putToolset,
  schema,
  setMemberProfiles,
  setToolsetAccess,
  type Database,
} from "@cairnmcp/db";
import { AdminError, mapSource, setCredential, summarize } from "./admin.ts";
import { discoverDocument, FetchRefused, MAX_DOCUMENT_FETCH_BYTES, safeGet, type DocumentGetter } from "./fetch-document.ts";
import type { Runtime } from "@cairnmcp/runtime";
import { CredentialInput, type Vault } from "@cairnmcp/vault";
import { and, eq, gt, lt } from "drizzle-orm";
import { z } from "zod";

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

const LOGIN_SECONDS = 10 * 60;
const SESSION_SECONDS = 8 * 60 * 60;
const MAX_BODY_BYTES = 256 * 1024;

const { consoleLogins: logins, consoleSessions: sessions, memberships, toolsetAccess } = schema;

type Session = { userId: UserId; label: string };
type Handler = (request: Request) => Promise<Response | undefined>;

export function createConsoleHandler(options: ConsoleOptions): Handler {
  const base = new URL(options.publicUrl).origin;
  const secure = base.startsWith("https://");
  const nowMs = options.now ?? Date.now;
  const at = (offsetSeconds = 0) => new Date(nowMs() + offsetSeconds * 1000);
  const providers = new Map(options.providers.map((p) => [p.id, p]));
  const { db } = options;
  // __Host- cookies need Secure, so plain-http development uses plain names.
  const SESSION_COOKIE = secure ? "__Host-cairnmcp_session" : "cairnmcp_session";
  const LOGIN_COOKIE = secure ? "__Host-cairnmcp_login" : "cairnmcp_login";
  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const callbackUri = (providerId: string) => `${base}/app/callback/${providerId}`;

  async function session(request: Request): Promise<Session | undefined> {
    const token = readCookie(request, SESSION_COOKIE);
    if (!token) return undefined;
    const [row] = await db.withoutTenant((tx) =>
      tx.select().from(sessions).where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, at()))),
    );
    return row ? { userId: UserId.parse(row.userId), label: row.userLabel } : undefined;
  }

  // --- Sign-in -------------------------------------------------------------------

  async function login(providerId: string): Promise<Response> {
    const provider = providers.get(providerId);
    if (!provider) return page(404, "Unknown sign-in provider");
    const state = random(32);
    const nonce = random(32);
    const verifier = random(32);
    const browser = random(32);
    await db.withoutTenant((tx) =>
      tx.insert(logins).values({ stateHash: sha256(state), provider: provider.id, nonce, verifier, browserHash: sha256(browser), expiresAt: at(LOGIN_SECONDS) }),
    );
    const location = await provider.authorizationUrl({ redirectUri: callbackUri(provider.id), state, nonce, codeVerifier: verifier });
    return redirect(location.toString(), { "set-cookie": cookie(LOGIN_COOKIE, browser, LOGIN_SECONDS) });
  }

  async function callback(request: Request, url: URL, providerId: string): Promise<Response> {
    const provider = providers.get(providerId);
    const state = url.searchParams.get("state") ?? "";
    if (!provider || !state) return page(400, "This sign-in has expired");
    // Single use: the row is gone whatever happens next.
    const [row] = await db.withoutTenant((tx) =>
      tx.delete(logins).where(and(eq(logins.stateHash, sha256(state)), gt(logins.expiresAt, at()))).returning(),
    );
    if (!row || row.provider !== provider.id) return page(400, "This sign-in has expired");
    const browser = readCookie(request, LOGIN_COOKIE);
    if (!browser || !equalHashes(sha256(browser), row.browserHash)) return page(400, "Sign-in has to finish in the same browser it started in");
    if (url.searchParams.has("error")) return redirect(`${base}/app/`, { "set-cookie": cookie(LOGIN_COOKIE, "", 0) });

    let identity;
    try {
      identity = await provider.finish({ callbackUrl: url, redirectUri: callbackUri(provider.id), expectedState: state, expectedNonce: row.nonce, codeVerifier: row.verifier });
    } catch {
      return page(502, `${provider.name} didn't confirm the sign-in`);
    }
    const userId = await db.ensureUser(identity.issuer, identity.subject);
    const token = random(32);
    await db.withoutTenant((tx) => tx.insert(sessions).values({ tokenHash: sha256(token), userId, userLabel: identity.label, expiresAt: at(SESSION_SECONDS) }));
    const headers = new Headers({ location: `${base}/app/`, "cache-control": "no-store" });
    headers.append("set-cookie", cookie(SESSION_COOKIE, token, SESSION_SECONDS));
    headers.append("set-cookie", cookie(LOGIN_COOKIE, "", 0));
    return new Response(null, { status: 302, headers });
  }

  async function logout(request: Request): Promise<Response> {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) await db.withoutTenant((tx) => tx.delete(sessions).where(eq(sessions.tokenHash, sha256(token))));
    return json(200, { ok: true }, { "set-cookie": cookie(SESSION_COOKIE, "", 0) });
  }

  // --- API -------------------------------------------------------------------------

  /** Run `fn` inside the tenant if the signed-in user may edit it (owner or admin). */
  async function asEditor<T>(user: Session, tenantInput: string, fn: (tx: TxOf<Database>, tenantId: TenantId) => Promise<T | Response>): Promise<T | Response> {
    const tenantId = TenantId.safeParse(tenantInput).data;
    if (!tenantId) return json(404, { error: "not_found" });
    return db.withTenant(tenantId, async (tx) => {
      const role = await memberRole(tx, user.userId);
      // Same answer for "no such tenant" and "not a member": nothing to probe.
      if (!role) return json(404, { error: "not_found" });
      if (role === "member") return json(403, { error: "forbidden", message: "only owners and admins can edit this tenant" });
      return fn(tx, tenantId);
    });
  }

  const endpointUrl = (tenantId: string, toolsetId: string) => `${base}/mcp/${tenantId}/${toolsetId}`;

  async function api(request: Request, path: string): Promise<Response> {
    const method = request.method;
    if (method !== "GET" && method !== "HEAD") {
      // CSRF: with SameSite=Lax cookies, a same-origin Origin and a JSON body together rule out other sites.
      if (request.headers.get("origin") !== base) return json(403, { error: "forbidden", message: "requests must come from the console itself" });
      if (method !== "DELETE" && !(request.headers.get("content-type") ?? "").startsWith("application/json")) return json(415, { error: "unsupported_media_type" });
    }
    const user = await session(request);
    const providerList = [...providers.values()].map((p) => ({ id: p.id, name: p.name, href: `/app/login/${p.id}` }));
    if (path === "/me" && method === "GET") {
      if (!user) return json(401, { error: "signed_out", providers: providerList });
      const tenants = await db.userTenants(user.userId);
      return json(200, { user: { id: user.userId, label: user.label }, tenants: tenants.map((t) => ({ id: t.tenantId, name: t.name, role: t.role })) });
    }
    if (!user) return json(401, { error: "signed_out", providers: providerList });
    if (path === "/logout" && method === "POST") return logout(request);

    let m: RegExpExecArray | null;
    if ((m = /^\/tenants\/([^/]+)$/.exec(path)) && method === "GET") {
      return result(
        await asEditor(user, m[1]!, async (tx, tenantId) => {
          const [tenant] = await tx.select().from(schema.tenants);
          const sources = await listSources(tx);
          const toolsets = await listToolsets(tx);
          const members = await tx.select({ userId: memberships.userId, role: memberships.role }).from(memberships);
          return {
            tenant: { id: tenantId, name: tenant?.name ?? tenantId },
            sources: sources.map((s) => ({ id: s.id, name: s.name, operations: s.ir.operations.length, reads: s.ir.operations.filter((o) => o.sideEffect.class === "read").length })),
            toolsets: toolsets.map((t) => ({ id: t.id, name: t.name, sourceId: t.sourceId, enabledTools: t.tools.filter((b) => b.enabled).length, endpoint: endpointUrl(tenantId, t.id) })),
            members: members.map((x) => ({ ...x, you: x.userId === user.userId })),
          };
        }),
      );
    }
    if ((m = /^\/tenants\/([^/]+)\/toolsets$/.exec(path)) && method === "POST") {
      const body = NewToolset.safeParse(await readJson(request));
      if (!body.success) return json(400, { error: "invalid_request", message: issuesText(body.error) });
      return result(
        await asEditor(user, m[1]!, async (tx, tenantId) => {
          if (await getToolset(tx, body.data.id)) return json(409, { error: "conflict", message: `a toolset ${body.data.id} already exists` });
          const source = await getSource(tx, body.data.sourceId);
          if (!source) return json(404, { error: "not_found", message: `no source ${body.data.sourceId}` });
          const toolset = defaultToolset(source.ir, { id: body.data.id, name: body.data.name });
          await putToolset(tx, toolset);
          // The creator can use it right away.
          await setToolsetAccess(tx, toolset.id, user.userId, "use");
          return json(201, { id: toolset.id, endpoint: endpointUrl(tenantId, toolset.id) });
        }),
      );
    }
    if ((m = /^\/tenants\/([^/]+)\/sources\/preview$/.exec(path)) && method === "POST") return previewRoute(request, user, m[1]!);
    if ((m = /^\/tenants\/([^/]+)\/sources$/.exec(path)) && method === "POST") return createSourceRoute(request, user, m[1]!);
    if ((m = /^\/tenants\/([^/]+)\/sources\/([^/]+)$/.exec(path)) && method === "GET") {
      const sourceId = m[2]!;
      return result(await asEditor(user, m[1]!, (tx, tenantId) => sourceView(tx, tenantId, sourceId)));
    }
    if ((m = /^\/tenants\/([^/]+)\/sources\/([^/]+)\/credentials\/([^/]+)$/.exec(path)) && (method === "PUT" || method === "DELETE")) {
      return credentialRoute(request, user, m[1]!, m[2]!, decodeURIComponent(m[3]!));
    }
    if ((m = /^\/tenants\/([^/]+)\/access$/.exec(path)) && method === "GET") {
      return result(await asEditor(user, m[1]!, (tx) => accessView(tx, user)));
    }
    if ((m = /^\/tenants\/([^/]+)\/profiles\/([^/]+)$/.exec(path)) && (method === "PUT" || method === "DELETE")) {
      return profileRoute(request, user, m[1]!, m[2]!);
    }
    if ((m = /^\/tenants\/([^/]+)\/members\/([^/]+)\/profiles$/.exec(path)) && method === "PUT") {
      return memberProfilesRoute(request, user, m[1]!, m[2]!);
    }
    const ts = /^\/tenants\/([^/]+)\/toolsets\/([^/]+)(\/access|\/test)?$/.exec(path);
    if (ts) {
      const [, tenantInput, toolsetInput, sub] = ts;
      const toolsetId = ToolsetId.safeParse(toolsetInput).data;
      if (!toolsetId) return json(404, { error: "not_found" });
      if (!sub && method === "GET") return result(await asEditor(user, tenantInput!, (tx, tenantId) => toolsetView(tx, tenantId, toolsetId)));
      if (!sub && method === "PUT") return putToolsetRoute(request, user, tenantInput!, toolsetId);
      if (sub === "/access" && method === "PUT") return accessRoute(request, user, tenantInput!, toolsetId);
      if (sub === "/test" && method === "POST") return testRoute(request, user, tenantInput!, toolsetId);
    }
    return json(404, { error: "not_found" });
  }

  async function toolsetView(tx: TxOf<Database>, tenantId: TenantId, toolsetId: ToolsetId): Promise<Response> {
    const toolset = await getToolset(tx, toolsetId);
    const source = toolset && (await getSource(tx, toolset.sourceId));
    if (!toolset || !source) return json(404, { error: "not_found", message: `no toolset ${toolsetId}` });
    const access = await tx.select({ userId: toolsetAccess.userId, level: toolsetAccess.level }).from(toolsetAccess).where(eq(toolsetAccess.toolsetId, toolsetId));
    const members = await tx.select({ userId: memberships.userId, role: memberships.role }).from(memberships);
    const resolved = resolveToolset(toolset, source.ir);
    const profiles = (await listProfiles(tx)).flatMap((p) =>
      p.rules.filter((r) => r.toolsetId === toolsetId).map((r) => ({ profileId: p.id, name: p.name, level: r.level, operations: r.operations, members: p.members })),
    );
    return json(200, {
      toolset,
      profiles,
      endpoint: endpointUrl(tenantId, toolsetId),
      source: { id: source.id, name: source.name, baseUrl: source.ir.source.baseUrl },
      operations: source.ir.operations.map(operationView),
      access,
      members,
      issues: resolved.ok ? [] : resolved.issues,
    });
  }

  async function putToolsetRoute(request: Request, user: Session, tenantInput: string, toolsetId: ToolsetId): Promise<Response> {
    const body = ToolsetEdit.safeParse(await readJson(request));
    if (!body.success) return json(400, { error: "invalid_request", message: issuesText(body.error) });
    return result(
      await asEditor(user, tenantInput, async (tx, tenantId) => {
        const existing = await getToolset(tx, toolsetId);
        const source = existing && (await getSource(tx, existing.sourceId));
        if (!existing || !source) return json(404, { error: "not_found", message: `no toolset ${toolsetId}` });
        const parsed = Toolset.safeParse({ ...body.data, id: toolsetId, sourceId: existing.sourceId });
        if (!parsed.success) return json(422, { error: "invalid_toolset", issues: parsed.error.issues.map((i) => ({ toolName: toolNameAt(body.data, i.path), message: i.message })) });
        const resolved = resolveToolset(parsed.data, source.ir);
        if (!resolved.ok) return json(422, { error: "invalid_toolset", issues: resolved.issues });
        await putToolset(tx, parsed.data);
        return toolsetView(tx, tenantId, toolsetId);
      }),
    );
  }

  async function accessRoute(request: Request, user: Session, tenantInput: string, toolsetId: ToolsetId): Promise<Response> {
    const body = AccessEdit.safeParse(await readJson(request));
    if (!body.success) return json(400, { error: "invalid_request", message: issuesText(body.error) });
    return result(
      await asEditor(user, tenantInput, async (tx, tenantId) => {
        if (!(await getToolset(tx, toolsetId))) return json(404, { error: "not_found", message: `no toolset ${toolsetId}` });
        if (body.data.level !== "none" && !(await memberRole(tx, body.data.userId))) {
          // Only someone who has signed in once exists as a user.
          try {
            await addMember(tx, body.data.userId, "member");
          } catch (e) {
            if (pgCode(e) === "23503") return json(404, { error: "no_such_user", message: "no account with that id: they need to sign in once first (the No access page shows their account id)" });
            throw e;
          }
        }
        await setToolsetAccess(tx, toolsetId, body.data.userId, body.data.level === "none" ? undefined : body.data.level);
        return toolsetView(tx, tenantId, toolsetId);
      }),
    );
  }

  /** Profiles, who holds them, and what they can point at (D-034). */
  async function accessView(tx: TxOf<Database>, user: Session): Promise<Response> {
    const profiles = await listProfiles(tx);
    const members = await tx.select({ userId: memberships.userId, role: memberships.role }).from(memberships);
    const held = await memberProfileIds(tx);
    const toolsets = await listToolsets(tx);
    const sourcesById = new Map((await listSources(tx)).map((s) => [s.id as string, s]));
    return json(200, {
      profiles,
      members: members.map((m) => ({ ...m, you: m.userId === user.userId, profiles: held.get(UserId.parse(m.userId)) ?? [] })),
      toolsets: toolsets.map((t) => {
        const ops = new Map(sourcesById.get(t.sourceId)?.ir.operations.map((o) => [o.id as string, o]) ?? []);
        return {
          id: t.id,
          name: t.name,
          tools: t.tools.map((b) => ({ operationId: b.operationId, name: b.name, enabled: b.enabled, sideEffect: ops.get(b.operationId)?.sideEffect.class ?? "destructive" })),
        };
      }),
    });
  }

  async function profileRoute(request: Request, user: Session, tenantInput: string, profileInput: string): Promise<Response> {
    const body = request.method === "PUT" ? ProfileEdit.safeParse(await readJson(request)) : undefined;
    if (body && !body.success) return json(400, { error: "invalid_request", message: issuesText(body.error) });
    return result(
      await asEditor(user, tenantInput, async (tx) => {
        if (request.method === "DELETE") {
          if (!(await deleteProfile(tx, profileInput))) return json(404, { error: "not_found", message: `no profile ${profileInput}` });
          return accessView(tx, user);
        }
        const { description, ...rest } = body!.data;
        const parsed = AccessProfile.safeParse({ ...rest, ...(description?.trim() ? { description } : {}), id: profileInput });
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
        return accessView(tx, user);
      }),
    );
  }

  async function memberProfilesRoute(request: Request, user: Session, tenantInput: string, userInput: string): Promise<Response> {
    const body = MemberProfiles.safeParse(await readJson(request));
    const userId = UserId.safeParse(userInput).data;
    if (!body.success || !userId) return json(400, { error: "invalid_request", message: body.success ? "invalid account id" : issuesText(body.error) });
    return result(
      await asEditor(user, tenantInput, async (tx) => {
        try {
          // Giving someone a profile makes them a member, like a direct grant does (they must have signed in once).
          if (!(await memberRole(tx, userId))) {
            if (body.data.profiles.length === 0) return json(404, { error: "not_found", message: "that account isn't a member of this tenant" });
            await addMember(tx, userId, "member");
          }
          await setMemberProfiles(tx, userId, body.data.profiles);
        } catch (e) {
          if (pgCode(e) === "23503") return json(404, { error: "not_found", message: "no such account (they need to sign in once first) or no such profile" });
          throw e;
        }
        return accessView(tx, user);
      }),
    );
  }

  // --- Sources (D-035) ---------------------------------------------------------------

  const getDocument = options.getDocument ?? safeGet;

  /** The document text from a URL (found by discovery) or pasted directly. */
  async function loadDocument(input: { url?: string | undefined; document?: string | undefined }): Promise<{ text: string; documentUrl?: string; via: string }> {
    if (input.document) return { text: input.document, via: "pasted or uploaded" };
    if (!input.url) throw new FetchRefused("give a URL or the document itself");
    const found = await discoverDocument(input.url, getDocument);
    return { text: found.text, documentUrl: found.documentUrl, via: found.via };
  }

  function previewOf(mapped: ReturnType<typeof mapSource>) {
    const { ir } = mapped;
    const count = (c: string) => ir.operations.filter((o) => o.sideEffect.class === c).length;
    return {
      suggestedId: ir.source.id,
      name: ir.source.name,
      ...(ir.source.description ? { description: ir.source.description.slice(0, 500) } : {}),
      baseUrl: ir.source.baseUrl,
      operations: { total: ir.operations.length, read: count("read"), write: count("write"), destructive: count("destructive") },
      authSchemes: ir.source.authSchemes.map(schemeView),
      warnings: mapped.warnings.slice(0, 50),
      warningCount: mapped.warnings.length,
    };
  }

  async function previewRoute(request: Request, user: Session, tenantInput: string): Promise<Response> {
    const body = SourcePreviewInput.safeParse(await readJson(request, MAX_DOCUMENT_BODY_BYTES));
    if (!body.success) return json(400, { error: "invalid_request", message: issuesText(body.error) });
    const taken = await asEditor(user, tenantInput, async (tx) => (await listSources(tx)).map((s) => s.id as string));
    if (taken instanceof Response) return taken;
    try {
      const doc = await loadDocument(body.data);
      const provisionalId = body.data.id ?? slugFromText(titleOf(doc.text)) ?? "api";
      const mapped = mapSource({ sourceId: provisionalId, openapi: doc.text, ...(doc.documentUrl ? { documentUrl: doc.documentUrl } : {}), ...(body.data.baseUrl ? { baseUrl: body.data.baseUrl } : {}) });
      return json(200, { documentUrl: doc.documentUrl ?? null, via: doc.via, preview: previewOf(mapped), takenIds: taken });
    } catch (e) {
      return sourceProblem(e);
    }
  }

  async function createSourceRoute(request: Request, user: Session, tenantInput: string): Promise<Response> {
    const body = SourceInput.safeParse(await readJson(request, MAX_DOCUMENT_BODY_BYTES));
    if (!body.success) return json(400, { error: "invalid_request", message: issuesText(body.error) });
    // Check the tenant and the id before fetching anything.
    const exists = await asEditor(user, tenantInput, async (tx) => (await getSource(tx, body.data.id)) !== undefined);
    if (exists instanceof Response) return exists;
    if (exists) return json(409, { error: "conflict", message: `a source ${body.data.id} already exists (updating a source comes later)` });
    let mapped;
    try {
      const doc = await loadDocument(body.data);
      mapped = mapSource({
        sourceId: body.data.id,
        openapi: doc.text,
        ...(doc.documentUrl ? { documentUrl: doc.documentUrl } : {}),
        ...(body.data.baseUrl ? { baseUrl: body.data.baseUrl } : {}),
        fixedUsernames: body.data.fixedUsernames,
      });
    } catch (e) {
      return sourceProblem(e);
    }
    const toolset = body.data.toolset;
    return result(
      await asEditor(user, tenantInput, async (tx, tenantId) => {
        // Check everything before writing anything, so a refusal leaves nothing half-added.
        if (await getSource(tx, mapped.ir.source.id)) return json(409, { error: "conflict", message: `a source ${mapped.ir.source.id} already exists` });
        if (toolset && (await getToolset(tx, toolset.id))) return json(409, { error: "conflict", message: `a toolset ${toolset.id} already exists; pick another name` });
        await putSource(tx, mapped.ir);
        if (toolset) {
          await putToolset(tx, defaultToolset(mapped.ir, { id: toolset.id, name: toolset.name }));
          await setToolsetAccess(tx, toolset.id, user.userId, "use");
        }
        return json(201, { source: summarize(mapped), ...(toolset ? { toolset: { id: toolset.id, endpoint: endpointUrl(tenantId, toolset.id) } } : {}) });
      }),
    );
  }

  async function sourceView(tx: TxOf<Database>, tenantId: TenantId, sourceId: string): Promise<Response> {
    const source = await getSource(tx, sourceId);
    if (!source) return json(404, { error: "not_found", message: `no source ${sourceId}` });
    const credentials = await options.vault.listCredentials(tenantId, source.id);
    const count = (c: string) => source.ir.operations.filter((o) => o.sideEffect.class === c).length;
    const toolsets = (await listToolsets(tx)).filter((t) => t.sourceId === source.id).map((t) => ({ id: t.id, name: t.name }));
    return json(200, {
      id: source.id,
      name: source.name,
      baseUrl: source.ir.source.baseUrl,
      documentUrl: source.ir.source.derivation.documentUrl ?? null,
      operations: { total: source.ir.operations.length, read: count("read"), write: count("write"), destructive: count("destructive") },
      authSchemes: source.ir.source.authSchemes.map((scheme) => ({
        ...schemeView(scheme),
        // Which kinds of credential fit, and whether one is stored. Never the value.
        accepts: credentialKinds(scheme.type),
        stored: credentials.filter((c) => c.schemeId === scheme.id).map((c) => ({ kind: c.kind })),
      })),
      toolsets,
    });
  }

  async function credentialRoute(request: Request, user: Session, tenantInput: string, sourceId: string, schemeId: string): Promise<Response> {
    const body = request.method === "PUT" ? CredentialBody.safeParse(await readJson(request)) : undefined;
    if (body && !body.success) return json(400, { error: "invalid_request", message: "expected { credential: { kind, ... } }" });
    const loaded = await asEditor(user, tenantInput, async (tx, tenantId) => {
      const source = await getSource(tx, sourceId);
      const scheme = source?.ir.source.authSchemes.find((s) => s.id === schemeId);
      if (!source || !scheme) return json(404, { error: "not_found", message: `no auth scheme ${schemeId} on source ${sourceId}` });
      return { tenantId, scheme };
    });
    if (loaded instanceof Response) return loaded;
    if (body) {
      const credential = body.data!.credential;
      if (!credentialKinds(loaded.scheme.type).includes(credential.kind)) {
        return json(422, { error: "wrong_kind", message: `${schemeId} takes ${credentialKinds(loaded.scheme.type).join(" or ")}, not ${credential.kind}` });
      }
      await setCredential(options.vault, { tenantId: loaded.tenantId, sourceId, schemeId, credential });
    } else {
      for (const c of await options.vault.listCredentials(loaded.tenantId, sourceId)) {
        if (c.schemeId === schemeId) await options.vault.deleteCredential(loaded.tenantId, c.id);
      }
    }
    return result(await asEditor(user, tenantInput, (tx, tenantId) => sourceView(tx, tenantId, sourceId)));
  }

  async function testRoute(request: Request, user: Session, tenantInput: string, toolsetId: ToolsetId): Promise<Response> {
    const body = ToolTest.safeParse(await readJson(request));
    if (!body.success) return json(400, { error: "invalid_request", message: issuesText(body.error) });
    const loaded = await asEditor(user, tenantInput, async (tx, tenantId) => {
      const toolset = await getToolset(tx, toolsetId);
      const source = toolset && (await getSource(tx, toolset.sourceId));
      if (!toolset || !source) return json(404, { error: "not_found", message: `no toolset ${toolsetId}` });
      return { tenantId, toolset, ir: source.ir };
    });
    if (loaded instanceof Response) return loaded;
    // The tool as edited, saved or not, resolved like the MCP endpoint would.
    const single = Toolset.safeParse({ id: loaded.toolset.id, sourceId: loaded.toolset.sourceId, name: loaded.toolset.name, tools: [{ ...body.data.tool, enabled: true }] });
    if (!single.success) return json(422, { error: "invalid_toolset", issues: single.error.issues.map((i) => ({ toolName: body.data.tool.name, message: i.message })) });
    const resolved = resolveToolset(single.data, loaded.ir);
    if (!resolved.ok) return json(422, { error: "invalid_toolset", issues: resolved.issues });
    const tool = resolved.tools[0]!;
    const effect = tool.operation.sideEffect.class;
    if (!canCall("use", effect) && !body.data.confirm) {
      return json(409, { error: "confirm_required", message: `${tool.name} is a ${effect} tool: running it changes data in ${loaded.ir.source.name}` });
    }
    const caller: Caller = { userId: user.userId, claims: { console: true } };
    const outcome = await options.runtime.invoke({ tenantId: loaded.tenantId, caller, source: loaded.ir.source, tool, args: body.data.args });
    return json(200, { tool: { name: tool.name, sideEffect: effect, pinnedInputs: tool.pinnedInputs }, args: body.data.args, result: outcome });
  }

  // --- Static files ------------------------------------------------------------------

  const staticRoot = options.staticDir ? resolve(options.staticDir) : undefined;

  async function staticFile(path: string): Promise<Response> {
    if (!staticRoot) return page(404, "The console isn't built. Run: pnpm --filter @cairnmcp/web build");
    let decoded;
    try {
      decoded = decodeURIComponent(path.replace(/^\/app\/?/, ""));
    } catch {
      return page(404, "Not found"); // malformed %-encoding
    }
    const relative = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
    let file = join(staticRoot, relative);
    if (!file.startsWith(staticRoot + sep) && file !== staticRoot) return page(404, "Not found");
    const isFile = await stat(file).then((s) => s.isFile(), () => false);
    // Client-side routes get the app shell; missing assets get a 404.
    if (!isFile) {
      if (relative.startsWith("assets")) return page(404, "Not found");
      file = join(staticRoot, "index.html");
    }
    let content;
    try {
      content = await readFile(file);
    } catch {
      return page(404, "The console isn't built. Run: pnpm --filter @cairnmcp/web build");
    }
    const hashed = file.includes(`${sep}assets${sep}`);
    return new Response(new Uint8Array(content), {
      status: 200,
      headers: { ...APP_HEADERS, "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-store" },
    });
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
    const loginMatch = /^\/app\/login\/([a-z0-9-]+)$/.exec(path);
    if (loginMatch && request.method === "GET") return login(loginMatch[1]!);
    const callbackMatch = /^\/app\/callback\/([a-z0-9-]+)$/.exec(path);
    if (callbackMatch && request.method === "GET") return callback(request, url, callbackMatch[1]!);
    if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method_not_allowed" });
    return staticFile(path);
  };
}

/** Delete finished or expired console sign-ins and sessions. */
export async function purgeExpiredConsoleState(db: Database, now = new Date()): Promise<void> {
  await db.withoutTenant(async (tx) => {
    await tx.delete(logins).where(lt(logins.expiresAt, now));
    await tx.delete(sessions).where(lt(sessions.expiresAt, now));
  });
}

// --- Request bodies -----------------------------------------------------------------

const NewToolset = z.object({ id: ToolsetId, sourceId: SourceId, name: z.string().min(1).max(200) });
const ToolsetEdit = z.object({ name: z.string().min(1).max(200), description: z.string().max(4000).optional(), tools: z.array(z.unknown()).max(2000) });
const AccessEdit = z.object({ userId: UserId, level: z.union([ToolsetAccessLevel, z.literal("none")]) });
const ProfileEdit = z.object({ name: z.string(), description: z.string().optional(), rules: z.array(z.unknown()).max(200) });
const MemberProfiles = z.object({ profiles: z.array(z.string().max(64)).max(100) });
const MAX_DOCUMENT_BODY_BYTES = MAX_DOCUMENT_FETCH_BYTES + 64 * 1024;
const SourceFields = z.object({
  id: SourceId,
  url: z.string().max(2000).optional(),
  document: z.string().max(MAX_DOCUMENT_FETCH_BYTES).optional(),
  baseUrl: z.string().max(2000).optional(),
  fixedUsernames: z.record(z.string(), z.string().max(200)).default({}),
  toolset: z.object({ id: ToolsetId, name: z.string().trim().min(1).max(200) }).optional(),
});
const oneDocument = (b: { url?: string | undefined; document?: string | undefined }) => Boolean(b.url) !== Boolean(b.document);
const ONE_DOCUMENT = { message: "give either a URL or the document, not both" };
const SourceInput = SourceFields.refine(oneDocument, ONE_DOCUMENT);
const SourcePreviewInput = SourceFields.partial({ id: true }).refine(oneDocument, ONE_DOCUMENT);
const CredentialBody = z.object({ credential: CredentialInput });
const ToolTest = z.object({ tool: ToolBinding, args: z.record(z.string(), z.unknown()).default({}), confirm: z.boolean().optional() });

type SchemeLike = { id: string; type: string; description?: string | undefined; fixedUsername?: string | undefined; in?: string; name?: string };
function schemeView(scheme: SchemeLike) {
  return {
    id: scheme.id,
    type: scheme.type,
    ...(scheme.description ? { description: scheme.description.slice(0, 500) } : {}),
    ...(scheme.fixedUsername ? { fixedUsername: scheme.fixedUsername } : {}),
    ...(scheme.in ? { in: scheme.in, name: scheme.name } : {}),
  };
}

/** Credential kinds the vault can store for an auth scheme type. */
function credentialKinds(type: string): Array<CredentialInput["kind"]> {
  switch (type) {
    case "http_basic":
      return ["basic"];
    case "http_bearer":
      return ["bearer"];
    case "api_key":
      return ["api_key"];
    case "oauth2":
    case "oidc":
      return ["oauth2", "bearer"];
    default:
      return [];
  }
}

function titleOf(text: string): string {
  const json = /"title"\s*:\s*"([^"]{1,200})"/.exec(text);
  const yaml = /^\s{2}title:\s*['"]?([^'"\n]{1,200})/m.exec(text);
  return json?.[1] ?? yaml?.[1] ?? "";
}

function slugFromText(text: string): string | undefined {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  return slug || undefined;
}

/** A refused fetch or a document that didn't map: the person can fix these, so say what happened. */
function sourceProblem(e: unknown): Response {
  if (e instanceof FetchRefused) return json(422, { error: "fetch_refused", message: e.message });
  if (e instanceof AdminError) return json(422, { error: "invalid_document", message: e.message });
  throw e;
}

function operationView(op: Operation) {
  const props = (op.input.properties ?? {}) as Record<string, { type?: unknown; description?: string }>;
  const required = new Set((op.input.required as string[] | undefined) ?? []);
  return {
    id: op.id,
    title: op.title,
    description: op.description,
    method: op.mapping.method,
    path: op.mapping.pathTemplate,
    tags: op.tags,
    deprecated: op.deprecated,
    sideEffect: op.sideEffect,
    inputs: Object.entries(props).map(([name, schema]) => ({ name, type: typeof schema.type === "string" ? schema.type : "any", description: schema.description ?? "", required: required.has(name) })),
    inputSchema: op.input,
  };
}

function toolNameAt(body: { tools: unknown[] }, path: PropertyKey[]): string {
  if (path[0] === "tools" && typeof path[1] === "number") {
    const tool = body.tools[path[1]] as { name?: unknown } | undefined;
    return typeof tool?.name === "string" ? tool.name : `tool ${path[1] + 1}`;
  }
  return "toolset";
}

function issuesText(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

// --- Helpers -------------------------------------------------------------------------

type TxOf<D extends Database> = Parameters<Parameters<D["withTenant"]>[1]>[0];

class BodyError extends Error {}

async function readJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  // Refuse a declared oversize body before reading it.
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new BodyError("request body is too large");
  const text = await request.text();
  if (Buffer.byteLength(text) > maxBytes) throw new BodyError("request body is too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new BodyError("request body must be JSON");
  }
}

function result(value: unknown): Response {
  return value instanceof Response ? value : json(200, value);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers } });
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", ...headers } });
}

function page(status: number, message: string): Response {
  const escaped = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(`<!doctype html><meta charset="utf-8"><title>cairnmcp</title><p>${escaped}. <a href="/app/">Back to the console</a></p>`, {
    status,
    headers: { ...APP_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const APP_HEADERS: Record<string, string> = {
  // Scripts only from this origin. Inline styles are allowed: Radix and the code view set them.
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || undefined;
  }
  return undefined;
}

function random(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function equalHashes(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function pgCode(e: unknown): string | undefined {
  for (let c: unknown = e; c && typeof c === "object"; c = (c as { cause?: unknown }).cause) {
    const code = (c as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}
