# @procura/db

Postgres storage for tenants, their team and customers, sources, toolsets, the vault, and the audit log, with
tenant isolation enforced by row-level security (RLS). Design: `docs/DECISIONS.md` D-024.

## Roles

Two login roles, created once by an administrator before the first migration:

```sql
-- Group role the migrations grant privileges to. Never logs in.
CREATE ROLE cairnmcp_app NOLOGIN NOBYPASSRLS;
-- Owns the schema and runs migrations. Not a superuser.
CREATE ROLE cairnmcp_owner LOGIN NOBYPASSRLS PASSWORD '…';
GRANT CREATE ON DATABASE procura TO cairnmcp_owner;
-- What the app connects as. Not the owner, not a superuser, no BYPASSRLS.
CREATE ROLE cairnmcp_server LOGIN NOBYPASSRLS PASSWORD '…' IN ROLE cairnmcp_app;
```

`Database.connect` refuses to run as a superuser, a `BYPASSRLS` role, or the tables' owner.

## Migrating

Migrations are hand-written SQL in `migrations/NNNN_name.sql`, applied in order, each in its own
transaction. They are append-only: editing an applied file makes the migrator refuse to run, so
fix forward with a new file.

```bash
PROCURA_DATABASE_OWNER_URL=postgres://cairnmcp_owner:…@host/procura pnpm --filter @procura/db migrate
```

When you change a table, update `src/schema.ts` (Drizzle's typed view of it) too; a test checks
that every Drizzle column exists after migrating.

## Using it

```ts
const db = await Database.connect({ url: process.env.PROCURA_DATABASE_URL });
await db.withTenant(tenantId, async (tx) => {
  if (!(await mayCallTool(tx, { toolsetId, userId, sideEffect }))) throw new Error("forbidden");
  // ...
});
const vault = new Vault({ store: new PgVaultStore(db), keyWrapper });
const audit = new PgAuditSink(db);
```

All tenant data goes through `withTenant`, which sets `app.tenant_id` for that transaction only.
With no tenant set, every tenant table reads as empty and rejects writes. Creating tenants and
looking up users by token issuer and subject are the only cross-tenant operations, each a
`SECURITY DEFINER` function (`createTenant`, `findUser`, `ensureUser`).

## Tests

The isolation tests need a real Postgres and a superuser URL (they create roles and a scratch
database per test file, then drop it):

```bash
PROCURA_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test
```

Without the variable they are skipped with a warning. In CI they are required: CI provides a
Postgres service, and a missing URL fails the run.
