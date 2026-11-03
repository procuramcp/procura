import { defineConfig } from "vitest/config";

// The tenant isolation and MCP endpoint tests need Postgres (a superuser URL in
// PROCURA_TEST_DATABASE_URL). Warn here, in the main process, because console
// output from test files can be hidden. In CI a missing URL fails those tests.
if (!process.env["PROCURA_TEST_DATABASE_URL"] && !process.env["CAIRNMCP_TEST_DATABASE_URL"] && !process.env["CI"]) {
  console.warn(
    "\n⚠ PROCURA_TEST_DATABASE_URL is not set: skipping the Postgres tests, so tenant isolation is NOT being tested. See packages/db/README.md.\n",
  );
}

export default defineConfig({
  test: {
    // packages/web is a browser app with its own Vite config and no unit tests (D-033).
    projects: ["packages/*", "!packages/web"],
  },
});
