import { describe, expect, it } from "vitest";
import { classifyHttpOperation, curateSideEffect, splitWords, suggestRead } from "./side-effect.ts";

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

describe("curateSideEffect (D-043)", () => {
  const post = classifyHttpOperation({ method: "POST", name: "accountsGet", pathTemplate: "/accounts/get" });

  it("records a person's class and keeps what ingest said", () => {
    expect(curateSideEffect(post, "read")).toEqual({ class: "read", basis: "curated", reason: "marked read in the console", automatic: post });
    expect(curateSideEffect(post, "read", " looks it up ").reason).toBe("looks it up");
  });

  it("restores ingest's class on automatic, or when set back to it", () => {
    const curated = curateSideEffect(post, "read");
    expect(curateSideEffect(curated, "automatic")).toEqual(post);
    expect(curateSideEffect(curated, "write")).toEqual(post);
    expect(curateSideEffect(post, "automatic")).toEqual(post);
    expect(curateSideEffect(post, "write")).toEqual(post);
  });

  it("changes a curated class without losing the automatic one", () => {
    expect(curateSideEffect(curateSideEffect(post, "read"), "destructive")).toMatchObject({ class: "destructive", automatic: post });
  });
});

describe("suggestRead (D-043)", () => {
  const suggest = (method: "POST" | "GET" | "PUT", name: string, pathTemplate: string) =>
    suggestRead({ method, name, pathTemplate, sideEffect: classifyHttpOperation({ method, name, pathTemplate }) });

  it.each([
    ["accountsGet", "/accounts/get"],
    ["transactionsList", "/transactions/list"],
    ["", "/accounts/balance/get"],
    ["searchInstitutions", "/institutions/search"],
    ["getLinkToken", "/link/token/info"],
  ])("suggests %s %s", (name, path) => {
    expect(suggest("POST", name, path)).toBeDefined();
  });

  it.each([
    ["POST", "linkTokenCreate", "/link/token/create"], // a change word anywhere wins
    ["POST", "itemRemove", "/item/remove"],
    ["POST", "getAndUpdate", "/things/get"],
    ["POST", "PostRadarValueListsValueList", "/v1/radar/value_lists/{value_list}"], // ends in a noun
    ["POST", "exchange", "/item/public_token/exchange"], // no lookup verb
    ["GET", "accountsGet", "/accounts/get"], // already a read
    ["PUT", "accountsGet", "/accounts/get"], // only POST is used this way
    ["POST", "resetLogin", "/sandbox/item/reset_login/get"], // escalated, so not a plain POST
  ] as const)("doesn't suggest %s %s %s", (method, name, path) => {
    expect(suggest(method, name, path)).toBeUndefined();
  });
});
