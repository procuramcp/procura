import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export const CorpusEntry = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  file: z.string().min(1),
  sourceUrl: z.url(),
  license: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  retrievedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().min(1).optional(),
  /**
   * False for files owned elsewhere (e.g. a test fixture in another package),
   * so the fetch script never overwrites them.
   */
  refetch: z.boolean().optional(),
  /**
   * False for large documents (over 1 MB) kept out of git (D-017): `pnpm eval:ingest` downloads
   * them into the gitignored `corpus/fetched/` and checks them against `sha256`.
   */
  vendored: z.boolean().optional(),
});
export type CorpusEntry = z.infer<typeof CorpusEntry>;

export const CorpusManifest = z.object({
  entries: z.array(CorpusEntry).min(1),
});
export type CorpusManifest = z.infer<typeof CorpusManifest>;

export const DEFAULT_MANIFEST_PATH = resolve(import.meta.dirname, "../corpus/manifest.json");

export function loadCorpusManifest(manifestPath = DEFAULT_MANIFEST_PATH): CorpusManifest {
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  return CorpusManifest.parse(raw);
}

/** Where fetched (not vendored) documents are kept, next to the manifest. Gitignored. */
export const FETCHED_DIR = "fetched";

export function isVendored(entry: CorpusEntry): boolean {
  return entry.vendored !== false;
}

export function resolveCorpusFile(manifestPath: string, entry: Pick<CorpusEntry, "file" | "vendored">): string {
  return entry.vendored === false ? resolve(dirname(manifestPath), FETCHED_DIR, entry.file) : resolve(dirname(manifestPath), entry.file);
}

/** Whether the entry's document is on disk (vendored ones always should be). */
export function isPresent(manifestPath: string, entry: CorpusEntry): boolean {
  return existsSync(resolveCorpusFile(manifestPath, entry));
}
