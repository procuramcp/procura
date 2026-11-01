import { defineProject } from "vitest/config";

// Postgres tests create a scratch database each; give slow CI machines room.
export default defineProject({ test: { name: "mcp", testTimeout: 20_000, hookTimeout: 60_000 } });
