import { ensureFetched } from "../src/fetch.ts";
import { runIngestEval, writeIngestEvalReport } from "../src/ingest-eval.ts";
import { DEFAULT_MANIFEST_PATH, loadCorpusManifest } from "../src/manifest.ts";

const idsArg = process.argv.find((arg) => arg.startsWith("--ids="));
const ids = idsArg?.slice("--ids=".length).split(",").map((id) => id.trim()).filter((id) => id.length > 0);
// --offline: skip documents that aren't downloaded yet instead of fetching them.
const offline = process.argv.includes("--offline");

if (!offline) {
  const wanted = ids ? new Set(ids) : undefined;
  await ensureFetched(DEFAULT_MANIFEST_PATH, loadCorpusManifest().entries.filter((e) => !wanted || wanted.has(e.id)));
}
const report = runIngestEval({ ...(ids ? { ids } : {}) });
writeIngestEvalReport(report);

console.log(`evaluated ${report.summary.corpusEntries} corpus entries`);
console.log(`mapped ${report.summary.mapped}, rejected ${report.summary.rejected}`);
if (report.summary.notFetched.length > 0) console.log(`not fetched (offline): ${report.summary.notFetched.join(", ")}`);
console.log("wrote docs/eval/ingest-report.json and docs/eval/ingest-report.md");
