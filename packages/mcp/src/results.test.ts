import { describe, expect, it } from "vitest";
import { toCallToolResult } from "./results.ts";

describe("toCallToolResult", () => {
  it("wraps non-object JSON so structured content is an object", () => {
    expect(toCallToolResult({ ok: true, status: 200, data: [1, 2] })).toEqual({ content: [{ type: "text", text: "[1,2]" }], structuredContent: { result: [1, 2] } });
    expect(toCallToolResult({ ok: true, status: 200, data: { a: 1 } }).structuredContent).toEqual({ a: 1 });
    expect(toCallToolResult({ ok: true, status: 200, data: "plain" })).toEqual({ content: [{ type: "text", text: "plain" }] });
  });

  it("returns failures as tool errors the agent can act on", () => {
    const result = toCallToolResult({ ok: false, error: { kind: "rate_limited", message: "retry in 5s", retryable: true, retryAfterSeconds: 5 } });
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "retry in 5s" }],
      structuredContent: { error: { kind: "rate_limited", message: "retry in 5s", retryable: true, retryAfterSeconds: 5 } },
    });
  });
});
