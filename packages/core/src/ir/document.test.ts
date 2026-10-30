import { describe, expect, it } from "vitest";
import { IrDocument } from "./document.ts";
import { rawDocument, rawOperation } from "./test-helpers.ts";

const messages = (value: unknown) => {
  const r = IrDocument.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("IrDocument", () => {
  it("parses a valid document and round-trips through JSON", () => {
    const doc = IrDocument.parse(rawDocument([rawOperation({ id: "get_item" })]));
    expect(IrDocument.parse(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it("rejects duplicate operation ids", () => {
    expect(messages(rawDocument([rawOperation({ id: "get_item" }), rawOperation({ id: "get_item" })]))).toContain(
      'duplicate operation id "get_item"',
    );
  });

  it("rejects auth requirements that name unknown schemes", () => {
    const doc = rawDocument([{ ...rawOperation({ id: "get_item" }), auth: [[{ schemeId: "nope", scopes: [] }]] }]);
    expect(messages(doc)).toContain('unknown auth scheme "nope"');
  });

  it("rejects an unknown IR version", () => {
    expect(messages({ ...rawDocument([]), irVersion: 2 })).not.toEqual([]);
  });
});
