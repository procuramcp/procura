import { defineProject } from "vitest/config";

// Postgres tests read a superuser URL from CAIRNMCP_TEST_DATABASE_URL. Warn here
// (in the main process) because console output from test files can be hidden.
if (!process.env["CAIRNMCP_TEST_DATABASE_URL"] && !process.env["CI"]) {
  console.warn(
    "\n⚠ CAIRNMCP_TEST_DATABASE_URL is not set: skipping the Postgres tests, so tenant isolation is NOT being tested. See packages/db/README.md.\n",
  );
}

// Database tests create a scratch database each; give slow CI machines room.
export default defineProject({ test: { name: "db", testTimeout: 20_000, hookTimeout: 60_000 } });
