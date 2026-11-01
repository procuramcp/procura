import { describe, expect, it } from "vitest";
import { matchesRegistered, redirectUriProblem } from "./redirect.ts";

describe("redirectUriProblem", () => {
  it.each(["https://claude.ai/api/mcp/auth_callback", "http://localhost:33418/callback", "http://127.0.0.1/cb", "cursor://anysphere.cursor-mcp/oauth/callback", "com.example.app:/oauth"])(
    "allows %s",
    (uri) => expect(redirectUriProblem(uri)).toBeUndefined(),
  );

  it.each([
    ["http://example.com/cb", "http is allowed only for localhost"],
    ["https://example.com/cb#frag", "must not have a fragment"],
    ["https://user:pw@example.com/cb", "must not contain credentials"],
    ["javascript:alert(1)", "scheme javascript: is not allowed"],
    ["data:text/html,hi", "scheme data: is not allowed"],
    ["file:///etc/passwd", "scheme file: is not allowed"],
    ["not a url", "is not a valid URL"],
  ])("refuses %s", (uri, problem) => expect(redirectUriProblem(uri)).toBe(problem));
});

describe("matchesRegistered", () => {
  it("matches exactly", () => {
    expect(matchesRegistered("https://a.test/cb", ["https://a.test/cb"])).toBe(true);
    expect(matchesRegistered("https://a.test/cb?x=1", ["https://a.test/cb"])).toBe(false);
    expect(matchesRegistered("https://a.test/cb/", ["https://a.test/cb"])).toBe(false);
  });

  it("lets loopback http use any port, but nothing else", () => {
    expect(matchesRegistered("http://localhost:5555/cb", ["http://localhost:3000/cb"])).toBe(true);
    expect(matchesRegistered("http://localhost:5555/other", ["http://localhost:3000/cb"])).toBe(false);
    expect(matchesRegistered("http://127.0.0.1:5555/cb", ["http://localhost:3000/cb"])).toBe(false);
    expect(matchesRegistered("https://a.test:8443/cb", ["https://a.test/cb"])).toBe(false);
  });
});
