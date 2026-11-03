// Re-download the corpus from the manifest URLs and update hashes and dates (re-pin). URLs of
// fetched documents name a commit (D-017): to move one to a newer version, change the commit in its
// sourceUrl first, then run this for its id.
// The eval itself only downloads fetched documents that are missing, and checks their hashes.
// Usage: node scripts/fetch-corpus.ts [id ...]   (no ids = every refetchable entry)
import { writeFileSync } from "node:fs";
import { downloadDocument, sha256Of, writeCorpusFile } from "../src/fetch.ts";
import { DEFAULT_MANIFEST_PATH, loadCorpusManifest, type CorpusEntry } from "../src/manifest.ts";

const manifestPath = DEFAULT_MANIFEST_PATH;
const manifest = loadCorpusManifest(manifestPath);
const only = new Set(process.argv.slice(2));
const today = new Date().toISOString().slice(0, 10);

const entries: CorpusEntry[] = [];
for (const entry of manifest.entries) {
  if (entry.refetch === false || (only.size > 0 && !only.has(entry.id))) {
    entries.push(entry);
    continue;
  }
  const text = await downloadDocument(entry);
  writeCorpusFile(manifestPath, entry, text);
  const sha256 = sha256Of(text);
  entries.push({ ...entry, sha256, retrievedOn: today });
  console.log(`${entry.id}: ${sha256} (${Buffer.byteLength(text, "utf8")} bytes)`);
}

entries.sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(manifestPath, `${JSON.stringify({ entries }, null, 2)}\n`);
console.log(`updated ${manifestPath}`);
