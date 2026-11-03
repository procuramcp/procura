// Downloading corpus documents: the only part of the eval that uses the network (D-017).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_DOCUMENT_BYTES } from "@cairnmcp/ingest";
import { isPresent, isVendored, resolveCorpusFile, type CorpusEntry } from "./manifest.ts";

const TIMEOUT_MS = 60_000;

export function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function downloadDocument(entry: CorpusEntry): Promise<string> {
  const response = await fetch(entry.sourceUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${entry.id}: ${response.status} ${response.statusText} from ${entry.sourceUrl}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_DOCUMENT_BYTES) throw new Error(`${entry.id}: ${declared} bytes exceeds ${MAX_DOCUMENT_BYTES}`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) throw new Error(`${entry.id}: body exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  return text;
}

export function writeCorpusFile(manifestPath: string, entry: CorpusEntry, text: string): void {
  const file = resolveCorpusFile(manifestPath, entry);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

/**
 * Download every fetched document that's missing or doesn't match its pinned hash. A download
 * that doesn't match means the source changed: refuse, so the eval never silently runs on
 * different input. `pnpm --filter @cairnmcp/eval corpus:fetch <id>` re-pins it.
 */
export async function ensureFetched(manifestPath: string, entries: CorpusEntry[], log: (line: string) => void = console.log): Promise<void> {
  for (const entry of entries) {
    if (isVendored(entry)) continue;
    if (isPresent(manifestPath, entry) && sha256Of(readFileSync(resolveCorpusFile(manifestPath, entry), "utf8")) === entry.sha256) continue;
    log(`fetching ${entry.id} from ${entry.sourceUrl}`);
    const text = await downloadDocument(entry);
    const sha = sha256Of(text);
    if (sha !== entry.sha256) {
      throw new Error(`${entry.id}: the document changed upstream (sha256 ${sha}, pinned ${entry.sha256}); run corpus:fetch ${entry.id} to re-pin it`);
    }
    writeCorpusFile(manifestPath, entry, text);
  }
}
