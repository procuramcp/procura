// Adding an API (D-035): find its description, preview, add it with a starter
// toolset, view it, and set or remove its credentials.
import type { CreatedSource, SourcePreview, SourceView } from "@cairnmcp/console-api";
import { countBySideEffect, defaultToolset, slugify, type TenantId } from "@cairnmcp/core";
import { getSource, getToolset, listSourceIds, listToolsets, putSource, putToolset, setToolsetAccess, type TenantTx } from "@cairnmcp/db";
import { json } from "@cairnmcp/http";
import { credentialKindsFor } from "@cairnmcp/vault";
import { AdminError, mapSource, summarize, type MappedSource } from "../admin.ts";
import { discoverDocument, FetchRefused } from "../fetch-document.ts";
import { CredentialBody, issuesText, MAX_DOCUMENT_BODY_BYTES, readBody, SourceInput, SourcePreviewInput } from "./bodies.ts";
import { asTeam, endpointUrl, teamResponse, type ApiRoute, type ConsoleContext } from "./context.ts";
import { schemeView } from "./views.ts";

export const sourceRoutes: ApiRoute[] = [
  {
    method: "POST",
    path: /^\/tenants\/([^/]+)\/sources\/preview$/,
    handle: async (api, [tenant]) => {
      const body = await readBody(api.request, SourcePreviewInput, MAX_DOCUMENT_BODY_BYTES);
      if (!body.success) return json(400, { error: "invalid_request", message: issuesText(body.error) });
      const taken = await asTeam(api, tenant!, "editor", (tx) => listSourceIds(tx));
      if (taken instanceof Response) return taken;
      try {
        const doc = await loadDocument(api.ctx, body.data);
        const provisionalId = body.data.id ?? slugify(titleOf(doc.text)) ?? "api";
        const mapped = mapSource({ sourceId: provisionalId, openapi: doc.text, ...documentOptions(doc, body.data) });
        return json(200, { documentUrl: doc.documentUrl ?? null, via: doc.via, preview: previewOf(mapped), takenIds: taken } satisfies SourcePreview);
      } catch (e) {
        return sourceProblem(e);
      }
    },
  },
  {
    method: "POST",
    path: /^\/tenants\/([^/]+)\/sources$/,
    handle: async (api, [tenant]) => {
      const body = await readBody(api.request, SourceInput, MAX_DOCUMENT_BODY_BYTES);
      if (!body.success) return json(400, { error: "invalid_request", message: issuesText(body.error) });
      // Check the tenant and the id before fetching anything.
      const exists = await asTeam(api, tenant!, "editor", async (tx) => (await getSource(tx, body.data.id)) !== undefined);
      if (exists instanceof Response) return exists;
      if (exists) return json(409, { error: "conflict", message: `a source ${body.data.id} already exists (updating a source comes later)` });
      let mapped: MappedSource;
      try {
        const doc = await loadDocument(api.ctx, body.data);
        mapped = mapSource({ sourceId: body.data.id, openapi: doc.text, ...documentOptions(doc, body.data), fixedUsernames: body.data.fixedUsernames });
      } catch (e) {
        return sourceProblem(e);
      }
      const toolset = body.data.toolset;
      return teamResponse(api, tenant!, "editor", async (tx, tenantId) => {
        // Check everything before writing anything, so a refusal leaves nothing half-added.
        if (await getSource(tx, mapped.ir.source.id)) return json(409, { error: "conflict", message: `a source ${mapped.ir.source.id} already exists` });
        if (toolset && (await getToolset(tx, toolset.id))) return json(409, { error: "conflict", message: `a toolset ${toolset.id} already exists; pick another name` });
        await putSource(tx, mapped.ir);
        if (toolset) {
          await putToolset(tx, defaultToolset(mapped.ir, { id: toolset.id, name: toolset.name }));
          await setToolsetAccess(tx, toolset.id, api.user.userId, "use");
        }
        return json(201, { source: summarize(mapped), ...(toolset ? { toolset: { id: toolset.id, endpoint: endpointUrl(api.ctx, tenantId, toolset.id) } } : {}) } satisfies CreatedSource);
      });
    },
  },
  {
    method: "GET",
    path: /^\/tenants\/([^/]+)\/sources\/([^/]+)$/,
    handle: (api, [tenant, sourceId]) => teamResponse(api, tenant!, "viewer", (tx, tenantId) => sourceView(api.ctx, tx, tenantId, sourceId!)),
  },
  {
    method: ["PUT", "DELETE"],
    path: /^\/tenants\/([^/]+)\/sources\/([^/]+)\/credentials\/([^/]+)$/,
    handle: async (api, [tenant, sourceId, schemeInput]) => {
      const schemeId = decodeURIComponent(schemeInput!);
      const body = api.request.method === "PUT" ? await readBody(api.request, CredentialBody) : undefined;
      if (body && !body.success) return json(400, { error: "invalid_request", message: "expected { credential: { kind, ... } }" });
      // Keys: admins and owners only (D-038).
      const loaded = await asTeam(api, tenant!, "admin", async (tx, tenantId) => {
        const source = await getSource(tx, sourceId!);
        const scheme = source?.ir.source.authSchemes.find((s) => s.id === schemeId);
        if (!source || !scheme) return json(404, { error: "not_found", message: `no auth scheme ${schemeId} on source ${sourceId}` });
        return { tenantId, scheme };
      });
      if (loaded instanceof Response) return loaded;
      const { vault } = api.ctx;
      if (body) {
        const credential = body.data!.credential;
        const accepts = credentialKindsFor(loaded.scheme.type);
        if (!accepts.includes(credential.kind)) {
          return json(422, { error: "wrong_kind", message: `${schemeId} takes ${accepts.join(" or ")}, not ${credential.kind}` });
        }
        await vault.replaceCredential({ tenantId: loaded.tenantId, sourceId: sourceId!, schemeId, credential });
      } else {
        await vault.deleteSchemeCredentials(loaded.tenantId, sourceId!, schemeId);
      }
      return teamResponse(api, tenant!, "admin", (tx, tenantId) => sourceView(api.ctx, tx, tenantId, sourceId!));
    },
  },
];

async function sourceView(ctx: ConsoleContext, tx: TenantTx, tenantId: TenantId, sourceId: string): Promise<Response> {
  const source = await getSource(tx, sourceId);
  if (!source) return json(404, { error: "not_found", message: `no source ${sourceId}` });
  const credentials = await ctx.vault.listCredentials(tenantId, source.id);
  const toolsets = (await listToolsets(tx)).filter((t) => t.sourceId === source.id).map((t) => ({ id: t.id, name: t.name }));
  return json(200, {
    id: source.id,
    name: source.name,
    baseUrl: source.ir.source.baseUrl,
    documentUrl: source.ir.source.derivation.documentUrl ?? null,
    operations: countBySideEffect(source.ir.operations),
    authSchemes: source.ir.source.authSchemes.map((scheme) => ({
      ...schemeView(scheme),
      // Which kinds of credential fit, and whether one is stored. Never the value.
      accepts: credentialKindsFor(scheme.type),
      stored: credentials.filter((c) => c.schemeId === scheme.id).map((c) => ({ kind: c.kind })),
    })),
    toolsets,
  } satisfies SourceView);
}

type LoadedDocument = { text: string; documentUrl?: string; via: string };

/** The document text from a URL (found by discovery) or pasted directly. */
async function loadDocument(ctx: ConsoleContext, input: { url?: string | undefined; document?: string | undefined }): Promise<LoadedDocument> {
  if (input.document) return { text: input.document, via: "pasted or uploaded" };
  if (!input.url) throw new FetchRefused("give a URL or the document itself");
  const found = await discoverDocument(input.url, ctx.getDocument);
  return { text: found.text, documentUrl: found.documentUrl, via: found.via };
}

function documentOptions(doc: LoadedDocument, body: { baseUrl?: string | undefined }) {
  return { ...(doc.documentUrl ? { documentUrl: doc.documentUrl } : {}), ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}) };
}

function previewOf(mapped: MappedSource): SourcePreview["preview"] {
  const { ir } = mapped;
  return {
    suggestedId: ir.source.id,
    name: ir.source.name,
    ...(ir.source.description ? { description: ir.source.description.slice(0, 500) } : {}),
    baseUrl: ir.source.baseUrl,
    operations: countBySideEffect(ir.operations),
    authSchemes: ir.source.authSchemes.map(schemeView),
    warnings: mapped.warnings.slice(0, 50),
    warningCount: mapped.warnings.length,
  };
}

/** The API's title, read cheaply from the raw text (for a suggested id before mapping). */
function titleOf(text: string): string {
  const json = /"title"\s*:\s*"([^"]{1,200})"/.exec(text);
  const yaml = /^\s{2}title:\s*['"]?([^'"\n]{1,200})/m.exec(text);
  return json?.[1] ?? yaml?.[1] ?? "";
}

/** A refused fetch or a document that didn't map: the person can fix these, so say what happened. */
function sourceProblem(e: unknown): Response {
  if (e instanceof FetchRefused) return json(422, { error: "fetch_refused", message: e.message });
  if (e instanceof AdminError) return json(422, { error: "invalid_document", message: e.message });
  throw e;
}
