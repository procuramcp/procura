// Updating a source to a new version (D-048) and restoring a kept one (D-049), shared by
// the console, the admin CLI, and the scheduled check so they can't drift.
import { canonicalJson, diffIsEmpty, planSourceUpdate, TenantId, withoutCuration, type IrDocument, type SourceUpdatePlan, type UserId } from "@procura/core";
import { deleteSourceCheck, getSource, getSourceVersion, listProfiles, listToolsets, putProfile, putSource, putSourceCheck, putToolset, saveSourceVersion, type Database, type TenantTx } from "@procura/db";
import { sha256Hex } from "@procura/http";
import { AdminError, mapSource } from "./admin.ts";
import { discoverDocument, FetchRefused, type DocumentGetter } from "./fetch-document.ts";

/** Where the new version comes from: a URL, the document's text, or a kept version. Nothing: the source's own URL. */
export type UpdateFrom = { url?: string | undefined; document?: string | undefined; version?: number | undefined };

export type NextVersion = {
  ir: IrDocument;
  warnings: Array<{ code: string; message: string; pointer?: string }>;
  documentUrl: string | null;
  /** How the document was found, for a person to read. */
  via: string;
  /** Of the fetched or given text; none for a kept version. */
  documentSha256: string | null;
  /** Fetched from `documentUrl` just now, so it is what the API publishes there. */
  fetched: boolean;
};

/** The version with `documentUrl` recorded in it, so the source keeps its URL (and its checks). */
const withDocumentUrl = (ir: IrDocument, documentUrl: string | null): IrDocument =>
  documentUrl === null || ir.source.derivation.documentUrl === documentUrl ? ir : { ...ir, source: { ...ir.source, derivation: { ...ir.source.derivation, documentUrl } } };

/** Something the person can fix (or must know): shown as is. */
export class UpdateProblem extends AdminError {
  readonly code: "not_found" | "fetch_refused" | "invalid_document";
  constructor(code: UpdateProblem["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** The new version of a source. Fetching happens outside any transaction. */
export async function loadNextVersion(db: Database, tenantId: TenantId, sourceId: string, from: UpdateFrom, getDocument: DocumentGetter): Promise<NextVersion> {
  const stored = await db.withTenant(tenantId, async (tx) => {
    const source = await getSource(tx, sourceId);
    if (!source) return undefined;
    const kept = from.version === undefined ? undefined : await getSourceVersion(tx, sourceId, from.version);
    return { documentUrl: source.ir.source.derivation.documentUrl ?? null, kept };
  });
  if (!stored) throw new UpdateProblem("not_found", `no source ${sourceId}`);

  if (from.version !== undefined) {
    if (!stored.kept) throw new UpdateProblem("not_found", `no kept version ${from.version} of ${sourceId}`);
    // Where the API publishes it now, not where it did then.
    const documentUrl = stored.documentUrl ?? stored.kept.source.derivation.documentUrl ?? null;
    return { ir: withDocumentUrl(withoutCuration(stored.kept), documentUrl), warnings: [], documentUrl, via: `kept version ${from.version}`, documentSha256: null, fetched: false };
  }

  let text: string;
  let documentUrl: string | null;
  let via: string;
  if (from.document) {
    // Pasted text doesn't say where the API publishes it, so the source keeps its URL.
    [text, documentUrl, via] = [from.document, stored.documentUrl, "pasted or uploaded"];
  } else {
    const url = from.url ?? stored.documentUrl;
    if (!url) throw new UpdateProblem("fetch_refused", "this source was added from pasted text: give a URL or the new document");
    try {
      const found = await discoverDocument(url, getDocument);
      [text, documentUrl, via] = [found.text, found.documentUrl, found.via];
    } catch (e) {
      if (e instanceof FetchRefused) throw new UpdateProblem("fetch_refused", e.message);
      throw e;
    }
  }
  let mapped;
  try {
    mapped = mapSource({ sourceId, openapi: text, ...(documentUrl ? { documentUrl } : {}) });
  } catch (e) {
    if (e instanceof AdminError) throw new UpdateProblem("invalid_document", e.message);
    throw e;
  }
  return { ir: withDocumentUrl(mapped.ir, documentUrl), warnings: mapped.warnings, documentUrl, via, documentSha256: sha256Hex(text), fetched: !from.document };
}

export type PlannedUpdate = { plan: SourceUpdatePlan; current: IrDocument; digest: string };

/** The plan against what's stored now, and a digest of everything it depends on. Undefined: no such source. */
export async function planStoredUpdate(tx: TenantTx, sourceId: string, next: NextVersion, baseUrl: "current" | "document"): Promise<PlannedUpdate | undefined> {
  const source = await getSource(tx, sourceId);
  if (!source) return undefined;
  const toolsets = await listToolsets(tx);
  const profiles = (await listProfiles(tx)).map(({ members: _, ...p }) => p);
  const plan = planSourceUpdate({ current: source.ir, next: next.ir, toolsets, profiles, baseUrl });
  // jsonb reorders keys: canonical JSON, so the same state always gives the same digest.
  const digest = sha256Hex(canonicalJson({ current: source.ir, next: plan.ir, toolsets: plan.toolsets, profiles: plan.profiles }));
  return { plan, current: source.ir, digest };
}

/**
 * Store a planned update in the caller's transaction: the replaced version goes into the
 * source's history, then the source, its toolsets, and its plans. Returns the kept version's number.
 */
export async function applyStoredUpdate(tx: TenantTx, planned: PlannedUpdate, next: NextVersion, input: { by: UserId | null; now: Date }): Promise<number> {
  const version = await saveSourceVersion(tx, planned.current, input.by);
  await putSource(tx, planned.plan.ir);
  for (const toolset of planned.plan.toolsets) await putToolset(tx, toolset);
  for (const profile of planned.plan.profiles) await putProfile(tx, profile);
  // Fetched from the source's URL just now: up to date. A restored or pasted version may not be
  // what the API publishes, so its check is cleared and the next run compares again.
  const sourceId = planned.plan.ir.source.id;
  if (next.fetched && next.documentUrl === planned.plan.ir.source.derivation.documentUrl) {
    await putSourceCheck(tx, sourceId, { status: "current", checkedAt: input.now, documentSha256: next.documentSha256 });
  } else {
    await deleteSourceCheck(tx, sourceId);
  }
  return version;
}

/** The update as text, for the CLI: what changes, then what to check. */
export function describeUpdate(plan: SourceUpdatePlan): string[] {
  const { diff, effects } = plan;
  const lines = [`${diff.added.length} new, ${diff.removed.length} removed, ${diff.changed.length} changed, ${diff.unchanged} unchanged`];
  const list = (title: string, items: string[]) => items.length && lines.push(`${title}:`, ...items.map((i) => `  ${i}`));
  list("new", diff.added.map((o) => `${o.id} (${o.class}) ${o.method} ${o.path}`));
  list("removed", diff.removed.map((o) => `${o.id} (${o.class}) ${o.method} ${o.path}`));
  list("changed", diff.changed.map((o) => `${o.id}: ${[o.renamedFrom ? `renamed from ${o.renamedFrom}` : "", ...o.details].filter(Boolean).join("; ")}`));
  if (diff.baseUrl) lines.push(`base URL: the document says ${diff.baseUrl.document}; keeping ${diff.baseUrl.used === "current" ? diff.baseUrl.current : diff.baseUrl.document}`);
  const attention = [
    ...effects.toolsets.flatMap((t) => [
      ...t.removedTools.filter((r) => r.enabled).map((r) => `${t.toolsetId}: ${r.name} is on and will be removed`),
      ...t.disabledTools.map((d) => `${t.toolsetId}: ${d.name} will be turned off (pinned ${d.pins.join(", ")} gone)`),
      ...t.sideEffectChanged.map((c) => `${t.toolsetId}: ${c.name} becomes ${c.to} (was ${c.from})`),
      ...t.issues.map((i) => `${t.toolsetId}: ${i.message}`),
    ]),
    ...effects.profiles.flatMap((p) => [
      ...(p.removedOperations.length ? [`plan ${p.profileId}: drops ${p.removedOperations.map((r) => r.operationId).join(", ")}`] : []),
      ...p.removedRules.map((r) => `plan ${p.profileId}: loses its rule for ${r}`),
    ]),
    ...diff.authSchemes.added.map((id) => `new sign-in scheme ${id}: set its key after updating`),
    ...diff.classifications.dropped.map((c) => `your classification of ${c.id} (${c.class}) goes with it`),
  ];
  list("check before applying", attention);
  return lines;
}

/**
 * Update a source from the admin CLI: plan and, with `apply`, store it in one transaction.
 * Without `apply` it's a dry run. Returns the description and what happened.
 */
export async function updateSourceFromCli(
  db: Database,
  input: { tenantId: string; sourceId: string; from: UpdateFrom; baseUrl: "current" | "document"; apply: boolean; getDocument: DocumentGetter; now: Date },
): Promise<{ lines: string[]; outcome: "up_to_date" | "dry_run" | "applied"; keptVersion?: number }> {
  const tenantId = TenantId.safeParse(input.tenantId).data;
  if (!tenantId) throw new AdminError("tenant id must be 1-64 letters, digits, - or _");
  const next = await loadNextVersion(db, tenantId, input.sourceId, input.from, input.getDocument);
  return db.withTenant(tenantId, async (tx) => {
    const planned = await planStoredUpdate(tx, input.sourceId, next, input.baseUrl);
    if (!planned) throw new UpdateProblem("not_found", `no source ${input.sourceId}`);
    const lines = [`${input.sourceId} from ${next.via}${next.documentUrl ? ` (${next.documentUrl})` : ""}`, ...describeUpdate(planned.plan)];
    if (diffIsEmpty(planned.plan.diff)) {
      // Nothing to apply, but the source is up to date as of now.
      if (input.apply && next.fetched) await putSourceCheck(tx, input.sourceId, { status: "current", checkedAt: input.now, documentSha256: next.documentSha256 });
      return { lines: [...lines, "Already up to date."], outcome: "up_to_date" as const };
    }
    if (!input.apply) return { lines: [...lines, "Dry run: nothing changed. Run again with --apply to update."], outcome: "dry_run" as const };
    const keptVersion = await applyStoredUpdate(tx, planned, next, { by: null, now: input.now });
    const { toolsets, profiles } = planned.plan;
    return { lines: [...lines, `Updated. Adjusted ${toolsets.length} toolset(s) and ${profiles.length} plan(s); the previous version is kept as ${keptVersion}.`], outcome: "applied" as const, keptVersion };
  });
}

