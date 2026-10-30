// Re-download the corpus from the manifest URLs and update hashes and dates.
// The only part of the eval that uses the network; the eval itself runs offline.
// Usage: node scripts/fetch-corpus.ts [id ...]   (no ids = every refetchable entry)
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_DOCUMENT_BYTES } from "@cairnmcp/ingest";
import { DEFAULT_MANIFEST_PATH, loadCorpusManifest, resolveCorpusFile, type CorpusEntry } from "../src/manifest.ts";

const TIMEOUT_MS = 60_000;
const manifestPath = DEFAULT_MANIFEST_PATH;
const manifest = loadCorpusManifest(manifestPath);
const only = new Set(process.argv.slice(2));
const today = new Date().toISOString().slice(0, 10);

async function download(entry: CorpusEntry): Promise<string> {
  const response = await fetch(entry.sourceUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${entry.id}: ${response.status} ${response.statusText} from ${entry.sourceUrl}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_DOCUMENT_BYTES) throw new Error(`${entry.id}: ${declared} bytes exceeds ${MAX_DOCUMENT_BYTES}`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) throw new Error(`${entry.id}: body exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  return text;
}

const entries: CorpusEntry[] = [];
for (const entry of manifest.entries) {
  if (entry.refetch === false || (only.size > 0 && !only.has(entry.id))) {
    entries.push(entry);
    continue;
  }
  const text = await download(entry);
  const file = resolveCorpusFile(manifestPath, entry.file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  entries.push({ ...entry, sha256, retrievedOn: today });
  console.log(`${entry.id}: ${sha256} (${Buffer.byteLength(text, "utf8")} bytes)`);
}

entries.sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(manifestPath, `${JSON.stringify({ entries }, null, 2)}\n`);
console.log(`updated ${manifestPath}`);
