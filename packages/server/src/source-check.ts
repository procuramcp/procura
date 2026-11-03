// The scheduled check for new versions of each source's document (D-049): fetch it, and
// if it differs from what was last seen, ingest and diff it against the stored version.
// It only records what it found; updating stays a person's decision (D-048).
import { diffIsEmpty, planSourceUpdate } from "@procura/core";
import { getSource, getSourceCheck, putSourceCheck, type Database, type SourceCheck } from "@procura/db";
import { sha256Hex } from "@procura/http";
import { AdminError, mapSource } from "./admin.ts";
import { discoverDocument, FetchRefused, type DocumentGetter } from "./fetch-document.ts";

export type CheckRun = { checked: number; current: number; changed: number; failed: number };

/**
 * Check up to `max` sources not checked in `olderThanHours`, one at a time. Never throws for
 * one source's problem: it's recorded as `failed` with a message for the source's page.
 */
export async function checkSourcesForUpdates(db: Database, options: { getDocument: DocumentGetter; olderThanHours: number; max: number; now: () => Date }): Promise<CheckRun> {
  const run: CheckRun = { checked: 0, current: 0, changed: 0, failed: 0 };
  for (const { tenantId, sourceId } of await db.sourcesDueForCheck(options.olderThanHours, options.max)) {
    const stored = await db.withTenant(tenantId, async (tx) => {
      const source = await getSource(tx, sourceId);
      return source && { source, prior: await getSourceCheck(tx, sourceId) };
    });
    const url = stored?.source.ir.source.derivation.documentUrl;
    if (!stored || !url) continue; // gone, or now from pasted text, since the list was made
    const check = await checkOne(url, stored.source.ir, stored.prior, options);
    await db.withTenant(tenantId, (tx) => putSourceCheck(tx, sourceId, check));
    run.checked++;
    run[check.status]++;
  }
  return run;
}

async function checkOne(url: string, current: Parameters<typeof planSourceUpdate>[0]["current"], prior: SourceCheck | undefined, options: { getDocument: DocumentGetter; now: () => Date }): Promise<SourceCheck> {
  let text: string;
  try {
    text = (await discoverDocument(url, options.getDocument)).text;
  } catch (e) {
    return failed(e, options.now());
  }
  const documentSha256 = sha256Hex(text);
  const checkedAt = options.now();
  // The same text as last time: whatever was found then still holds.
  if (prior && prior.status !== "failed" && prior.documentSha256 === documentSha256) return { ...prior, checkedAt };
  try {
    const next = mapSource({ sourceId: current.source.id, openapi: text, documentUrl: url });
    const { diff } = planSourceUpdate({ current, next: next.ir, toolsets: [], profiles: [], baseUrl: "current" });
    if (diffIsEmpty(diff)) return { status: "current", checkedAt, documentSha256 };
    return { status: "changed", checkedAt, documentSha256, added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length };
  } catch (e) {
    return failed(e, checkedAt, documentSha256);
  }
}

function failed(e: unknown, checkedAt: Date, documentSha256: string | null = null): SourceCheck {
  // Refusals and mapping problems are written for people; anything else stays generic, so a
  // message never carries more of the upstream than the person already gave us.
  const message = e instanceof FetchRefused || e instanceof AdminError ? e.message : "the document couldn't be fetched or read";
  return { status: "failed", checkedAt, documentSha256, message };
}
