# procura

A procura (Italian, Spanish, Portuguese) is a power of attorney: the authority to act on someone's
behalf, within set limits. procura gives agents that for APIs: it ingests an API description,
curates a safe set of operations, and serves them as a remote MCP server, on our hosting or yours.
(It was called cairnmcp until D-047.)

It's built for API providers: one MCP server for all of a provider's customers, with different
tools and limits per plan and usage it can bill for. Anyone can also host a server for their own
key. See [`docs/USER-STORIES.md`](docs/USER-STORIES.md).

Status: the pipeline, tenancy, the MCP endpoint with OAuth, and the curation console are built and
deployed; provider features (plans, limits, customer sign-in, usage) are next. See the
[roadmap](docs/ROADMAP.md).

## Layout

| Package | Purpose | Status |
| --- | --- | --- |
| `packages/core` | The IR (Zod), side-effect rules, toolset resolution. Pure: no I/O, no clock. | ✅ |
| `packages/http` | Request/response helpers shared by the servers: bodies, cookies, tokens, routing. | ✅ |
| `packages/console-api` | The console API contract: request and response types shared by the server and the web console. | ✅ |
| `packages/ingest` | API description → IR. OpenAPI 3.0/3.1 now; GraphQL, Postman/HAR/curl, docs later. | OpenAPI ✅ |
| `packages/eval` | Offline eval of the ingestor over a corpus of public API descriptions. | ✅ |
| `packages/vault` | Envelope-encrypted credential storage (per-tenant data keys, master key or KMS). | ✅ |
| `packages/runtime` | Runs a tool call: input validation, auth, egress rules, throttling, audit. | ✅ |
| `packages/db` | Postgres with row-level security: tenants, members and toolset access, sources, toolsets, vault and audit storage. | ✅ |
| `packages/mcp` | The MCP endpoint: an OAuth resource server serving each toolset with per-member access. | ✅ |
| `packages/auth` | The embedded OAuth authorization server: client registration, sign-in through OIDC providers, consent, tokens. | ✅ |
| `packages/server` | The app: authorization server and MCP endpoint in one process, configured from the environment. | ✅ |
| `packages/web` | The curation console (React), served by the server at `/app`. | ✅ |

Working in the code (or pointing an agent at it): [`AGENTS.md`](AGENTS.md) maps where things live
and which helpers already exist. Key docs: [`docs/IR.md`](docs/IR.md) (start here), [`docs/USER-STORIES.md`](docs/USER-STORIES.md), [`docs/ROADMAP.md`](docs/ROADMAP.md),
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

## Self-host

Run your own with Docker: [`deploy/self-host`](deploy/self-host/README.md) has a Compose setup
(the app, Postgres, and a local sign-in provider for trying it on a laptop) and the guide for
HTTPS, sign-in, backups, and upgrades. The image is `ghcr.io/procuramcp/procura`.

## Licence

[AGPL-3.0](LICENSE) (D-046): use, change, and host it freely; if you let others use a changed
copy over a network, offer them its source.

## Data and secrets

Never commit secrets, `.env` files, or real personal data from any API. Fixtures are synthetic
or public API descriptions.

procura returns each API's output as-is. It doesn't analyze or interpret data; that belongs to
whatever agent or app consumes the tools.
