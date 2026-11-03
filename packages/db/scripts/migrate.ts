// Apply pending migrations. Needs the owner role's URL on a direct (not pooled)
// host: the migrator holds a session advisory lock.
// Run: pnpm --filter @procura/db migrate (reads the repo's .env.local if present)
import { acceptLegacyEnvNames } from "../src/legacy-env.ts";
import { migrate } from "../src/migrate.ts";

acceptLegacyEnvNames();

// Neon's env pull names the owner's direct URL DATABASE_URL_UNPOOLED.
const url = process.env["PROCURA_DATABASE_OWNER_URL"] ?? process.env["DATABASE_URL_UNPOOLED"];
if (!url) {
  console.error("Set PROCURA_DATABASE_OWNER_URL (or Neon's DATABASE_URL_UNPOOLED) to the owner role's direct connection URL.");
  process.exit(1);
}
const { applied, alreadyApplied } = await migrate(url);
console.log(applied.length === 0 ? `Up to date (${alreadyApplied.length} applied).` : `Applied: ${applied.join(", ")}`);
