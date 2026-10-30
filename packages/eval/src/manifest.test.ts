import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_MANIFEST_PATH, loadCorpusManifest, resolveCorpusFile } from "./manifest.ts";

describe("corpus manifest", () => {
  it("has sha256 values that match each vendored file", () => {
    const manifest = loadCorpusManifest(DEFAULT_MANIFEST_PATH);
    for (const entry of manifest.entries) {
      const absolutePath = resolveCorpusFile(DEFAULT_MANIFEST_PATH, entry.file);
      const text = readFileSync(absolutePath, "utf8");
      const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
      expect(sha256).toBe(entry.sha256);
    }
  });
});
