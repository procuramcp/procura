# cairnmcp

A cairn marks the safe path on a trail. cairnmcp marks the safe path from APIs to agents: it
ingests an API description, curates a safe set of operations, and serves them as a remote
MCP server, on our hosting or yours.

Status: milestone 1 done (IR, OpenAPI ingestor, vault, runtime, a live call to Intervals.icu as the
first example API).
Milestone 2 (tenancy, MCP server with OAuth, container image) is next. Hosted first; self-hosting with one container image follows (see the roadmap).

## Layout

| Package | Purpose | Status |
| --- | --- | --- |
| `packages/core` | The IR (Zod), side-effect rules, toolset resolution. Pure: no I/O, no clock. | ✅ |
| `packages/ingest` | API description → IR. OpenAPI 3.0/3.1 now; GraphQL, Postman/HAR/curl, docs later. | OpenAPI ✅ |
| `packages/eval` | Offline eval of the ingestor over a corpus of public API descriptions. | ✅ |
| `packages/vault` | Envelope-encrypted credential storage (per-tenant data keys, master key or KMS). | ✅ |
| `packages/runtime` | Runs a tool call: input validation, auth, egress rules, throttling, audit. | ✅ |
| `packages/db` | Postgres with row-level security: tenants, members and toolset access, sources, toolsets, vault and audit storage. | ✅ |
| `packages/mcp` | The MCP endpoint: an OAuth resource server serving each toolset with per-member access. | Resource server ✅ |
| `packages/api`, `web` | Added with their milestones | — |

Key docs: [`docs/IR.md`](docs/IR.md) (start here), [`docs/ROADMAP.md`](docs/ROADMAP.md),
[`docs/DECISIONS.md`](docs/DECISIONS.md), [`docs/sources/`](docs/sources/) (per-API findings).

## Develop

Requires Node ≥ 22.18 (Node 24 LTS recommended; `.nvmrc` pins it) and pnpm 10. Scripts run
TypeScript directly, which older Node versions can't do; `pnpm install` refuses to run on them.

```bash
pnpm install
```

```bash
pnpm check
```

```bash
pnpm ir:dump
```

`pnpm check` runs typecheck and tests. `pnpm ir:dump` writes the Intervals.icu IR and its
diagnostics to `out/` (gitignored).

## Examples

`examples/intervals-icu/` calls Intervals.icu with your own API key, through the whole pipeline.
Copy its `.env.example` to `.env` in that folder, set `INTERVALS_API_KEY`, then run
`pnpm example:intervals`. It only reads, and prints a summary.

## Data and secrets

Never commit secrets, `.env` files, or real personal data from any API. Fixtures are synthetic
or public API descriptions.

cairnmcp returns each API's output as-is. It doesn't analyze or interpret data; that belongs to
whatever agent or app consumes the tools.
