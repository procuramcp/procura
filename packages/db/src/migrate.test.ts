import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Database } from "./client.ts";
import { loadMigrations, migrate } from "./migrate.ts";
import { allTables } from "./schema.ts";
import { scratchDatabase, testDatabaseUrl, withAdmin, type ScratchDatabase } from "./test-support.ts";

describe("loadMigrations", () => {
  it("finds the migrations in version order with checksums", () => {
    const migrations = loadMigrations();
    expect(migrations[0]?.version).toBe("0001_tenancy");
    expect(migrations.map((m) => m.version)).toEqual([...migrations.map((m) => m.version)].sort());
    for (const m of migrations) expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

const adminUrl = testDatabaseUrl();

describe.skipIf(!adminUrl)("migrations (Postgres)", () => {
  let scratch: ScratchDatabase;
  beforeAll(async () => {
    scratch = await scratchDatabase(adminUrl!);
  });
  afterAll(async () => {
    await scratch?.drop();
  });

  it("does nothing the second time", async () => {
    const result = await migrate(scratch.ownerUrl);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toContain("0001_tenancy");
  });

  it("refuses to run when an applied migration was edited", async () => {
    const edited = loadMigrations().map((m, i) => (i === 0 ? { ...m, checksum: "0".repeat(64) } : m));
    await expect(migrate(scratch.ownerUrl, { migrations: edited })).rejects.toThrow(/edited after it was applied/);
  });

  it("refuses to run when the database is ahead of the code", async () => {
    await expect(migrate(scratch.ownerUrl, { migrations: [] })).rejects.toThrow(/doesn't know: 0001_tenancy/);
  });

  it("rolls back a failing migration entirely", async () => {
    const bad = { version: "9999_bad", checksum: "x", sql: "CREATE TABLE cairnmcp.half_done (id int); SELECT 1/0;" };
    await expect(migrate(scratch.ownerUrl, { migrations: [...loadMigrations(), bad] })).rejects.toThrow(/9999_bad failed/);
    const leftovers = await withAdmin(scratch.adminUrl, (c) =>
      c.query("SELECT (SELECT count(*) FROM pg_tables WHERE tablename = 'half_done') + (SELECT count(*) FROM cairnmcp.schema_migrations WHERE version = '9999_bad') AS n"),
    );
    expect(Number(leftovers.rows[0].n)).toBe(0);
  });

  it("has every column the Drizzle schema expects", async () => {
    const { rows } = await withAdmin(scratch.adminUrl, (c) =>
      c.query<{ table_name: string; column_name: string }>("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'cairnmcp'"),
    );
    const actual = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const expected = Object.values(allTables).flatMap((t) => {
      const config = getTableConfig(t);
      return config.columns.map((c) => `${config.name}.${c.name}`);
    });
    expect(expected.filter((c) => !actual.has(c))).toEqual([]);
  });

  it("forces row-level security on every table with a tenant_id", async () => {
    const { rows } = await withAdmin(scratch.adminUrl, (c) =>
      c.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'cairnmcp' AND c.relkind = 'r'
          AND (c.relname = 'tenants' OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'))`),
    );
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity).map((r) => r.relname)).toEqual([]);
  });

  it("gives the app role no TRUNCATE, which would skip row-level security", async () => {
    const { rows } = await withAdmin(scratch.adminUrl, (c) =>
      c.query("SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'cairnmcp_app' AND privilege_type = 'TRUNCATE'"),
    );
    expect(rows).toEqual([]);
  });

  it("lets the app add signing keys but never change or delete them", async () => {
    const { rows } = await withAdmin(scratch.adminUrl, (c) =>
      c.query("SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'cairnmcp_app' AND table_name = 'oauth_signing_keys' ORDER BY 1"),
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT"]);
  });

  it("hides tenant tables in a transaction without a tenant", async () => {
    const db = await Database.connect({ url: scratch.appUrl, max: 1 });
    try {
      const owner = await db.ensureUser("https://issuer.test", "no-tenant-owner");
      await db.createTenant("no-tenant", owner);
      const rows = await db.withoutTenant((tx) => tx.select().from(allTables.tenants));
      expect(rows).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("refuses to connect as the owner or a superuser", async () => {
    await expect(Database.connect({ url: scratch.ownerUrl })).rejects.toThrow(/refusing to connect/);
    await expect(Database.connect({ url: scratch.adminUrl })).rejects.toThrow(/refusing to connect/);
    const db = await Database.connect({ url: scratch.appUrl });
    await db.close();
  });
});

describe.skipIf(!adminUrl)("0006 team and customers (Postgres)", () => {
  it("turns members into viewers and keeps their access", async () => {
    const before = loadMigrations().filter((m) => m.version < "0006");
    const scratch = await scratchDatabase(adminUrl!, { migrations: before });
    const owner = new pg.Client({ connectionString: scratch.ownerUrl });
    await owner.connect();
    try {
      await owner.query("BEGIN");
      await owner.query("SELECT set_config('app.tenant_id', 'old', true)");
      await owner.query("INSERT INTO cairnmcp.tenants (id, name) VALUES ('old', 'Old')");
      await owner.query("INSERT INTO cairnmcp.users (id, issuer, subject) VALUES ('u-owner', 'i', 'owner'), ('u-friend', 'i', 'friend')");
      await owner.query("INSERT INTO cairnmcp.memberships (tenant_id, user_id, role) VALUES ('old', 'u-owner', 'owner'), ('old', 'u-friend', 'member')");
      await owner.query("COMMIT");

      expect((await migrate(scratch.ownerUrl)).applied).toEqual(["0006_team_and_customers"]);

      await owner.query("BEGIN");
      await owner.query("SELECT set_config('app.tenant_id', 'old', true)");
      const { rows } = await owner.query("SELECT user_id, role, status FROM cairnmcp.memberships ORDER BY user_id");
      await owner.query("COMMIT");
      expect(rows).toEqual([
        { user_id: "u-friend", role: "viewer", status: "active" },
        { user_id: "u-owner", role: "owner", status: "active" },
      ]);
    } finally {
      await owner.end();
      await scratch.drop();
    }
  });
});
