import { describe, expect, it } from "vitest";
import { operationIdFrom, propertyNameFrom, uniqueName } from "./naming.ts";

describe("naming", () => {
  it.each([
    ["getActivity", "get_activity"],
    ["downloadWorkout_1", "download_workout_1"],
    ["listHTTPLogs", "list_http_logs"],
    ["2fa-verify", "op_2fa_verify"],
  ])("operationId %s → %s", (opId, expected) => {
    expect(operationIdFrom(opId, "GET", "/x")).toBe(expected);
  });

  it("falls back to method and path", () => {
    expect(operationIdFrom(undefined, "GET", "/api/v1/athlete/{id}/events")).toBe("get_api_v1_athlete_by_id_events");
    expect(operationIdFrom("", "DELETE", "/things/{thingId}")).toBe("delete_things_by_thing_id");
  });

  it("caps ids at 64 characters", () => {
    expect(operationIdFrom("a".repeat(100), "GET", "/").length).toBe(64);
  });

  it("dedupes within the limit", () => {
    const used = new Set<string>();
    const long = "x".repeat(64);
    expect(uniqueName("a", used)).toBe("a");
    expect(uniqueName("a", used)).toBe("a_2");
    expect(uniqueName(long, used)).toBe(long);
    expect(uniqueName(long, used)).toBe(`${"x".repeat(62)}_2`);
  });

  it("sanitizes property names", () => {
    expect(propertyNameFrom("page[size]")).toBe("page_size_");
    expect(propertyNameFrom("X-Request-Id")).toBe("X-Request-Id");
  });
});
