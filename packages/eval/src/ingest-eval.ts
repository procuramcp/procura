import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { isRecord, type Diagnostic, type Operation, type SideEffect } from "@cairnmcp/core";
import { ingestOpenApiText } from "@cairnmcp/ingest";
import { parse as parseYaml } from "yaml";
import { DEFAULT_MANIFEST_PATH, loadCorpusManifest, resolveCorpusFile, type CorpusEntry } from "./manifest.ts";

type CodeCounts = Record<string, number>;

type Outcome = { kind: "mapped" } | { kind: "rejected"; fatalCode: string };

export type IngestEvalDocumentResult = {
  id: string;
  file: string;
  sourceUrl: string;
  license: string;
  sha256: string;
  retrievedOn: string;
  outcome: Outcome;
  operations: { document: number; ir: number; skipped: number };
  diagnostics: {
    warningsByCode: CodeCounts;
    errorsByCode: CodeCounts;
    infosByCode: CodeCounts;
  };
  sideEffects: {
    classCounts: Record<SideEffect, number>;
    nameHeuristicEscalations: number;
  };
  confidence: { mean: number; min: number } | null;
  schemas: {
    input: { total: number; strictAjvCompiles: number };
    output: { total: number; strictAjvCompiles: number };
  };
  compactIrBytes: number;
  topDiagnostics: Array<{ code: string; severity: Diagnostic["severity"]; count: number }>;
  errorSamples: Array<{ code: string; operationId?: string; message: string }>;
};

export type IngestEvalReport = {
  summary: {
    corpusEntries: number;
    mapped: number;
    rejected: number;
    operationsInDocuments: number;
    operationsInIr: number;
    operationsSkipped: number;
    /** Operations in documents the mapper rejected outright (e.g. Swagger 2.0). */
    operationsInRejectedDocuments: number;
  };
  documents: IngestEvalDocumentResult[];
};

export function runIngestEval(options?: { manifestPath?: string; ids?: string[] }): IngestEvalReport {
  const manifestPath = options?.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const manifest = loadCorpusManifest(manifestPath);
  const wanted = options?.ids ? new Set(options.ids) : undefined;
  const entries = manifest.entries
    .filter((entry) => wanted === undefined || wanted.has(entry.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  const documents = entries.map((entry) => evaluateEntry(entry, manifestPath));
  const summary = {
    corpusEntries: documents.length,
    mapped: documents.filter((d) => d.outcome.kind === "mapped").length,
    rejected: documents.filter((d) => d.outcome.kind === "rejected").length,
    operationsInDocuments: documents.reduce((sum, d) => sum + d.operations.document, 0),
    operationsInIr: documents.reduce((sum, d) => sum + d.operations.ir, 0),
    operationsSkipped: documents.reduce((sum, d) => sum + d.operations.skipped, 0),
    operationsInRejectedDocuments: documents
      .filter((d) => d.outcome.kind === "rejected")
      .reduce((sum, d) => sum + d.operations.document, 0),
  };
  return { summary, documents };
}

export function writeIngestEvalReport(report: IngestEvalReport, outputPaths?: { jsonPath?: string; markdownPath?: string }) {
  const jsonPath = resolve(import.meta.dirname, outputPaths?.jsonPath ?? "../../../docs/eval/ingest-report.json");
  const markdownPath = resolve(import.meta.dirname, outputPaths?.markdownPath ?? "../../../docs/eval/ingest-report.md");
  mkdirSync(dirname(jsonPath), { recursive: true });
  mkdirSync(dirname(markdownPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderMarkdownReport(report));
}

function evaluateEntry(entry: CorpusEntry, manifestPath: string): IngestEvalDocumentResult {
  const absolutePath = resolveCorpusFile(manifestPath, entry.file);
  const text = readFileSync(absolutePath, "utf8");
  const actualSha = createHash("sha256").update(text, "utf8").digest("hex");
  const raw = parseOpenApiText(text);
  const operationsInDocument = countDocumentOperations(raw);

  const ingest = ingestOpenApiText(text, { sourceId: entry.id, documentUrl: entry.sourceUrl });
  const diagnostics = {
    warningsByCode: countCodes(ingest.diagnostics, "warning"),
    errorsByCode: countCodes(ingest.diagnostics, "error"),
    infosByCode: countCodes(ingest.diagnostics, "info"),
  };

  if (!ingest.ok) {
    const fatalCode = ingest.diagnostics.find((d) => d.severity === "error")?.code ?? "unknown_error";
    return {
      id: entry.id,
      file: entry.file,
      sourceUrl: entry.sourceUrl,
      license: entry.license,
      sha256: actualSha,
      retrievedOn: entry.retrievedOn,
      outcome: { kind: "rejected", fatalCode },
      // A rejected document has no operations to skip; it is counted under `rejected`.
      operations: { document: operationsInDocument, ir: 0, skipped: 0 },
      diagnostics,
      sideEffects: { classCounts: { read: 0, write: 0, destructive: 0 }, nameHeuristicEscalations: 0 },
      confidence: null,
      schemas: {
        input: { total: 0, strictAjvCompiles: 0 },
        output: { total: 0, strictAjvCompiles: 0 },
      },
      compactIrBytes: 0,
      topDiagnostics: rankDiagnostics(ingest.diagnostics),
      errorSamples: sampleErrors(ingest.diagnostics),
    };
  }

  const classCounts: Record<SideEffect, number> = { read: 0, write: 0, destructive: 0 };
  for (const operation of ingest.ir.operations) classCounts[operation.sideEffect.class] = classCounts[operation.sideEffect.class] + 1;

  const schemaStats = compileSchemaStats(ingest.ir.operations);
  const confidenceValues = ingest.ir.operations.map((o) => o.confidence);
  const confidence =
    confidenceValues.length === 0
      ? null
      : {
          mean: round(confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length),
          min: round(Math.min(...confidenceValues)),
        };

  return {
    id: entry.id,
    file: entry.file,
    sourceUrl: entry.sourceUrl,
    license: entry.license,
    sha256: actualSha,
    retrievedOn: entry.retrievedOn,
    outcome: { kind: "mapped" },
    operations: {
      document: operationsInDocument,
      ir: ingest.ir.operations.length,
      skipped: countSkippedOperations(ingest.diagnostics, operationsInDocument, ingest.ir.operations.length),
    },
    diagnostics,
    sideEffects: {
      classCounts,
      nameHeuristicEscalations: ingest.ir.operations.filter((o) => o.sideEffect.basis === "name_heuristic").length,
    },
    confidence,
    schemas: schemaStats,
    compactIrBytes: Buffer.byteLength(JSON.stringify(ingest.ir), "utf8"),
    topDiagnostics: rankDiagnostics(ingest.diagnostics),
    errorSamples: sampleErrors(ingest.diagnostics),
  };
}

function countSkippedOperations(diagnostics: Diagnostic[], documentOperations: number, irOperations: number): number {
  const operationIds = new Set(
    diagnostics
      .filter((d): d is Diagnostic & { operationId: string } => d.severity === "error" && d.operationId !== undefined)
      .map((d) => d.operationId),
  );
  return Math.max(operationIds.size, Math.max(documentOperations - irOperations, 0));
}

/**
 * JSON Schema 2020-12 validator that rejects unknown keywords (an OpenAPI-only
 * keyword leaking into the IR is a mapper bug). Ajv's other strict rules
 * (strictTypes, strictRequired, strictTuples) are style lints that reject
 * valid schemas, such as `required` naming an undeclared property, so they
 * are off: they measured upstream sloppiness, not mapper correctness.
 */
function strictAjv() {
  return new Ajv2020({
    strictSchema: true,
    strictNumbers: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    validateFormats: false,
    allowUnionTypes: true,
    allErrors: true,
  });
}

function compileSchemaStats(operations: Operation[]) {
  const ajv = strictAjv();
  let inputTotal = 0;
  let inputOk = 0;
  let outputTotal = 0;
  let outputOk = 0;

  for (const operation of operations) {
    inputTotal++;
    try {
      ajv.compile(operation.input);
      inputOk++;
    } catch {
      // Count only; detailed errors stay in mapper diagnostics.
    }

    if (operation.output === undefined) continue;
    outputTotal++;
    try {
      ajv.compile(operation.output);
      outputOk++;
    } catch {
      // Count only; detailed errors stay in mapper diagnostics.
    }
  }

  return {
    input: { total: inputTotal, strictAjvCompiles: inputOk },
    output: { total: outputTotal, strictAjvCompiles: outputOk },
  };
}

function parseOpenApiText(text: string): unknown {
  return text.trimStart().startsWith("{") ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 100 });
}

function countDocumentOperations(raw: unknown): number {
  if (!isRecord(raw)) return 0;
  const paths = raw["paths"];
  if (!isRecord(paths)) return 0;
  const methods = ["get", "put", "post", "delete", "options", "head", "patch"];
  let count = 0;
  for (const value of Object.values(paths)) {
    if (!isRecord(value)) continue;
    for (const method of methods) {
      if (value[method] !== undefined) count++;
    }
  }
  return count;
}

function countCodes(diagnostics: Diagnostic[], severity: Diagnostic["severity"]): CodeCounts {
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== severity) continue;
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function rankDiagnostics(diagnostics: Diagnostic[]) {
  const counts = new Map<string, { code: string; severity: Diagnostic["severity"]; count: number }>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.severity}:${diagnostic.code}`;
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { code: diagnostic.code, severity: diagnostic.severity, count: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code) || a.severity.localeCompare(b.severity))
    .slice(0, 5);
}

function sampleErrors(diagnostics: Diagnostic[]): Array<{ code: string; operationId?: string; message: string }> {
  return diagnostics
    .filter((d) => d.severity === "error")
    .sort((a, b) => a.code.localeCompare(b.code) || (a.operationId ?? "").localeCompare(b.operationId ?? "") || a.message.localeCompare(b.message))
    .slice(0, 10)
    .map((d) => ({ code: d.code, ...(d.operationId ? { operationId: d.operationId } : {}), message: d.message }));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function renderMarkdownReport(report: IngestEvalReport): string {
  const lines: string[] = [];
  lines.push("# Ingest eval report");
  lines.push("");
  lines.push(`Corpus entries: ${report.summary.corpusEntries}`);
  lines.push(`Mapped: ${report.summary.mapped}`);
  lines.push(`Rejected: ${report.summary.rejected}`);
  lines.push("");
  lines.push("| id | outcome | doc ops | IR ops | skipped | warnings | errors | mean confidence | input Ajv | output Ajv | IR bytes |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const doc of report.documents) {
    const warnings = sumValues(doc.diagnostics.warningsByCode);
    const errors = sumValues(doc.diagnostics.errorsByCode);
    const mean = doc.confidence ? doc.confidence.mean.toFixed(3) : "-";
    lines.push(
      `| ${doc.id} | ${formatOutcome(doc.outcome)} | ${doc.operations.document} | ${doc.operations.ir} | ${doc.operations.skipped} | ${warnings} | ${errors} | ${mean} | ${doc.schemas.input.strictAjvCompiles}/${doc.schemas.input.total} | ${doc.schemas.output.strictAjvCompiles}/${doc.schemas.output.total} | ${doc.compactIrBytes} |`,
    );
  }

  for (const doc of report.documents) {
    lines.push("");
    lines.push(`## ${doc.id}`);
    lines.push("");
    lines.push(`- file: \`${doc.file}\``);
    lines.push(`- outcome: ${formatOutcome(doc.outcome)}`);
    lines.push(`- operations: ${doc.operations.ir}/${doc.operations.document} mapped (skipped ${doc.operations.skipped})`);
    lines.push(
      `- side effects: read ${doc.sideEffects.classCounts.read}, write ${doc.sideEffects.classCounts.write}, destructive ${doc.sideEffects.classCounts.destructive} (name escalations ${doc.sideEffects.nameHeuristicEscalations})`,
    );
    lines.push(`- confidence: ${doc.confidence ? `mean ${doc.confidence.mean.toFixed(3)}, min ${doc.confidence.min.toFixed(3)}` : "n/a"}`);
    lines.push(
      `- strict Ajv: input ${doc.schemas.input.strictAjvCompiles}/${doc.schemas.input.total}, output ${doc.schemas.output.strictAjvCompiles}/${doc.schemas.output.total}`,
    );
    lines.push(`- compact IR bytes: ${doc.compactIrBytes}`);
    lines.push("");
    lines.push("Top diagnostics:");
    if (doc.topDiagnostics.length === 0) lines.push("- none");
    else {
      for (const diag of doc.topDiagnostics) lines.push(`- ${diag.severity} ${diag.code}: ${diag.count}`);
    }
    lines.push("");
    lines.push("Error samples:");
    if (doc.errorSamples.length === 0) lines.push("- none");
    else {
      for (const sample of doc.errorSamples) {
        lines.push(`- ${sample.code}${sample.operationId ? ` (${sample.operationId})` : ""}: ${sample.message}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function formatOutcome(outcome: Outcome): string {
  return outcome.kind === "mapped" ? "mapped" : `rejected (${outcome.fatalCode})`;
}

function sumValues(values: Record<string, number>): number {
  return Object.values(values).reduce((sum, value) => sum + value, 0);
}
