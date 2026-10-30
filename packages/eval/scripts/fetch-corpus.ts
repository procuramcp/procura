import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_MANIFEST_PATH, loadCorpusManifest, resolveCorpusFile } from "../src/manifest.ts";

const manifestPath = DEFAULT_MANIFEST_PATH;
const manifest = loadCorpusManifest(manifestPath);

const updated = [] as typeof manifest.entries;
for (const entry of manifest.entries) {
  const response = await fetch(entry.sourceUrl);
  if (!response.ok) throw new Error(`failed to download ${entry.id} from ${entry.sourceUrl}: ${response.status} ${response.statusText}`);
  const text = await response.text();
  const absolutePath = resolveCorpusFile(manifestPath, entry.file);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, text, "utf8");
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  updated.push({ ...entry, sha256 });
  console.log(`${entry.id}: ${sha256} (${Buffer.byteLength(text, "utf8")} bytes)`);
}

const out = {
  entries: updated
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => ({
      id: entry.id,
      file: entry.file,
      sourceUrl: entry.sourceUrl,
      license: entry.license,
      sha256: entry.sha256,
      retrievedOn: entry.retrievedOn,
      ...(entry.notes ? { notes: entry.notes } : {}),
    })),
};
writeFileSync(resolve(manifestPath), `${JSON.stringify(out, null, 2)}\n`);
console.log(`updated ${manifestPath}`);
