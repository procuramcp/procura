// The lightweight repo queries: they must agree with what the full IR says.
import { countBySideEffect, defaultToolset, type TenantId, type UserId } from "@cairnmcp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "./client.ts";
import { PG, pgErrorCode } from "./errors.ts";
import {
  ensureMember,
  getToolsetWithSource,
  listMembers,
  listOperationEffects,
  listSourceIds,
  listSourceSummaries,
  putSource,
  putToolset,
  tenantName,
  toolsetVersion,
} from "./repo.ts";
import { intervalsIr, newTenant, scratchDatabase, testDatabaseUrl, type ScratchDatabase } from "./test-support.ts";

const adminUrl = testDatabaseUrl();

describe.skipIf(!adminUrl)("repo queries", () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let tenantId: TenantId;
  let ownerId: UserId;
  const ir = intervalsIr();

  beforeAll(async () => {
    scratch = await scratchDatabase(adminUrl!);
    db = await Database.connect({ url: scratch.appUrl });
    ({ tenantId, ownerId } = await newTenant(db, "repo"));
    await db.withTenant(tenantId, async (tx) => {
      await putSource(tx, ir);
      await putToolset(tx, defaultToolset(ir, { id: "intervals", name: "Intervals" }));
    });
  });
  afterAll(async () => {
    await db?.close();
    await scratch?.drop();
  });

  it("summarizes sources and their side effects in SQL, matching the IR", async () => {
    await db.withTenant(tenantId, async (tx) => {
      expect(await listSourceIds(tx)).toEqual(["intervals-icu"]);
      expect(await listSourceSummaries(tx)).toEqual([{ id: "intervals-icu", name: ir.source.name, operations: countBySideEffect(ir.operations) }]);
      const effects = (await listOperationEffects(tx)).get("intervals-icu");
      expect(effects?.size).toBe(ir.operations.length);
      for (const op of ir.operations) expect(effects?.get(op.id)).toBe(op.sideEffect.class);
    });
  });

  it("loads a toolset with its source", async () => {
    await db.withTenant(tenantId, async (tx) => {
      const loaded = await getToolsetWithSource(tx, "intervals");
      expect(loaded?.toolset.sourceId).toBe("intervals-icu");
      expect(loaded?.source.ir.operations.length).toBe(ir.operations.length);
      expect(await getToolsetWithSource(tx, "missing")).toBeUndefined();
    });
  });

  it("gives a toolset a version that changes when the toolset or its source is written", async () => {
    const version = () => db.withTenant(tenantId, (tx) => toolsetVersion(tx, "intervals"));
    const first = await version();
    expect(first).toMatch(/^\d+:\d+$/);
    expect(await version()).toBe(first);
    await db.withTenant(tenantId, (tx) => putToolset(tx, defaultToolset(ir, { id: "intervals", name: "Renamed" })));
    const second = await version();
    expect(second).not.toBe(first);
    await db.withTenant(tenantId, (tx) => putSource(tx, ir));
    expect(await version()).not.toBe(second);
    expect(await db.withTenant(tenantId, (tx) => toolsetVersion(tx, "missing"))).toBeUndefined();
  });

  it("adds members once and refuses unknown users with a foreign-key error", async () => {
    const friend = await db.ensureUser("https://issuer.test", "repo-friend");
    await db.withTenant(tenantId, async (tx) => {
      expect(await ensureMember(tx, friend)).toBe(true);
      expect(await ensureMember(tx, friend)).toBe(false);
      expect(await ensureMember(tx, ownerId)).toBe(false);
      expect((await listMembers(tx)).map((m) => m.role).sort()).toEqual(["member", "owner"]);
      expect(await tenantName(tx)).toBe("repo");
    });
    const failure = await db.withTenant(tenantId, (tx) => ensureMember(tx, "no-such-user" as UserId)).catch((e: unknown) => e);
    expect(pgErrorCode(failure)).toBe(PG.FOREIGN_KEY_VIOLATION);
  });
});
