// Operator commands for setting up a tenant: what the curation UI will do later.
// They run as the app role, inside the tenant (RLS applies), plus the narrow
// cross-tenant functions (D-024). Nothing here prints a secret.
import {
  countBySideEffect,
  defaultToolset,
  IrDocument,
  resolveToolset,
  SourceId,
  TenantId,
  Toolset,
  ToolsetAccessLevel,
  ToolsetId,
  UserId,
} from "@procura/core";
import { ensureMember, getSource, getToolset, listSourceSummaries, listToolsets, PG, pgErrorCode, putSource, putToolset, schema, setToolsetAccess, type Database } from "@procura/db";
import { ingestOpenApiText } from "@procura/ingest";
import { CredentialInput, type Vault } from "@procura/vault";
import { eq } from "drizzle-orm";

export class AdminError extends Error {}

export async function createTenant(db: Database, input: { name: string; ownerUserId: string; id?: string }): Promise<TenantId> {
  const owner = UserId.parse(input.ownerUserId);
  const id = input.id === undefined ? undefined : parseOr(TenantId, input.id, "tenant id must be 1-64 letters, digits, - or _");
  try {
    return await db.createTenant(input.name, owner, id === undefined ? {} : { id });
  } catch (e) {
    const code = pgErrorCode(e);
    if (code === PG.UNIQUE_VIOLATION) throw new AdminError(`tenant ${id} already exists`);
    if (code === PG.FOREIGN_KEY_VIOLATION) throw new AdminError(`no user ${owner}: they need to sign in once first (the "No access" page shows their account id)`);
    throw e;
  }
}

export type SourceSummary = { id: SourceId; name: string; operations: number; reads: number; authSchemes: string[]; warnings: number };

export type MappedSource = { ir: IrDocument; warnings: Array<{ code: string; message: string; pointer?: string }> };

/**
 * Ingest an OpenAPI document into a source, without storing it: shared by the
 * admin CLI and the console (D-035). `fixedUsernames` is per-API curation
 * (e.g. Intervals.icu's basic-auth username is the literal `API_KEY`), by auth
 * scheme id; `baseUrl` overrides the document's servers.
 */
export function mapSource(input: { sourceId: string; openapi: string; documentUrl?: string; baseUrl?: string; fixedUsernames?: Record<string, string> }): MappedSource {
  const sourceId = parseOr(SourceId, input.sourceId, "source id must be a lowercase slug, e.g. intervals-icu");
  const mapped = ingestOpenApiText(input.openapi, {
    sourceId,
    ...(input.documentUrl ? { documentUrl: input.documentUrl } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
  });
  if (!mapped.ok) {
    const errors = mapped.diagnostics.filter((d) => d.severity === "error").slice(0, 5);
    throw new AdminError(`the OpenAPI document didn't map:\n${errors.map((d) => `  ${d.code}: ${d.message}`).join("\n")}`);
  }
  const fixed = input.fixedUsernames ?? {};
  for (const schemeId of Object.keys(fixed)) {
    const scheme = mapped.ir.source.authSchemes.find((s) => s.id === schemeId);
    if (!scheme || scheme.type !== "http_basic") throw new AdminError(`--fixed-username: ${schemeId} isn't a basic-auth scheme of this API`);
  }
  // Already validated by the ingestor, and again by putSource before storing; no third parse here.
  const ir: IrDocument = {
    ...mapped.ir,
    source: {
      ...mapped.ir.source,
      authSchemes: mapped.ir.source.authSchemes.map((s) => (s.type === "http_basic" && fixed[s.id] ? { ...s, fixedUsername: fixed[s.id] } : s)),
    },
  };
  const warnings = mapped.diagnostics
    .filter((d) => d.severity === "warning")
    .map((d) => ({ code: d.code, message: d.message, ...("pointer" in d && typeof d.pointer === "string" ? { pointer: d.pointer } : {}) }));
  return { ir, warnings };
}

export function summarize(mapped: MappedSource): SourceSummary {
  const { ir } = mapped;
  const counts = countBySideEffect(ir.operations);
  return {
    id: ir.source.id,
    name: ir.source.name,
    operations: counts.total,
    reads: counts.read,
    authSchemes: ir.source.authSchemes.map((s) => s.id),
    warnings: mapped.warnings.length,
  };
}

/** Ingest an OpenAPI document and store it as a source (replacing one with the same id). */
export async function addSource(
  db: Database,
  input: { tenantId: string; sourceId: string; openapi: string; fixedUsernames?: Record<string, string> },
): Promise<SourceSummary> {
  const tenantId = TenantId.parse(input.tenantId);
  const mapped = mapSource(input);
  await db.withTenant(tenantId, async (tx) => putSource(tx, mapped.ir));
  return summarize(mapped);
}

/**
 * Create or replace a toolset: from a curated JSON definition, or the default
 * (every operation a tool, only reads enabled; D-016). Refused if it doesn't
 * resolve against the source (D-015), so a broken toolset is never stored.
 */
export async function putToolsetFor(
  db: Database,
  input: { tenantId: string; sourceId: string; toolsetId: string; name?: string; definition?: unknown },
): Promise<{ id: ToolsetId; enabled: string[]; disabled: number }> {
  const tenantId = TenantId.parse(input.tenantId);
  return db.withTenant(tenantId, async (tx) => {
    const source = await getSource(tx, input.sourceId);
    if (!source) throw new AdminError(`no source ${input.sourceId} in tenant ${tenantId}`);
    const parsed =
      input.definition === undefined
        ? defaultToolset(source.ir, { id: input.toolsetId, name: input.name ?? input.toolsetId })
        : Toolset.safeParse({ ...(input.definition as object), id: input.toolsetId, sourceId: source.id, ...(input.name ? { name: input.name } : {}) });
    const toolset = "success" in parsed ? (parsed.success ? parsed.data : undefined) : parsed;
    if (!toolset) throw new AdminError(`invalid toolset definition: ${"error" in parsed ? parsed.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : ""}`);
    const resolved = resolveToolset(toolset, source.ir);
    if (!resolved.ok) throw new AdminError(`toolset doesn't fit the source:\n${resolved.issues.map((i) => `  ${i.toolName}: ${i.message}`).join("\n")}`);
    await putToolset(tx, toolset);
    return { id: toolset.id, enabled: resolved.tools.map((t) => t.name), disabled: toolset.tools.length - resolved.tools.length };
  });
}

/** Give a user access to a toolset, adding them as a member first if needed. `none` revokes. */
export async function grantAccess(
  db: Database,
  input: { tenantId: string; toolsetId: string; userId: string; level: "use" | "use_writes" | "none" },
): Promise<{ addedMember: boolean }> {
  const tenantId = TenantId.parse(input.tenantId);
  const userId = UserId.parse(input.userId);
  const toolsetId = ToolsetId.parse(input.toolsetId);
  return db.withTenant(tenantId, async (tx) => {
    if (!(await getToolset(tx, toolsetId))) throw new AdminError(`no toolset ${toolsetId} in tenant ${tenantId}`);
    let addedMember = false;
    if (input.level !== "none") {
      try {
        addedMember = await ensureMember(tx, userId);
      } catch (e) {
        if (pgErrorCode(e) === PG.FOREIGN_KEY_VIOLATION) throw new AdminError(`no user ${userId}: they need to sign in once first`);
        throw e;
      }
    }
    await setToolsetAccess(tx, toolsetId, userId, input.level === "none" ? undefined : ToolsetAccessLevel.parse(input.level));
    return { addedMember };
  });
}

/**
 * Store the upstream credential for one auth scheme of a source, replacing any
 * earlier one for that scheme. The secret arrives on stdin, never as an argument.
 */
export async function setCredential(
  vault: Vault,
  input: { tenantId: string; sourceId: string; schemeId: string; credential: CredentialInput },
): Promise<{ id: string; replaced: number }> {
  const tenantId = TenantId.parse(input.tenantId);
  try {
    const stored = await vault.replaceCredential({ ...input, tenantId, credential: CredentialInput.parse(input.credential) });
    return { id: stored.id, replaced: stored.replaced };
  } catch (e) {
    if (pgErrorCode(e) === PG.FOREIGN_KEY_VIOLATION) throw new AdminError(`no source ${input.sourceId} in tenant ${tenantId}`);
    throw e;
  }
}

export type TenantOverview = {
  tenant: { id: string; name: string };
  members: Array<{ userId: string; role: string; issuer: string }>;
  sources: Array<{ id: string; name: string; operations: number }>;
  toolsets: Array<{ id: string; sourceId: string; enabledTools: number; access: Array<{ userId: string; level: string }> }>;
  credentials: Array<{ sourceId: string; schemeId: string; kind: string }>;
};

/** Everything in a tenant, without secrets. */
export async function showTenant(db: Database, vault: Vault, tenantIdInput: string): Promise<TenantOverview> {
  const tenantId = TenantId.parse(tenantIdInput);
  const overview = await db.withTenant(tenantId, async (tx) => {
    const [tenant] = await tx.select().from(schema.tenants);
    if (!tenant) throw new AdminError(`no tenant ${tenantId}`);
    const members = await tx
      .select({ userId: schema.memberships.userId, role: schema.memberships.role, issuer: schema.users.issuer })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId));
    const access = await tx.select().from(schema.toolsetAccess);
    const sources = (await listSourceSummaries(tx)).map((s) => ({ id: s.id, name: s.name, operations: s.operations.total }));
    const toolsets = (await listToolsets(tx)).map((t) => ({
      id: t.id,
      sourceId: t.sourceId,
      enabledTools: t.tools.filter((b) => b.enabled).length,
      access: access.filter((a) => a.toolsetId === t.id).map((a) => ({ userId: a.userId, level: a.level })),
    }));
    return { tenant: { id: tenant.id, name: tenant.name }, members, sources, toolsets };
  });
  const credentials = (await vault.listCredentials(tenantId)).map((c) => ({ sourceId: c.sourceId, schemeId: c.schemeId, kind: c.kind }));
  return { ...overview, credentials };
}

function parseOr<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, value: string, message: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new AdminError(message);
  return r.data;
}
