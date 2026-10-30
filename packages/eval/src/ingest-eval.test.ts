import { describe, expect, it } from "vitest";
import { runIngestEval } from "./ingest-eval.ts";

describe("ingest eval smoke", () => {
  it("evaluates two small corpus entries and returns expected shape", () => {
    const report = runIngestEval({ ids: ["oai-petstore-expanded-v3-0", "swagger-petstore-v3"] });
    expect(report.summary.corpusEntries).toBe(2);
    expect(report.documents).toHaveLength(2);

    for (const doc of report.documents) {
      expect(doc.id.length).toBeGreaterThan(0);
      expect(doc.operations.document).toBeGreaterThan(0);
      expect(doc.operations.ir).toBeGreaterThanOrEqual(0);
      expect(doc.operations.skipped).toBeGreaterThanOrEqual(0);
      expect(typeof doc.compactIrBytes).toBe("number");
      expect(doc.schemas.input.strictAjvCompiles).toBeLessThanOrEqual(doc.schemas.input.total);
      expect(doc.schemas.output.strictAjvCompiles).toBeLessThanOrEqual(doc.schemas.output.total);
      if (doc.outcome.kind === "rejected") expect(doc.outcome.fatalCode.length).toBeGreaterThan(0);
    }
  });

  it("counts a rejected document under rejected, not as skipped operations", () => {
    const report = runIngestEval({ ids: ["oai-petstore-minimal-swagger-2-0"] });
    expect(report.documents[0]?.outcome).toEqual({ kind: "rejected", fatalCode: "unsupported_version" });
    expect(report.summary.operationsSkipped).toBe(0);
    expect(report.summary.operationsInRejectedDocuments).toBe(1);
  });
});
