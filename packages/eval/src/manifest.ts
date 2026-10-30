import { readFileSync } from "node:fs";
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

export function resolveCorpusFile(manifestPath: string, relativeFilePath: string): string {
  return resolve(dirname(manifestPath), relativeFilePath);
}
