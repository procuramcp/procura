# AGENTS.md

A map of this repo for coding agents: where things live, which helpers already exist, and the
rules the code follows. Read this before searching. When you add a package, a shared helper, or
a new kind of file, update this map in the same change.

cairnmcp turns an API description (OpenAPI) into a curated set of tools served as a remote MCP
server. One Node process serves the OAuth authorization server, the MCP endpoint, and the curation
console. Why things are the way they are: `docs/DECISIONS.md`, cited in code as `D-0xx`.

## Commands

Node ≥ 22.18 runs the TypeScript directly; there is no build step except the web console.
If `node -v` is older, use `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` (macOS dev box).

| Task | Command |
| --- | --- |
| Typecheck everything | `pnpm typecheck` |
| All tests | `pnpm test` |
| One package's tests | `pnpm vitest run packages/<name>` |
| One test file | `pnpm vitest run packages/db/src/repo.test.ts` |
| Both | `pnpm check` |
| Build the console | `pnpm --filter @cairnmcp/web build` |
| Run the console locally with fake data | `CAIRNMCP_TEST_DATABASE_URL=postgres://$USER@localhost:5432/postgres pnpm --filter @cairnmcp/server dev:console` (http://localhost:8787/app/) |
| Migrate a database | `pnpm --filter @cairnmcp/db migrate` (owner role) |

The Postgres tests (`db`, `mcp`, `auth`, `server`) skip unless `CAIRNMCP_TEST_DATABASE_URL` is
a superuser URL; each test file creates and drops its own database. A local Postgres works:
`CAIRNMCP_TEST_DATABASE_URL=postgres://$USER@localhost:5432/postgres`. CI always runs them.

## Packages (lowest first; each may import only those above it)

| Package | What it is | Key files |
| --- | --- | --- |
| `core` | The IR (Zod), access rules, pure helpers. No I/O, clock, or randomness (`purity.test.ts` enforces it). | `src/ir/*` (one file per IR part), `src/access.ts`, `src/util.ts`, `src/time.ts` |
| `http` | Web-standard `Request`/`Response` helpers shared by `auth`, `mcp`, `server`. | `src/responses.ts`, `src/body.ts`, `src/cookies.ts`, `src/crypto.ts`, `src/router.ts` |
| `console-api` | The console API contract: every request body and response type, shared by `server` and `web`. Types only, no imports (no Node, DOM, or Zod types). | `src/index.ts` |
| `ingest` | OpenAPI 3.0/3.1 → IR. | `src/openapi/map-openapi.ts` (entry), `schema.ts` (schema conversion), `security.ts`, `refs.ts`, `naming.ts` |
| `vault` | Envelope-encrypted upstream credentials. | `src/vault.ts`, `src/credentials.ts`, `src/key-wrapper.ts`, `src/store.ts` |
| `runtime` | Runs one tool call: validation, auth, egress rules, throttling, audit. | `src/runtime.ts` (`invoke`), `request.ts`, `egress.ts`, `auth.ts`, `limiter.ts` |
| `db` | Postgres with RLS: tenants, sources, toolsets, access, vault and audit storage. | `migrations/*.sql` (source of truth), `src/schema.ts` (Drizzle view), `src/repo.ts` (all tenant queries), `src/client.ts` (`Database`), `src/stores.ts`, `src/errors.ts` |
| `mcp` | The MCP endpoint `/mcp/{tenant}/{toolset}`: OAuth resource server. | `src/handler.ts`, `src/cache.ts` (`ToolsetCache`), `src/limits.ts` (plan limits), `src/token.ts`, `src/results.ts` |
| `auth` | Embedded OAuth 2.1 authorization server under `/oauth`. | `src/handler.ts` (all endpoints + route table), `identity.ts` (OIDC), `keys.ts`, `pages.ts`, `redirect.ts` |
| `server` | The app: wires everything, the console API, the admin CLI. | `src/app.ts`, `src/console/*`, `src/admin.ts`, `src/fetch-document.ts`, `scripts/serve.ts`, `scripts/admin.ts` |
| `web` | The console UI (React, shadcn/ui), built to static files served at `/app`. | `src/lib/api.ts` (every API call; types from `console-api`), `src/lib/act.ts`, `src/lib/hooks.ts`, `src/pages/*` |
| `eval` | Offline ingest eval over a corpus of public API descriptions. | `src/ingest-eval.ts`, `corpus/` |

`examples/intervals-icu` calls a real API through the whole pipeline. `deploy/` holds the Oracle
VM (Docker Compose + Caddy) and Auth0 (Terraform, not OpenTofu) setups.

### The console (`packages/server/src/console/`)

| File | Owns |
| --- | --- |
| `index.ts` | `createConsoleHandler`: CSRF check, session, `/me`, `/logout`, dispatch to the route tables, static files |
| `context.ts` | `ConsoleContext`, `ApiRequest`, `asTeam` / `teamResponse` (minimum team role inside the tenant: viewer, editor, admin, owner; D-038), `endpointUrl` |
| `tenants.ts` | `GET /tenants/:t`, `POST /tenants/:t/toolsets` |
| `toolsets.ts` | `GET`/`PUT /tenants/:t/toolsets/:id`, `PUT …/access`, `POST …/test` |
| `access.ts` | `GET /tenants/:t/access` (profiles, team, customer count), `PUT`/`DELETE …/profiles/:id` |
| `people.ts` | `GET …/customers` (search, paging), `PUT …/members/:user/role`, `PUT`/`DELETE …/members/:user` (suspend, note, remove), `PUT …/members/:user/profiles` |
| `sources.ts` | `POST …/sources/preview`, `POST …/sources`, `GET …/sources/:id`, `PUT …/side-effects` (a person's classifications), `PUT`/`DELETE …/credentials/:scheme` |
| `sign-in.ts` | Browser sign-in through OIDC, session cookies, `purgeExpiredConsoleState` |
| `bodies.ts` | Zod schemas for request bodies, `readBody`, `issuesText`, size limits; `BodiesMatchContract` checks them against the contract |
| `views.ts` | Operations and auth schemes as contract types (`OperationView`, `AuthSchemeView`) |
| `static.ts` | Serving `packages/web/dist`, the plain error `page()` |

## Helpers that already exist (don't write another)

| Need | Use |
| --- | --- |
| Is it a plain object? | `isRecord` (core) |
| Drop `undefined` keys for optional props | `omitUndefined` (core) |
| Slug from text, cut text | `slugify`, `truncate` (core) |
| `Date` → `Instant` | `instantOf` (core); never format ISO strings by hand |
| Count read/write/destructive | `countBySideEffect` (core) |
| A person's classification; POSTs that look like reads | `curateSideEffect`, `suggestRead` (core `side-effect.ts`) |
| Can this level call this tool? | `canCall`, `allowsTool`, `highestLevel` (core `access.ts`) |
| A call's plan limits (most generous rule) | `callLimits`, `PlanLimits` (core `access.ts`) |
| Count a call against allowances, refund it, show usage | `takeAllowance`, `refundAllowance`, `usageFor`, `usagePeriods` (db); the MCP side is `withinLimits` (mcp `limits.ts`) |
| Team role at least X? Roles, statuses | `hasTeamRole`, `MemberRole`, `TeamRole`, `MemberStatus` (core `access.ts`); `useRole` in web `lib/hooks.ts` |
| Id schemas | `TenantId`, `UserId`, `SourceId`, `ToolsetId`, `ProfileId`, `OperationId`, `ToolName` (core `ir/ids.ts`) |
| JSON / redirect response | `json`, `redirect`, `withHeaders` (http) |
| Read a body with a size cap | `readText`, `readJson`, `readForm` (http); they throw `BodyError` |
| Cookies | `readCookie`, `setCookie` (http) |
| Random secret, hashes, constant-time compare | `randomToken`, `sha256Hex`, `sha256Base64url`, `safeEqual` (http) |
| Route table | `dispatch` + `Route<C>` (http) |
| Console request/response types | `@cairnmcp/console-api`; never re-declare them in `web` or `server` |
| Postgres error code (FK, unique) | `pgErrorCode(e) === PG.FOREIGN_KEY_VIOLATION` (db) |
| Toolset plus its source | `getToolsetWithSource` (db) |
| Source ids / names and counts / per-operation side effects | `listSourceIds`, `listSourceSummaries`, `listOperationEffects` (db): no IR parse |
| Team, customers, tenant name, add-if-missing | `listTeam`, `listCustomers` (search, keyset paging), `getMember`, `setMemberRole`, `updateMember`, `tenantName`, `ensureMember` (adds a customer) (db) |
| Has a toolset or its source changed? | `toolsetVersion` (db) |
| Replace / delete a scheme's credential | `vault.replaceCredential`, `vault.deleteSchemeCredentials` |
| Credential kinds a scheme accepts | `credentialKindsFor` (vault) |
| Ingest OpenAPI for storage | `mapSource` (server `admin.ts`), which wraps `ingestOpenApiText` |
| Console action with busy flag + error toast | `act` (web `lib/act.ts`) |
| Load data in a page | `useLoad` (web `lib/hooks.ts`) |
| Test doubles | `@cairnmcp/db/test-support` (scratch DB, `newTenant`, `intervalsIr`), `server/src/test-support.ts` (fake OIDC provider, `TestBrowser`), `runtime/src/test-support.ts` (`fakeFetch`), `core/src/ir/test-helpers.ts` |

## Rules the code follows

- **Imports** end in `.ts`; packages import each other by name (`@cairnmcp/core`), never by path.
  New workspace deps use `"workspace:*"`; external deps use caret ranges (`^1.2.3`).
- **Strict TypeScript**: `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on. For an
  optional property that may be undefined, use `omitUndefined({...})` or a conditional spread.
- **Ids are branded Zod types.** Parse at the boundary (`TenantId.parse`), pass the brand inside.
- **`core` stays pure**: no `node:*`, `Date.now()`, the `Date` constructor with no arguments,
  `Math.random`, or `process`. Callers pass the time in.
- **Tenant data only through `db.withTenant(tenantId, tx => …)`**: RLS scopes every query. Repo
  functions take that `tx` and write `tenant_id` from the transaction. Global tables (OAuth,
  console sessions) use `withoutTenant`.
- **Migrations are append-only**: add `packages/db/migrations/NNNN_name.sql`, then mirror new
  columns in `src/schema.ts`. Never edit an applied migration (the migrator refuses).
- **`listSources` / `getSource` load and Zod-parse whole IR documents** (slow for big APIs). Use
  the lighter repo queries when they are enough.
- **Who's in a tenant is one `memberships` row** with a role (owner, admin, editor, viewer: the team;
  customer: tools only) and a status (D-038). Check access with `memberRole`, which treats suspended
  people as non-members, so a suspension applies everywhere at once.
- **The MCP endpoint caches resolved toolsets** by `toolsetVersion`. Anything that changes a
  toolset or source must write its row (the `putToolset` / `putSource` upserts do), or the
  cache won't notice. Access and membership are never cached.
- **Token hashes keep their table's encoding**: OAuth tables store `sha256Hex`, console tables
  `sha256Base64url`. Changing one invalidates live sessions.
- **Secrets** are `Secret` objects (vault) that print `[redacted]`; call `.reveal()` only where
  the value leaves the process. Never log or echo credentials, tokens, or full upstream URLs.
- **Errors for agents** come back as tool results (`RuntimeFailure` → `{ ok: false, error }`),
  with a message that says what to do. Expected failures never throw out of `Runtime.invoke`.
- **Tests sit next to the code** (`foo.test.ts`). New behavior gets a test; Postgres behavior gets a
  test that runs against the real database (`describe.skipIf(!adminUrl)`).
- **Comments** say why, briefly; cite decisions as `D-0xx`. A new decision gets an entry in
  `docs/DECISIONS.md`.
- **Never commit** `.env*`, `*.tfstate`, `*.tfvars`, or real API data. Fixtures are synthetic or public.

## Recipes

**Add a console API endpoint.** Declare its body and response types in
`packages/console-api/src/index.ts` (the one contract both sides use). Add a route to the area's
table in `server/src/console/*.ts`: `{ method, path: /^\/tenants\/([^/]+)\/…$/, handle: (api, [tenant, …]) => … }`.
Parse the body with `readBody(api.request, Schema)` (schema in `bodies.ts`, plus an `Accepts<…>`
line in `BodiesMatchContract`), run tenant work in `teamResponse(api, tenant, "editor", (tx, tenantId) => …)` (the least role that may do it),
and return `json(200, { … } satisfies TheView)` so the server is checked against the contract.
Then add the call to `web/src/lib/api.ts` using the contract types, and a test in
`server/src/console.test.ts`.

**Add a tenant table.** New migration with `tenant_id`, RLS policy, and grants like
`0005_access_profiles.sql`; add it to `db/src/schema.ts` (and `allTables`); add queries to
`db/src/repo.ts`; the isolation tests in `db/src/isolation.test.ts` show what to cover.

**Add an IR field.** Change the Zod schema in `core/src/ir/*`; if it breaks stored IR, bump
`IR_VERSION`; set it in `ingest/src/openapi/map-openapi.ts`; update `docs/IR.md`.

**Add a package.** `packages/<name>/` with `package.json` (`"exports": { ".": "./src/index.ts" }`,
a `typecheck` script), `tsconfig.json` extending `../../tsconfig.base.json`, and
`vitest.config.ts` (`defineProject({ test: { name } })`). Run `pnpm install`, then add it to the
tables above and to the README.

## Docs

`docs/IR.md` (the IR, start here), `docs/USER-STORIES.md` (who it's for, story ids like P-13),
`docs/DECISIONS.md` (D-001…D-044, the why), `docs/ROADMAP.md`, `docs/sources/*` (per-API findings), and READMEs in `packages/{auth,db,mcp,server,web}`
and `deploy/{oracle,auth0}`.
