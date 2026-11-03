import { describe, expect, it } from "vitest";
import { applyLegacyEnvNames } from "./legacy-env.ts";

describe("applyLegacyEnvNames", () => {
  it("fills a PROCURA_ setting from its old CAIRNMCP_ name", () => {
    const env: Record<string, string | undefined> = { CAIRNMCP_MASTER_KEY: "k", CAIRNMCP_PUBLIC_URL: "https://a.test", OTHER: "x" };
    expect(applyLegacyEnvNames(env)).toEqual(["CAIRNMCP_MASTER_KEY", "CAIRNMCP_PUBLIC_URL"]);
    expect(env).toMatchObject({ PROCURA_MASTER_KEY: "k", PROCURA_PUBLIC_URL: "https://a.test" });
  });

  it("never overrides a new name that is set, and skips empty old values", () => {
    const env: Record<string, string | undefined> = { CAIRNMCP_PUBLIC_URL: "https://old.test", PROCURA_PUBLIC_URL: "https://new.test", CAIRNMCP_PORT: "", PROCURA_PORT: "" };
    expect(applyLegacyEnvNames(env)).toEqual([]);
    expect(env["PROCURA_PUBLIC_URL"]).toBe("https://new.test");
    expect(env["PROCURA_PORT"]).toBe("");
  });

  it("treats an empty new name as unset", () => {
    const env: Record<string, string | undefined> = { CAIRNMCP_DATABASE_URL: "postgres://x", PROCURA_DATABASE_URL: "" };
    expect(applyLegacyEnvNames(env)).toEqual(["CAIRNMCP_DATABASE_URL"]);
    expect(env["PROCURA_DATABASE_URL"]).toBe("postgres://x");
  });
});
