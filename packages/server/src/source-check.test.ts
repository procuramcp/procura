import { Database, getSourceCheck, putSource, type SourceCheck } from "@procura/db";
import { newTenant, scratchDatabase, testDatabaseUrl, type ScratchDatabase } from "@procura/db/test-support";
import type { TenantId } from "@procura/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mapSource } from "./admin.ts";
import { FetchRefused, type DocumentGetter } from "./fetch-document.ts";
import { checkSourcesForUpdates } from "./source-check.ts";

const adminUrl = testDatabaseUrl();
const URL_ = "https://api.test/shop.json";

const shop = (paths: string[]) =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Shop", version: "1" },
    servers: [{ url: "https://shop.test" }],
    paths: Object.fromEntries(paths.map((p) => [p, { get: { responses: { "200": { description: "ok" } } } }])),
  });

describe.skipIf(!adminUrl)("scheduled source checks (D-049, Postgres)", () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let tenantId: TenantId;
  let published = shop(["/items", "/orders"]);
  let fail: Error | undefined;
  const getDocument: DocumentGetter = async (url) => {
    if (fail) throw fail;
    return { url, status: url === URL_ ? 200 : 404, contentType: "application/json", text: url === URL_ ? published : "" };
  };
  let clock = new Date();
  // "Due" compares with the database's now(): with 0 hours, every run finds the source due again.
  const run = (olderThanHours = 0) => checkSourcesForUpdates(db, { getDocument, olderThanHours, max: 50, now: () => clock });
  const check = () => db.withTenant(tenantId, (tx) => getSourceCheck(tx, "shop")) as Promise<SourceCheck>;

  beforeAll(async () => {
    scratch = await scratchDatabase(adminUrl!);
    db = await Database.connect({ url: scratch.appUrl, max: 2 });
    tenantId = (await newTenant(db, "alpha")).tenantId;
    await db.withTenant(tenantId, async (tx) => {
      await putSource(tx, mapSource({ sourceId: "shop", openapi: published, documentUrl: URL_ }).ir);
      // Added from pasted text: there's nothing to check.
      await putSource(tx, mapSource({ sourceId: "pasted", openapi: shop(["/x"]) }).ir);
    });
  });

  afterAll(async () => {
    await db?.close();
    await scratch?.drop();
  });

  it("finds a source up to date, then not due again until its time", async () => {
    expect(await run()).toEqual({ checked: 1, current: 1, changed: 0, failed: 0 });
    expect(await check()).toMatchObject({ status: "current", checkedAt: clock, documentSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await run(24)).toEqual({ checked: 0, current: 0, changed: 0, failed: 0 });
  });

  it("reports a changed document with counts, and keeps that finding while the text stays the same", async () => {
    published = shop(["/items", "/customers"]);
    clock = new Date();
    expect(await run()).toMatchObject({ changed: 1 });
    expect(await check()).toMatchObject({ status: "changed", added: 1, removed: 1, changed: 0 });
    clock = new Date();
    await run();
    expect(await check()).toMatchObject({ status: "changed", added: 1, checkedAt: clock });
  });

  it("records a failure with a message for people, never more than that", async () => {
    fail = new FetchRefused("api.test points to a private or internal address");
    await run();
    expect(await check()).toMatchObject({ status: "failed", message: "api.test points to a private or internal address" });
    fail = new Error("connect ECONNREFUSED 10.0.0.7:443 https://api.test/shop.json?token=abc");
    await run();
    // Discovery reports the source's own URL (shown on its page anyway), never the raw error.
    const message = ((await check()) as { message: string }).message;
    expect(message).toContain("no OpenAPI document found");
    expect(message).not.toMatch(/ECONNREFUSED|10\.0\.0\.7|token=/);
    fail = undefined;
    published = "not an API";
    await run();
    expect(await check()).toMatchObject({ status: "failed", message: expect.stringContaining("no OpenAPI document found") });
  });
});
