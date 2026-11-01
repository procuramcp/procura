// Shared helpers for database tests. Not exported from the package index.
//
// Tests need a Postgres superuser URL in CAIRNMCP_TEST_DATABASE_URL. Each test
// file gets its own scratch database, migrated by a non-superuser owner role,
// and connects as a separate app role, the same split as production.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { IrDocument, TenantId, UserId } from "@cairnmcp/core";
import { ingestOpenApiText } from "@cairnmcp/ingest";
import pg from "pg";
import { Database } from "./client.ts";
import { migrate } from "./migrate.ts";

const ENV = "CAIRNMCP_TEST_DATABASE_URL";

/**
 * The superuser URL, or undefined (tests skip; the config warns). In CI a
 * missing URL is an error: these are the isolation tests and must run.
 */
export function testDatabaseUrl(): string | undefined {
  const url = process.env[ENV];
  if (url) return url;
  if (process.env["CI"]) throw new Error(`${ENV} must be set in CI: the tenant isolation tests require Postgres`);
  return undefined; // vitest.config.ts prints the warning
}

// Fixed role names: roles are cluster-wide, so concurrent test files share them.
export const TEST_OWNER_ROLE = "cairnmcp_test_owner";
export const TEST_APP_ROLE = "cairnmcp_test_app";
const TEST_PASSWORD = "cairnmcp-test-only-not-a-secret";

export type ScratchDatabase = {
  adminUrl: string;
  ownerUrl: string;
  appUrl: string;
  name: string;
  drop(): Promise<void>;
};

/** Create roles (if needed) and a fresh, migrated database. */
export async function scratchDatabase(adminUrl: string): Promise<ScratchDatabase> {
  const name = `cairnmcp_test_${randomBytes(6).toString("hex")}`;
  await withAdmin(adminUrl, async (admin) => {
    // Serialize role setup across concurrent test files.
    await admin.query("SELECT pg_advisory_lock(7020240002)");
    try {
      await ensureRole(admin, "cairnmcp_app", "NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB");
      await ensureRole(admin, TEST_OWNER_ROLE, `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${TEST_PASSWORD}'`);
      await ensureRole(admin, TEST_APP_ROLE, `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${TEST_PASSWORD}'`);
      await admin.query(`GRANT cairnmcp_app TO ${TEST_APP_ROLE}`);
    } finally {
      await admin.query("SELECT pg_advisory_unlock(7020240002)");
    }
    await admin.query(`CREATE DATABASE ${name} OWNER ${TEST_OWNER_ROLE}`);
  });
  const ownerUrl = roleUrl(adminUrl, TEST_OWNER_ROLE, name);
  const drop = () => withAdmin(adminUrl, (admin) => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).then(() => undefined));
  try {
    await migrate(ownerUrl);
  } catch (e) {
    await drop();
    throw e;
  }
  return {
    adminUrl: roleUrl(adminUrl, undefined, name),
    ownerUrl,
    appUrl: roleUrl(adminUrl, TEST_APP_ROLE, name),
    name,
    drop,
  };
}

export async function withAdmin<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function ensureRole(admin: pg.Client, role: string, attributes: string): Promise<void> {
  const { rowCount } = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  await admin.query(`${rowCount ? "ALTER" : "CREATE"} ROLE ${role} ${attributes}`);
}

/** Same server, different role and/or database. `role: undefined` keeps the admin's credentials. */
function roleUrl(adminUrl: string, role: string | undefined, database: string): string {
  const url = new URL(adminUrl);
  if (role !== undefined) {
    url.username = role;
    url.password = TEST_PASSWORD;
  }
  url.pathname = `/${database}`;
  return url.toString();
}

/** A tenant with an owner, created the way sign-up will. */
export async function newTenant(db: Database, name: string): Promise<{ tenantId: TenantId; ownerId: UserId }> {
  const ownerId = await db.ensureUser("https://issuer.test", `${name}-owner`);
  return { tenantId: await db.createTenant(name, ownerId), ownerId };
}

const fixture = new URL("../../ingest/fixtures/intervals-icu/openapi.json", import.meta.url);
let cachedIr: IrDocument | undefined;

/** The Intervals.icu IR, as a source both tenants can have under the same id. */
export function intervalsIr(): IrDocument {
  if (!cachedIr) {
    const mapped = ingestOpenApiText(readFileSync(fixture, "utf8"), { sourceId: "intervals-icu" });
    if (!mapped.ok) throw new Error("fixture failed to map");
    cachedIr = IrDocument.parse(mapped.ir);
  }
  return cachedIr;
}
