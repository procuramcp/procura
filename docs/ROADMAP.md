# Roadmap

Milestones from the planning handoff, with status. Numbers are stable: other docs refer to
them, so new work gets a letter suffix (e.g. 2b) instead of renumbering.

| | Milestone | Status |
| --- | --- | --- |
| 1 | IR, OpenAPI ingestor, runtime, vault; single tenant; Intervals.icu end to end | IR ✅ · OpenAPI ingestor ✅ · runtime ✅ · vault ✅ · live Intervals.icu call ⏳ (`pnpm try:intervals`, needs a real key) |
| 2 | Tenancy (RLS plus isolation tests), MCP server with OAuth; the app container image and our hosted deployment of it | — |
| 2b | Self-host: published image, `docker compose`, config and upgrade docs | — |
| 3 | Curation UI, side-effect classification review, egress hardening | — |
| 4 | GraphQL ingestor | — |
| 5 | Docs-page ingestor with the verification loop (experimental) | — |
| 6 | Analyzer tool pack: detector, backtest, `get_recent_flags`, `explain_flag` | — |
| 7 | Docs: architecture diagram, threat model, decisions doc, eval report | Ingest eval started (`packages/eval`) |
| — | Hybrid runner: hosted control plane, credential-holding runner in the user's infra | Parked until users ask (D-018) |

## Milestone 2b: self-host

Done when someone can run their own cairnmcp with only Docker, a Postgres URL, and a master key:

- The same container image we deploy, published with version tags.
- A `docker compose` file (app and Postgres) that works out of the box on a laptop.
- `.env.example` documenting every setting; the app validates its config at startup and refuses
  to start with a clear message if something required is missing.
- Docs for running behind a domain with TLS, setting up OAuth for the MCP endpoint, backups, and
  upgrades (including database migrations).
- CI builds the image and runs the compose setup through a smoke test.
