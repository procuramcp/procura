# cairnmcp

A cairn marks the safe path on a trail. cairnmcp marks the safe path from APIs to agents: it
ingests an API description, curates a safe set of operations, and serves them as a remote
MCP server, on our hosting or yours.

Status: milestone 1 in progress. The IR and the OpenAPI ingestor are done; the runtime and vault
are next. Hosted first; self-hosting with one container image follows (see the roadmap).

## Layout

| Package | Purpose | Status |
| --- | --- | --- |
| `packages/core` | The IR (Zod), side-effect rules, toolset resolution. Pure: no I/O, no clock. | ✅ |
| `packages/ingest` | API description → IR. OpenAPI 3.0/3.1 now; GraphQL, Postman/HAR/curl, docs later. | OpenAPI ✅ |
| `packages/eval` | Offline eval of the ingestor over a corpus of public API descriptions. | ✅ |
| `packages/db`, `runtime`, `api`, `mcp`, `web`, `backtest` | Added with their milestones | — |

Key docs: [`docs/IR.md`](docs/IR.md) (start here), [`docs/ROADMAP.md`](docs/ROADMAP.md),
[`docs/DECISIONS.md`](docs/DECISIONS.md).

## Develop

Requires Node ≥ 22.18 and pnpm 10.

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

## Data and secrets

Never commit secrets, `.env` files, or real training/wellness data. Fixtures are synthetic or
public API descriptions. Analyzer output is training-load guidance, not medical advice.
