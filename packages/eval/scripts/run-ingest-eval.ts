import { runIngestEval, writeIngestEvalReport } from "../src/ingest-eval.ts";

const idsArg = process.argv.find((arg) => arg.startsWith("--ids="));
const ids = idsArg?.slice("--ids=".length).split(",").map((id) => id.trim()).filter((id) => id.length > 0);

const report = runIngestEval({ ...(ids ? { ids } : {}) });
writeIngestEvalReport(report);

console.log(`evaluated ${report.summary.corpusEntries} corpus entries`);
console.log(`mapped ${report.summary.mapped}, rejected ${report.summary.rejected}`);
console.log("wrote docs/eval/ingest-report.json and docs/eval/ingest-report.md");
