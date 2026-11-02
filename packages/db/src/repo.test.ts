// The lightweight repo queries: they must agree with what the full IR says.
import { AccessProfile, countBySideEffect, defaultToolset, SignInConfig, type TenantId, type UserId } from "@cairnmcp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "./client.ts";
import { PG, pgErrorCode } from "./errors.ts";
import {
  countOwners,
  ensureMember,
  getMember,
  getToolsetWithSource,
  listCustomers,
  listTeam,
  listOperationEffects,
  listSourceIds,
  listSourceSummaries,
  putSource,
  putToolset,
  setMemberRole,
  tenantName,
  toolsetVersion,
  updateMember,
  listProfiles,
  putProfile,
  refundAllowance,
  setMemberProfiles,
  takeAllowance,
  toolsetAccessFor,
  usageFor,
  usagePeriods,
  deleteSignIn,
  deleteUpstreamGrant,
  getSignIn,
  getUpstreamGrant,
  memberProfileIds,
  putSignIn,
  putUpstreamGrant,
  signInProfileIds,
  syncSignInProfiles,
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

  it("adds people as customers once and refuses unknown users with a foreign-key error", async () => {
    const friend = await db.ensureUser("https://issuer.test", "repo-friend");
    await db.withTenant(tenantId, async (tx) => {
      expect(await ensureMember(tx, friend)).toBe(true);
      expect(await ensureMember(tx, friend, "viewer")).toBe(false);
      expect(await ensureMember(tx, ownerId)).toBe(false);
      expect((await getMember(tx, friend))?.role).toBe("customer");
      expect((await listTeam(tx)).map((m) => m.role)).toEqual(["owner"]);
      expect(await tenantName(tx)).toBe("repo");
    });
    const failure = await db.withTenant(tenantId, (tx) => ensureMember(tx, "no-such-user" as UserId)).catch((e: unknown) => e);
    expect(pgErrorCode(failure)).toBe(PG.FOREIGN_KEY_VIOLATION);
  });

  it("moves people between the team and customers, and counts owners", async () => {
    const editor = await db.ensureUser("https://issuer.test", "repo-editor", "editor@repo.test");
    await db.withTenant(tenantId, async (tx) => {
      await ensureMember(tx, editor);
      expect(await setMemberRole(tx, editor, "editor")).toBe(true);
      expect((await listTeam(tx)).map((m) => [m.role, m.label])).toEqual([
        ["owner", null],
        ["editor", "editor@repo.test"],
      ]);
      expect(await countOwners(tx)).toBe(1);
      expect(await setMemberRole(tx, "not-here" as UserId, "owner")).toBe(false);
    });
  });

  it("keeps the latest sign-in label, and a sign-in without one keeps the old", async () => {
    const user = await db.ensureUser("https://issuer.test", "repo-relabel", "old@repo.test");
    expect(await db.ensureUser("https://issuer.test", "repo-relabel", "  new@repo.test ")).toBe(user);
    expect(await db.ensureUser("https://issuer.test", "repo-relabel")).toBe(user);
    await db.withTenant(tenantId, (tx) => ensureMember(tx, user));
    expect((await db.withTenant(tenantId, (tx) => getMember(tx, user)))?.label).toBe("new@repo.test");
  });

  it("pages through customers newest first, and searches label, id, and note", async () => {
    const ids: UserId[] = [];
    for (let i = 0; i < 7; i++) {
      const id = await db.ensureUser("https://issuer.test", `page-${i}`, `athlete${i}@club.test`);
      // One transaction each: now() is the transaction's start, so these get distinct times.
      await db.withTenant(tenantId, (tx) => ensureMember(tx, id));
      ids.push(id);
    }
    await db.withTenant(tenantId, (tx) => updateMember(tx, ids[2]!, { note: "Trial ends 100% in March", status: "suspended" }));

    const seen: UserId[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await db.withTenant(tenantId, (tx) => listCustomers(tx, { query: "club.test", limit: 3, ...(after ? { after } : {}) }));
      expect(page.total).toBe(7);
      seen.push(...page.customers.map((c) => c.userId));
      after = page.next;
      pages++;
    } while (after);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].reverse());

    const search = (query: string) => db.withTenant(tenantId, async (tx) => (await listCustomers(tx, { query })).customers.map((c) => c.userId));
    expect(await search("ATHLETE3@")).toEqual([ids[3]]);
    expect(await search(ids[5]!)).toEqual([ids[5]]);
    // % and _ match themselves, not any text.
    expect(await search("100%")).toEqual([ids[2]]);
    expect(await search("athlete_")).toEqual([]);
    const suspended = await db.withTenant(tenantId, (tx) => getMember(tx, ids[2]!));
    expect([suspended?.status, suspended?.note]).toEqual(["suspended", "Trial ends 100% in March"]);
    // A tampered cursor reads as the first page instead of failing.
    expect((await db.withTenant(tenantId, (tx) => listCustomers(tx, { after: "garbage" }))).customers.length).toBeGreaterThan(0);
  });

  describe("plan limits and allowances (D-039)", () => {
    it("works out UTC days and months, across a year end", () => {
      expect(usagePeriods(new Date("2026-12-31T23:59:59.999Z"))).toEqual({
        day: "2026-12-31",
        month: "2026-12-01",
        dayEnds: "2027-01-01T00:00:00Z",
        monthEnds: "2027-01-01T00:00:00Z",
      });
      expect(usagePeriods(new Date("2026-02-28T10:00:00Z")).dayEnds).toBe("2026-03-01T00:00:00Z");
    });

    it("stores a profile's limits and hands them to access checks", async () => {
      const customer = await db.ensureUser("https://issuer.test", "plan-holder");
      const free = AccessProfile.parse({
        id: "free",
        name: "Free",
        rules: [{ toolsetId: "intervals", level: "use" }],
        limits: { perDay: 100, perMonth: 1000, upgradeUrl: "https://example.com/pricing" },
      });
      await db.withTenant(tenantId, async (tx) => {
        await putProfile(tx, free);
        await ensureMember(tx, customer);
        await setMemberProfiles(tx, customer, ["free"]);
        expect((await listProfiles(tx)).find((p) => p.id === "free")?.limits).toEqual(free.limits);
        expect((await toolsetAccessFor(tx, "intervals", customer)).rules.map((r) => r.limits)).toEqual([free.limits]);
        // Clearing a limit stores null, not the old value.
        await putProfile(tx, { ...free, limits: { perDay: 100 } });
        expect((await listProfiles(tx)).find((p) => p.id === "free")?.limits).toEqual({ perDay: 100 });
      });
    });

    it("counts calls up to the daily allowance, then refuses until the next day", async () => {
      const user = await db.ensureUser("https://issuer.test", "daily");
      await db.withTenant(tenantId, (tx) => ensureMember(tx, user));
      const now = new Date("2026-11-02T15:00:00Z");
      const take = (at = now) => db.withTenant(tenantId, (tx) => takeAllowance(tx, user, { perDay: 3, perMonth: 10 }, at));
      for (let i = 0; i < 3; i++) expect((await take()).ok).toBe(true);
      expect(await take()).toEqual({ ok: false, period: "day", limit: 3, resetsAt: "2026-11-03T00:00:00Z" });
      // The refused call took nothing from the month.
      expect((await db.withTenant(tenantId, (tx) => usageFor(tx, [user], now))).get(user)).toEqual({ today: 3, month: 3 });
      expect((await take(new Date("2026-11-03T00:00:01Z"))).ok).toBe(true);
    });

    it("refuses at the monthly allowance without counting the day, and refunds", async () => {
      const user = await db.ensureUser("https://issuer.test", "monthly");
      await db.withTenant(tenantId, (tx) => ensureMember(tx, user));
      const now = new Date("2026-11-02T15:00:00Z");
      const take = () => db.withTenant(tenantId, (tx) => takeAllowance(tx, user, { perMonth: 2 }, now));
      const first = await take();
      await take();
      expect(await take()).toEqual({ ok: false, period: "month", limit: 2, resetsAt: "2026-12-01T00:00:00Z" });
      if (!first.ok) throw new Error("first call should be allowed");
      await db.withTenant(tenantId, (tx) => refundAllowance(tx, user, first.periods));
      expect((await db.withTenant(tenantId, (tx) => usageFor(tx, [user], now))).get(user)).toEqual({ today: 1, month: 1 });
      expect((await take()).ok).toBe(true);
    });

    it("never lets concurrent calls overshoot an allowance", async () => {
      const user = await db.ensureUser("https://issuer.test", "burst");
      await db.withTenant(tenantId, (tx) => ensureMember(tx, user));
      const now = new Date("2026-11-02T15:00:00Z");
      const results = await Promise.all(Array.from({ length: 20 }, () => db.withTenant(tenantId, (tx) => takeAllowance(tx, user, { perDay: 5 }, now))));
      expect(results.filter((r) => r.ok)).toHaveLength(5);
      expect((await db.withTenant(tenantId, (tx) => usageFor(tx, [user], now))).get(user)).toEqual({ today: 5, month: 5 });
    });

    it("keeps one tenant's usage out of another's", async () => {
      const other = await newTenant(db, "repo-other");
      const user = await db.ensureUser("https://issuer.test", "daily");
      const now = new Date("2026-11-02T15:00:00Z");
      expect((await db.withTenant(other.tenantId, (tx) => usageFor(tx, [user], now))).size).toBe(0);
      // Their allowance there starts from zero.
      expect((await db.withTenant(other.tenantId, (tx) => takeAllowance(tx, user, { perDay: 1 }, now))).ok).toBe(true);
    });
  });

  describe("a tenant's own sign-in (D-040)", () => {
    const sealed = { iv: "aXY=", ciphertext: "Y3Q=", tag: "dGFn" };
    const config = { kind: "oidc" as const, name: "Acme", issuer: "https://login.acme.test", clientId: "abc", scopes: "openid", defaultProfileId: "free" };

    it("stores the sign-in, keeps the secret when it isn't replaced, and deletes it", async () => {
      await db.withTenant(tenantId, async (tx) => {
        await putSignIn(tx, SignInConfig.parse(config), sealed);
        expect(await getSignIn(tx)).toMatchObject({ config, secret: sealed });
        await putSignIn(tx, SignInConfig.parse({ ...config, name: "Acme Login" }));
        expect(await getSignIn(tx)).toMatchObject({ config: { name: "Acme Login" }, secret: sealed });
        expect(await deleteSignIn(tx)).toBe(true);
        expect(await getSignIn(tx)).toBeUndefined();
      });
    });

    it("keeps claim rules on profiles", async () => {
      const claims = [{ claim: "plan", value: "pro" }, { claim: "https://acme.test/roles", value: "admin" }];
      await db.withTenant(tenantId, async (tx) => {
        await putProfile(tx, AccessProfile.parse({ id: "pro", name: "Pro", rules: [], claims: [...claims, claims[0]] }));
        expect((await listProfiles(tx)).find((p) => p.id === "pro")?.claims).toEqual(expect.arrayContaining(claims));
        expect((await listProfiles(tx)).find((p) => p.id === "pro")?.claims).toHaveLength(2);
      });
    });

    it("lets sign-in manage its own profiles and never the team's", async () => {
      const user = await db.ensureUser("https://issuer.test", "claims-sync");
      await db.withTenant(tenantId, async (tx) => {
        await ensureMember(tx, user);
        for (const id of ["a", "b", "c"]) await putProfile(tx, AccessProfile.parse({ id, name: id.toUpperCase(), rules: [] }));
        await setMemberProfiles(tx, user, ["a"]);
        await syncSignInProfiles(tx, user, ["a", "b"]);
        // "a" stays the team's; only "b" is from sign-in.
        expect((await signInProfileIds(tx, [user])).get(user)).toEqual(["b"]);
        await syncSignInProfiles(tx, user, ["c"]);
        expect((await memberProfileIds(tx, [user])).get(user)?.sort()).toEqual(["a", "c"]);
        // The team removing everything leaves sign-in's.
        await setMemberProfiles(tx, user, []);
        expect((await memberProfileIds(tx, [user])).get(user)).toEqual(["c"]);
        // The team giving one sign-in also gives makes it theirs.
        await setMemberProfiles(tx, user, ["c"]);
        await syncSignInProfiles(tx, user, []);
        expect((await memberProfileIds(tx, [user])).get(user)).toEqual(["c"]);
      });
    });

    it("keeps one upstream grant per token family, and purges expired ones", async () => {
      const user = await db.ensureUser("https://issuer.test", "grant-holder");
      const later = new Date(Date.now() + 3_600_000);
      await db.withTenant(tenantId, async (tx) => {
        await putUpstreamGrant(tx, { familyId: "fam-1", userId: user, sealed, expiresAt: later });
        await putUpstreamGrant(tx, { familyId: "fam-1", userId: user, sealed: { ...sealed, iv: "bmV3" }, expiresAt: later });
        await putUpstreamGrant(tx, { familyId: "fam-old", userId: user, sealed, expiresAt: new Date(Date.now() - 1000) });
        expect((await getUpstreamGrant(tx, "fam-1"))?.sealed.iv).toBe("bmV3");
      });
      expect(await db.purgeUpstreamGrants()).toBe(1);
      await db.withTenant(tenantId, async (tx) => {
        expect(await getUpstreamGrant(tx, "fam-old")).toBeUndefined();
        await deleteUpstreamGrant(tx, "fam-1");
        expect(await getUpstreamGrant(tx, "fam-1")).toBeUndefined();
      });
    });

    it("keeps one tenant's sign-in and grants from another", async () => {
      const other = await newTenant(db, "repo-sign-in-other");
      const user = await db.ensureUser("https://issuer.test", "grant-holder");
      await db.withTenant(tenantId, async (tx) => {
        await putSignIn(tx, SignInConfig.parse(config), sealed);
        await putUpstreamGrant(tx, { familyId: "fam-shared", userId: user, sealed, expiresAt: new Date(Date.now() + 3_600_000) });
      });
      await db.withTenant(other.tenantId, async (tx) => {
        expect(await getSignIn(tx)).toBeUndefined();
        expect(await getUpstreamGrant(tx, "fam-shared")).toBeUndefined();
      });
    });
  });
});
