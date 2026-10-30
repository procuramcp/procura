import { describe, expect, it } from "vitest";
import { classifyHttpOperation, splitWords } from "./side-effect.ts";

describe("classifyHttpOperation", () => {
  it.each([
    ["GET", "getActivity", "/activity/{id}", "read", "http_method"],
    ["POST", "createEvent", "/events", "write", "http_method"],
    ["PUT", "updateActivity", "/activity/{id}", "write", "http_method"],
    ["DELETE", "deleteActivity", "/activity/{id}", "destructive", "http_method"],
    // Escalations by name: heuristics only ever make things look more dangerous.
    ["PUT", "deleteIntervals", "/activity/{id}/delete-intervals", "destructive", "name_heuristic"],
    ["POST", "resetPassword", "/account/reset", "destructive", "name_heuristic"],
    ["GET", "triggerExport", "/export/trigger", "write", "name_heuristic"],
    ["GET", "clearCache", "/cache", "destructive", "name_heuristic"],
  ] as const)("%s %s → %s (%s)", (method, name, pathTemplate, cls, basis) => {
    const c = classifyHttpOperation({ method, name, pathTemplate });
    expect(c.class).toBe(cls);
    expect(c.basis).toBe(basis);
  });

  it("matches whole words only", () => {
    // "deleted", "settings", "dropdown" must not match "delete", "set", "drop".
    expect(classifyHttpOperation({ method: "GET", name: "listDeletedItems", pathTemplate: "/settings/dropdown" }).class).toBe("read");
  });

  it("ignores words inside path placeholders", () => {
    expect(classifyHttpOperation({ method: "GET", name: "getThing", pathTemplate: "/things/{delete}" }).class).toBe("read");
  });

  it("never lowers DELETE", () => {
    expect(classifyHttpOperation({ method: "DELETE", name: "getThing", pathTemplate: "/x" }).class).toBe("destructive");
  });
});

describe("splitWords", () => {
  it("splits camelCase, acronyms, snake, kebab, and paths", () => {
    expect(splitWords("getHTTPResponse_code-name/v1/x")).toEqual(["get", "http", "response", "code", "name", "v1", "x"]);
  });
});
