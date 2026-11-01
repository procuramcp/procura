import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url).pathname;

export type Migration = { version: string; sql: string; checksum: string };

// Any constant works; it only has to be the same for every migrator.
const LOCK_KEY = 7_020_240_001;
const FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Migration files in order. Names are `NNNN_description.sql`; the number is the version. */
export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const seen = new Set<string>();
  return files.map((file) => {
    const match = FILE.exec(file);
    if (!match) throw new Error(`migration file name must look like 0001_name.sql: ${file}`);
    const version = match[1]!;
    if (seen.has(version)) throw new Error(`two migrations share version ${version}`);
    seen.add(version);
    const sql = readFileSync(join(dir, file), "utf8");
    return { version: file.slice(0, -".sql".length), sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}

export type MigrateResult = { applied: string[]; alreadyApplied: string[] };

/**
 * Apply pending migrations as the owner role. Each migration runs in its own
 * transaction; an advisory lock keeps two migrators from running at once.
 * Refuses to run if an applied migration's file changed or is missing:
 * migrations are append-only, so fix forward with a new file.
 */
export async function migrate(ownerUrl: string, options: { migrations?: Migration[] } = {}): Promise<MigrateResult> {
  const migrations = options.migrations ?? loadMigrations();
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    // The migrator owns the schema and its bookkeeping table; migrations fill the schema.
    await client.query("CREATE SCHEMA IF NOT EXISTS cairnmcp");
    await client.query(`CREATE TABLE IF NOT EXISTS cairnmcp.schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ version: string; checksum: string }>("SELECT version, checksum FROM cairnmcp.schema_migrations");
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    const known = new Set(migrations.map((m) => m.version));
    const unknown = [...applied.keys()].filter((v) => !known.has(v));
    if (unknown.length > 0) throw new Error(`database has migrations this code doesn't know: ${unknown.join(", ")}`);

    const result: MigrateResult = { applied: [], alreadyApplied: [] };
    for (const m of migrations) {
      const checksum = applied.get(m.version);
      if (checksum !== undefined) {
        if (checksum !== m.checksum) throw new Error(`migration ${m.version} was edited after it was applied; add a new migration instead`);
        result.alreadyApplied.push(m.version);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO cairnmcp.schema_migrations (version, checksum) VALUES ($1, $2)", [m.version, m.checksum]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${m.version} failed: ${(e as Error).message}`, { cause: e });
      }
      result.applied.push(m.version);
    }
    return result;
  } finally {
    await client.end();
  }
}
