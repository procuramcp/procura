import { TenantId, UserId } from "@cairnmcp/core";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

type Db = NodePgDatabase<typeof schema>;
/** A transaction (usually scoped to one tenant: row-level security hides every other tenant's rows). */
export type TenantTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type DatabaseOptions = {
  /** Connection URL of the app role (not the owner). */
  url: string;
  /** Pool size; default 10. */
  max?: number;
};

/**
 * The app's connection to Postgres. All tenant data is reached through
 * `withTenant`, which sets `app.tenant_id` for one transaction only, so a
 * pooled connection never carries a tenant into the next transaction.
 * Cross-tenant operations are limited to the SECURITY DEFINER functions
 * wrapped here (`createTenant`, `findUser`, `ensureUser`).
 */
export class Database {
  readonly #pool: pg.Pool;
  readonly #db: Db;

  private constructor(pool: pg.Pool) {
    this.#pool = pool;
    this.#db = drizzle({ client: pool, schema });
  }

  /**
   * Connect and refuse to run as a role that could bypass row-level security:
   * a superuser, a BYPASSRLS role, or the tables' owner (or a member of it).
   */
  static async connect(options: DatabaseOptions): Promise<Database> {
    const pool = new pg.Pool({ connectionString: options.url, max: options.max ?? 10 });
    try {
      await assertAppRole(pool);
    } catch (e) {
      await pool.end();
      throw e;
    }
    return new Database(pool);
  }

  async withTenant<T>(tenantId: TenantId, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const id = TenantId.parse(tenantId);
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${id}, true)`);
      return fn(tx);
    });
  }

  /**
   * A transaction with no tenant set, for global tables (the OAuth server's).
   * Tenant tables read as empty and reject writes in here.
   */
  async withoutTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.#db.transaction(fn);
  }

  /** Create a tenant owned by `ownerUserId`, with a random id unless `id` is given (it must be free). */
  async createTenant(name: string, ownerUserId: UserId, options: { id?: TenantId } = {}): Promise<TenantId> {
    const owner = UserId.parse(ownerUserId);
    const { rows } =
      options.id === undefined
        ? await this.#pool.query<{ id: string }>("SELECT cairnmcp.create_tenant($1, $2) AS id", [name, owner])
        : await this.#pool.query<{ id: string }>("SELECT cairnmcp.create_tenant($1, $2, $3) AS id", [name, owner, TenantId.parse(options.id)]);
    return TenantId.parse(rows[0]!.id);
  }

  /** The tenants `userId` is a member of, with their role there (for the console, D-033). */
  async userTenants(userId: UserId): Promise<Array<{ tenantId: TenantId; name: string; role: "owner" | "admin" | "member" }>> {
    const { rows } = await this.#pool.query<{ tenant_id: string; tenant_name: string; role: "owner" | "admin" | "member" }>(
      "SELECT tenant_id, tenant_name, role FROM cairnmcp.user_tenants($1)",
      [UserId.parse(userId)],
    );
    return rows.map((r) => ({ tenantId: TenantId.parse(r.tenant_id), name: r.tenant_name, role: r.role }));
  }

  /** The user for a validated token's issuer and subject, if they have signed in before. */
  async findUser(issuer: string, subject: string): Promise<UserId | undefined> {
    const { rows } = await this.#pool.query<{ id: string | null }>("SELECT cairnmcp.find_user($1, $2) AS id", [issuer, subject]);
    return rows[0]?.id ? UserId.parse(rows[0].id) : undefined;
  }

  /** Find or create the user for a validated token's issuer and subject. */
  async ensureUser(issuer: string, subject: string): Promise<UserId> {
    const { rows } = await this.#pool.query<{ id: string }>("SELECT cairnmcp.ensure_user($1, $2) AS id", [issuer, subject]);
    return UserId.parse(rows[0]!.id);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

async function assertAppRole(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ role: string; rolsuper: boolean; rolbypassrls: boolean; owner: string | null; is_owner: boolean | null }>(`
    SELECT r.rolname AS role, r.rolsuper, r.rolbypassrls, t.tableowner AS owner,
           pg_has_role(current_user, t.tableowner, 'MEMBER') AS is_owner
    FROM pg_roles r
    LEFT JOIN pg_tables t ON t.schemaname = 'cairnmcp' AND t.tablename = 'tenants'
    WHERE r.rolname = current_user`);
  const r = rows[0];
  if (!r) throw new Error("could not read the current database role");
  if (r.owner === null) throw new Error("database is not migrated: run the migrations as the owner role first");
  if (r.rolsuper || r.rolbypassrls || r.is_owner) {
    throw new Error(
      `refusing to connect as "${r.role}": the app role must not be a superuser, have BYPASSRLS, or own the tables; use a separate role that is a member of cairnmcp_app`,
    );
  }
}
