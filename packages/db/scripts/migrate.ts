// Apply pending migrations. Needs the owner role's URL, not the app's.
// Run: CAIRNMCP_DATABASE_OWNER_URL=postgres://… pnpm --filter @cairnmcp/db migrate
import { migrate } from "../src/migrate.ts";

const url = process.env["CAIRNMCP_DATABASE_OWNER_URL"];
if (!url) {
  console.error("CAIRNMCP_DATABASE_OWNER_URL is not set (the owner role's connection URL).");
  process.exit(1);
}
const { applied, alreadyApplied } = await migrate(url);
console.log(applied.length === 0 ? `Up to date (${alreadyApplied.length} applied).` : `Applied: ${applied.join(", ")}`);
