// Create the roles the app connects with (D-024), as the owner role, and write
// the app's connection URL into an env file. Safe to re-run: roles that exist
// are kept, and the login role gets a fresh password each time (rotation).
//
//   pnpm --filter @cairnmcp/db roles            # writes CAIRNMCP_DATABASE_URL to the repo's .env.local
//
// Owner URL: CAIRNMCP_DATABASE_OWNER_URL, or Neon's DATABASE_URL_UNPOOLED (the
// branch owner on the direct host). The app URL reuses DATABASE_URL's host when
// set (Neon's pooled host), otherwise the owner URL's. The password is never printed.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const APP_GROUP = "cairnmcp_app";
const LOGIN_ROLE = process.env["CAIRNMCP_APP_LOGIN_ROLE"] ?? "cairnmcp_server";
const envFile = resolve(import.meta.dirname, "../../..", process.argv[2] ?? ".env.local");

const ownerUrl = process.env["CAIRNMCP_DATABASE_OWNER_URL"] ?? process.env["DATABASE_URL_UNPOOLED"];
if (!ownerUrl) {
  console.error("Set CAIRNMCP_DATABASE_OWNER_URL (or Neon's DATABASE_URL_UNPOOLED) to the owner role's direct URL.");
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(LOGIN_ROLE)) throw new Error("invalid role name");

const password = randomBytes(32).toString("base64url");
const client = new pg.Client({ connectionString: ownerUrl });
await client.connect();
try {
  await client.query("BEGIN");
  const exists = async (role: string) => ((await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount ?? 0) > 0;
  if (!(await exists(APP_GROUP))) await client.query(`CREATE ROLE ${APP_GROUP} NOLOGIN NOBYPASSRLS`);
  const verb = (await exists(LOGIN_ROLE)) ? "ALTER" : "CREATE";
  // Rotation changes only the password: naming NOBYPASSRLS in ALTER needs BYPASSRLS itself. The check below still holds.
  const attributes = verb === "CREATE" ? "LOGIN NOBYPASSRLS" : "LOGIN";
  await client.query(`${verb} ROLE ${LOGIN_ROLE} ${attributes} PASSWORD ${client.escapeLiteral(password)}`);
  const { rowCount } = await client.query("SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE g.rolname = $1 AND u.rolname = $2", [APP_GROUP, LOGIN_ROLE]);
  if (!rowCount) {
    try {
      await client.query(`GRANT ${APP_GROUP} TO ${LOGIN_ROLE}`);
    } catch (e) {
      // Happens when another role created the group: only roles with ADMIN on it may grant it.
      if ((e as { code?: string }).code === "42501") {
        throw new Error(`${APP_GROUP} was created by another role; have an admin run: GRANT ${APP_GROUP} TO current_user WITH ADMIN OPTION`, { cause: e });
      }
      throw e;
    }
  }
  // Refuse a login role that could bypass row-level security (e.g. one made in a provider's console).
  const { rows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1", [LOGIN_ROLE]);
  if (rows[0]?.rolsuper || rows[0]?.rolbypassrls) throw new Error(`${LOGIN_ROLE} can bypass row-level security; drop it and re-run`);
  await client.query("COMMIT");
  console.log(`${verb === "CREATE" ? "Created" : "Rotated the password of"} ${LOGIN_ROLE} (member of ${APP_GROUP}).`);
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await client.end();
}

const appUrl = new URL(process.env["DATABASE_URL"] ?? ownerUrl);
appUrl.username = LOGIN_ROLE;
appUrl.password = password;
const line = `CAIRNMCP_DATABASE_URL="${appUrl.toString()}"`;
const current = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
const next = /^CAIRNMCP_DATABASE_URL=.*$/m.test(current)
  ? current.replace(/^CAIRNMCP_DATABASE_URL=.*$/m, line)
  : `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`;
writeFileSync(envFile, next, { mode: 0o600 });
console.log(`Wrote CAIRNMCP_DATABASE_URL (${appUrl.host}) to ${envFile}.`);
