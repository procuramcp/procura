# Decisions

Short entries: decision, why, alternatives rejected. Newest last. "Settled" decisions from the
planning handoff are not repeated here unless implementation added something.

## D-001 Zod 4 for the IR; JSON Schema 2020-12 for operation schemas

- **Decision:** IR types are Zod 4 schemas (`packages/core/src/ir`). Operation input/output
  schemas are plain JSON Schema 2020-12 objects stored inside the IR.
- **Why:** Zod gives runtime validation at every boundary and static types from one definition.
  2020-12 is the default dialect for MCP tool schemas (protocol 2025-11-25) and OpenAPI 3.1, so
  the IR's schemas can be served as-is.
- **Rejected:** Converting API schemas into Zod (lossy, can't be stored as data); keeping the
  OpenAPI 3.0 dialect (`nullable`, boolean `exclusiveMinimum`) and converting at serve time
  (every consumer would need to know OpenAPI).

## D-002 Operation schemas are self-contained

- **Decision:** Each operation's `input` and `output` carries its own `$defs`. Refs always point
  to `#/$defs/...`; the IR schema rejects anything else.
- **Why:** The runtime and MCP layers can use an operation without the source document. Recursive
  types work without inlining.
- **Cost:** Shared components are repeated per operation. The Intervals.icu IR is ~0.9 MB as
  compact JSON (148 operations). Fine in Postgres `jsonb`.
- **Rejected:** A shared schema registry on `Source` (smaller, but every consumer must resolve
  refs across objects); full inlining (breaks on recursion, much larger).

## D-003 Tool input shape: one property per parameter, plus `body`

- **Decision:** Input is a flat object: one property per path/query/header/cookie parameter, and
  the request body under `body`. `mapping.parameters` / `mapping.body` say where each goes.
  Collisions get a location prefix (`query_petId`). `additionalProperties: false`.
- **Why:** Flat inputs are easiest for models. Explicit bindings mean the runtime never guesses.
- **Rejected:** Flattening body fields into the top level (collides with parameters, hides which
  fields are wire parameters); nested `{ path, query, body }` (harder for models to fill in).

## D-004 The IR is tenant-agnostic

- **Decision:** `IrDocument` and `Toolset` carry no `tenant_id`. Tenancy lives in the storage layer
  (every table has `tenant_id`; RLS enforces it).
- **Why:** One ingested source can back demo toolsets and several tenants' toolsets. Keeps `core`
  free of storage concerns.

## D-005 Side-effect classification: method default, escalate-only heuristics

- **Decision:** Start from HTTP semantics (GET read, POST/PUT/PATCH write, DELETE destructive).
  Name/path words can only escalate (e.g. `PUT …/delete-intervals` → destructive). Only a human
  (`basis: "curated"`) can rate an operation below its method default; the IR schema enforces it.
- **Why:** A wrong "safe" label is far worse than a wrong "dangerous" one. Escalations are rare
  and reviewable (2 of 148 on Intervals.icu).
- **Rejected:** An LLM classifier at ingest (non-deterministic, could downgrade).

## D-006 Confidence rubric for spec-derived operations

- **Decision:** Base 0.9, minus 0.1 each for: no output schema, wildcard media type, an assumed
  parameter; minus 0.2 for a multipart/binary body; floor 0.3. Only `verified` operations may
  reach 1.0 (enforced). See `OPENAPI_CONFIDENCE`.
- **Why:** A spec can be wrong, so it never earns full confidence alone. The rubric is simple
  enough to explain in the curation UI. Expected to be revised once the verification loop exists.

## D-007 Unsatisfiable auth conjunctions become alternatives

- **Decision:** When one OpenAPI security requirement ANDs two schemes that both use the
  `Authorization` header (basic, bearer, OAuth, OIDC), it is split into alternatives with a
  warning.
- **Why:** Intervals.icu declares `[{ APIKey: [], AccessToken: [] }]`, which literally means
  "basic AND bearer", which is impossible. The intent is clearly "either".

## D-008 Tool and operation names: `^[a-z][a-z0-9_]{0,63}$`

- **Why:** Fits both MCP (SEP-986: `^[A-Za-z0-9._-]{1,128}$`, checked against SDK 1.32.2) and
  the Claude API (`^[a-zA-Z0-9_-]{1,64}$`), in one consistent style.

## D-009 No build step for internal packages

- **Decision:** Packages export their TypeScript source (`exports: ./src/index.ts`) and use
  explicit `.ts` import extensions with `erasableSyntaxOnly`. Node ≥ 22.18 runs them directly
  (type stripping); Vitest runs tests; `tsc --noEmit` typechecks. Deployable apps (MCP server,
  web) will bundle.
- **Rejected:** Project references with emitted `dist/` (slower loop, stale-build bugs).

## D-010 Date/time convention

*Narrowed by D-021: `LocalDate` was removed with the analyzer.*

- **Decision:** `Instant` = UTC ISO-8601 ending in `Z`, a branded Zod type
  (`packages/core/src/time.ts`), for audit, ingest, and credential-expiry timestamps.
- **Why:** One unambiguous representation for points in time; the type stops a local or
  offset timestamp from slipping in.

## D-011 `core` purity is enforced, not just intended

- **Decision:** `core` compiles with `types: []` (no Node or DOM types), so `node:*` imports,
  `fetch`, and timers fail to typecheck. A test scans `core/src` for `Date.now()`, `new Date()`,
  `Math.random()`, `process.`, and I/O imports.

## D-012 TypeScript 7

- **Decision:** Use TypeScript 7.0.2 (latest stable, native compiler).
- **Risk:** Tools that use the TypeScript JS API (typescript-eslint, some Next.js tooling) may lag.
  If one blocks us, pin that package's TypeScript separately or fall back to 5.9; nothing in the
  code depends on 7-only features.

## D-013 Intervals.icu fixture sourced from an npm snapshot

- **Decision:** The test fixture came from the `intervals-icu-api@0.4.0` package, not from
  intervals.icu directly (unreachable from the build sandbox). Provenance and SHA-256 are in
  `packages/ingest/fixtures/intervals-icu/PROVENANCE.md`.
- **Follow-up:** Refresh from `https://intervals.icu/api/v1/docs` and re-run tests.

## D-014 Base URLs must be https in the IR

- **Decision:** `Source.baseUrl` must be `https:` with no credentials, query, fragment, or
  trailing slash. Local integration tests inject a fake transport instead of using `http:`.
- **Why:** Removes a whole class of downgrade mistakes. Full egress policy (private ranges,
  DNS rebinding, redirects) is a runtime concern (milestone 3).

## D-015 Toolsets pin inputs; structural issues fail the whole toolset

*Policy checks in the original version were removed by D-016.*

- **Decision:** A tool binding can pin input values (hidden from the agent), e.g. Intervals.icu
  athlete `id`. `resolveToolset` returns either all tools or a list of issues, never a partial set.
- **Why:** Pinning narrows what an agent can reach. Failing closed on structural issues (unknown
  operation, pin for a missing input) means a broken edit can't quietly serve a different set of
  tools than the one reviewed.

## D-016 Self-service hosting; read-only is the only default restriction

- **Decision:** Self-service hosting is in scope (replacing the handoff's "no public signup / no
  strangers' credentials" non-goal), starting with one user. The product goal is to make hosting an
  MCP server as easy as possible; cairnmcp's job is to make it secure and to offer throughput
  settings. A new toolset enables only read operations (`defaultToolset`). That is the only
  restriction: users can enable any write, destructive, or unverified tool directly, with no
  further opt-in. `ToolsetPolicy` and its checks are removed; each tool's `enabled` flag is the
  only switch.
- **Why:** Gates add friction and duplicate what MCP clients already do with tool annotations.
  Read-only is a sensible starting point until there is user feedback.
- **Unchanged:** Side-effect labels and the rule that heuristics can't downgrade them (D-005).
  They now inform users and clients instead of blocking anything. Credential encryption, tenant
  isolation, the audit log of writes, and egress hardening protect users without restricting them.
- **Consequence:** Storing other people's upstream credentials makes the vault, envelope
  encryption, and isolation tests critical. The threat model (milestone 7) must cover them.
- **Open:** Which throughput settings to expose. Current plan: automatic limits from upstream hints
  and `Retry-After`/rate-limit headers, a few advanced settings (requests per minute, concurrency,
  read cache time), and metrics to judge whether more are worth adding.

## D-017 Ingest eval corpus is a fixed, redistributable snapshot

- **Decision:** `packages/eval/corpus/manifest.json` pins a vendored corpus by URL, license,
  SHA-256, and retrieval date. `pnpm eval:ingest` runs offline and writes a deterministic report
  to `docs/eval/`; `pnpm --filter @cairnmcp/eval corpus:fetch` refreshes it.
- **Corpus choice:** 13 documents, chosen for variety over volume: OpenAPI 3.0 and 3.1, JSON and
  YAML, hand-written and generated (no single generator for more than two entries), small
  reference examples to large real APIs (OpenAI, Box, Discord, Twilio), a 3.1 document with only
  webhooks, and one tiny Swagger 2.0 document to check rejection. Only redistributable licenses
  (MIT, Apache-2.0, CC0, CC BY 4.0 with attribution in `notes`). The Intervals.icu fixture is
  reused by path and marked `refetch: false` so refreshing never overwrites it.
- **Validity check:** schemas must compile under Ajv 2020 with unknown keywords rejected. Ajv's
  style lints (`strictTypes`, `strictRequired`) are off because they reject valid schemas.
- **Rejected:** Pulling a large share of APIs.guru (skews toward one conversion pipeline, and
  repository bloat); fetching at eval time (non-deterministic, needs network in CI).

## D-018 Hosting: one container image, hosted first, self-host next

- **Decision:** The MCP server, runtime, vault, and GraphQL API ship as one Node container image.
  We run our hosted deployment from that image on a container platform; the web UI (Next.js) stays
  on Vercel. Self-hosting uses the same image with `docker compose` (milestone 2b, right after
  tenancy and OAuth exist).
- **Requirements kept minimal:** Postgres and a master key (or a KMS) are the only required
  dependencies. Redis, Neon, and Vercel are choices for our deployment, not dependencies of the
  code. All configuration is environment variables validated with Zod at startup.
- **Why a container rather than serverless functions:** MCP sessions, streaming responses, and
  per-tenant throttling are simpler in a long-running process, and a container platform can give
  a stable egress IP, which matters for upstreams that rate-limit per IP (Intervals.icu). The
  same image is then the self-host artifact for free.
- **Why offer self-hosting:** users' upstream credentials never leave their infrastructure, they
  don't share our egress IP or quotas, and it keeps the architecture honest about its adapter
  boundaries.
- **Parked:** a hybrid mode where we host the UI and configuration and a user-run runner holds
  credentials and calls upstream APIs. Strongest privacy story, but it needs a secure
  runner-to-control-plane channel; revisit if users ask for it.
- **Open:** which container platform for our deployment (Fly.io, Cloud Run, Railway, or similar),
  and Neon/Upstash free-tier limits. Decide in milestone 2 against current pricing and limits.

## D-019 Vault: envelope encryption with Node's built-in AES-256-GCM

- **Decision:** `packages/vault`. Each tenant has a random 256-bit data key, stored only wrapped by
  a key-encryption key (KEK). Credentials are encrypted with the tenant's data key using
  AES-256-GCM. The authenticated context binds tenant, credential id, source, scheme, and kind, so
  a ciphertext copied to another row or tenant, or with edited metadata, fails to decrypt. The
  KEK sits behind a `KeyWrapper` interface: `LocalKeyWrapper` uses `CAIRNMCP_MASTER_KEY` (32
  bytes, base64) for self-hosting and development; a KMS wrapper can replace it. Data keys
  record which KEK wrapped them, and `rotateTenantKey` re-wraps them without touching credentials.
- **Secrets in memory:** decrypted values are `Secret` objects that print as `[redacted]` in
  strings, JSON, and `console.log`; code must call `reveal()`, which is easy to audit.
- **Why these primitives:** AES-256-GCM via `node:crypto` (OpenSSL) is a reviewed implementation;
  the vault only fixes parameters (fresh 96-bit IV per encryption, 128-bit tag) and encoding.
  No custom cryptography.
- **Rejected:** One global key for all credentials (no per-tenant isolation, rotation rewrites
  everything); libsodium (another native dependency for no gain here); storing credentials in the
  upstream's OAuth provider only (not every API offers OAuth).
- **Later:** a Postgres `VaultStore` with RLS (milestone 2, done: D-024), a KMS `KeyWrapper` for the hosted
  deployment, and a short-lived data-key cache once unwrapping is a network call.

## D-020 Runtime: fail closed, errors as tool results, no automatic retries

- **Decision:** `packages/runtime` executes one tool call in a fixed order: validate the agent's
  input against the schema it was shown; add pinned inputs and validate again; take a throttle
  slot; build the request; attach credentials; record intent in the audit log (writes only);
  send under egress rules; record the outcome. Expected failures are returned as
  `{ ok: false, error }` with a kind, an agent-readable message, and `retryable`/`retryAfterSeconds`,
  not thrown.
- **Egress rules (now):** https only; only the source's origin, checked before every request and
  redirect; same-origin redirects only and never for writes; one timeout (15 s) for the whole call;
  responses read as a stream and cut at 2 MB. An `EgressGuard` hook runs on every hop; milestone 3
  plugs in DNS resolution and private-range blocking there.
- **Throughput:** token buckets plus a concurrency cap, per tenant+source (60/min, 4 at once) and
  per source across tenants (300/min, 16 at once), because every tenant shares our egress IP.
  Upstream `429`/`503` with `Retry-After` cools down both keys. Defaults are guesses until
  Intervals.icu's limits are confirmed; they are settings, not constants.
- **No automatic retries:** the agent gets `retryable` and a wait time and decides. Retrying a
  write inside the runtime could repeat it.
- **Audit fails closed:** if the intent entry can't be written, the write is not sent.
- **No leaks by construction:** error messages never include URLs (a query-string key would leak)
  or request headers; credential values the upstream echoes back are scrubbed from bodies.

## D-021 Scope: cairnmcp returns API output as-is; analysis is a separate project

- **Decision:** cairnmcp turns APIs into agent-ready tools and returns what the upstream API
  returns. It does not analyze, interpret, summarize, or filter domain data. The planned analyzer
  tool pack (milestone 6) and its `backtest` package are removed from this project; the athlete-
  local `LocalDate` type built for them is removed from `core`.
- **What the runtime may still do to output:** decode it (JSON, text, base64), scrub echoed
  credentials, enforce the size cap, and wrap it generically where a protocol requires (MCP
  structured content must be an object, so an array response gets wrapped). All of these are
  API-agnostic.
- **What curation may still do:** rename and re-describe tools, pin inputs, and point agents at the
  API's own parameters (e.g. Intervals.icu's `fields`) to keep responses small. Those use the API
  as designed; they don't change what it returns.
- **Why:** Keeps cairnmcp general-purpose. An analysis product is built on top of it as a
  consumer, like any other agent or app.
- **No source-specific code or settings in the product:** facts about one API (Intervals.icu's
  `API_KEY` username, athlete `0`) are curation data. Until the curation UI stores them per tenant,
  they live in `examples/<api>/` and `docs/sources/<api>.md`, never in `packages/` or the root
  `.env.example`.

## D-022 Custom upstream auth and caller identity: plan now, build in 3b

- **Context:** A team wants internal MCP access to an API they already wrap with a generated
  TypeScript client, behind custom auth. "Custom auth" is two separate connections: who may call
  cairnmcp (inbound), and how cairnmcp calls their API (outbound).
- **Decision:**
  - Ingest from the OpenAPI document the client was generated from, through the existing
    ingestor. A TypeScript-types ingestor is possible but lower fidelity (types don't capture
    paths, auth, or side effects well).
  - Don't execute operations through the team's client code. The HTTP mapping plus an auth
    extension covers the realistic cases without tying the runtime to their code.
  - Add a `custom` auth scheme kind to the IR in 3b (an IR version bump), resolved by named
    providers: declarative kinds everywhere, custom-code kinds on self-hosted deployments only.
  - Support on-behalf-of calls via token exchange (RFC 8693): credentials derived per call from
    the caller's identity instead of stored in the vault.
  - Make the egress policy depend on deployment: hosted is public-only; self-hosted may name
    private hosts.
- **Applied now (milestone 2):** pass caller identity into the runtime and credential lookup, and
  keep token validation (resource server) separate from token issuing (authorization server).
  Both are cheap now and expensive to retrofit.
- **Why not now:** No user needs it yet; milestone 2 only has to avoid closing the door.
- **Out of scope:** auth that needs a human per request (interactive SSO, MFA prompts).

## D-023 cairnmcp enforces its own authorization; permissions only narrow

- **Decision:** cairnmcp is both an authenticator (who is calling) and a policy enforcement point
  (what they may do through cairnmcp). The upstream API remains the authority over its own data.
  A caller's effective permission is the overlap of the two: cairnmcp can narrow what the
  upstream allows, never widen it.
- **What cairnmcp decides:** which tenant a token reaches (RLS); which toolsets a member can use
  and whether they may call write tools (milestone 2); which tools exist and are enabled;
  which argument values are fixed (pinned inputs) or, later, constrained per caller (3b); which
  hosts may be called (egress). Every check happens on each call, not only when tools are listed.
- **Why it matters most with shared credentials:** when cairnmcp calls the upstream with one
  service-account key, the upstream can't tell users apart, so cairnmcp's checks are the only
  per-user limit. Without them any caller could make cairnmcp do anything the shared key allows
  (a confused deputy). On-behalf-of calls (D-022) let the upstream enforce per-user permissions
  too; cairnmcp's checks still apply on top.
- **Scope of the first version (milestone 2):** per-member, per-toolset access with two levels
  (`use`, `use_writes`), and the acting user in every audit entry. Claim-based policies and
  per-caller argument constraints come in 3b.
- **Rejected:** relying on the upstream alone (fails with shared credentials); relying on MCP
  clients to only call listed tools (clients are untrusted); writing a policy language (use Cedar
  or OPA if declarative rules stop being enough).


## D-024 Database: Postgres, Drizzle for queries, hand-written SQL migrations, RLS per transaction

- **Decision:** `packages/db`. Postgres through Drizzle (`drizzle-orm` 0.45, `pg` 8) for typed
  queries. The schema is defined by hand-written SQL migrations, applied by a small migrator
  (ordered files, one transaction each, an advisory lock, and checksums so an applied file can't
  be edited). `src/schema.ts` mirrors the tables for Drizzle; a test checks it against the
  migrated database.
- **Two roles:** an owner that owns every object and runs migrations, and an app role (a member
  of the `cairnmcp_app` group, `NOBYPASSRLS`, not the owner) that the server connects as. The app
  refuses to start as a superuser, a `BYPASSRLS` role, or the owner. No `TRUNCATE` is granted
  (it ignores RLS).
- **Isolation:** every tenant table has `tenant_id`, with RLS enabled and forced (so the owner is
  filtered too). The server sets the tenant per transaction with
  `set_config('app.tenant_id', …, true)`; it reverts at commit, so a pooled connection never
  carries a tenant forward. Unset means every table reads empty and rejects writes. Foreign keys
  between tenant tables include `tenant_id`, so a row can't reference another tenant's row even
  with a guessed id.
- **Users and members:** users are global, one per token issuer and subject; the app sees only
  members of the current tenant. Memberships are per tenant with a role (`owner`, `admin`,
  `member`). Toolset access is a separate per-member grant (`use`, `use_writes`, D-023) that
  references the membership, so leaving a tenant removes it. Roles don't imply toolset access
  yet; what each role may manage comes with the curation UI.
- **Cross-tenant operations** are three narrow `SECURITY DEFINER` functions, callable only by
  the app role: `create_tenant`, `find_user`, `ensure_user`. Each has a fixed `search_path`.
- **Audit:** the app role can insert and select audit entries, never update or delete them.
  Entries reference the acting user but not sources or memberships, so they outlive both.
- **What RLS protects against:** a missing `WHERE tenant_id = …` or a confused query, not a
  compromised server, which can set any tenant. The vault's per-tenant encryption context
  (D-019) is a second layer for credentials.
- **Ids:** text with the same pattern as `TenantId`/`UserId` in core (UUIDs in practice), so core
  stays storage-agnostic and tests can use readable ids.
- **Tests:** each test file creates its own database from a superuser URL
  (`CAIRNMCP_TEST_DATABASE_URL`), with the same owner/app split as production. Skipped with a
  warning locally if unset; required in CI, which runs a Postgres service.
- **Rejected:** Drizzle Kit generated migrations (RLS policies, grants, and definer functions are
  the point of the schema and read best as SQL; generated diffs would hide them); a schema or
  database per tenant (migrations and pooling multiply with tenants); filtering by tenant in
  application code only (one forgotten filter leaks data); `SET ROLE` per tenant (a role per
  tenant doesn't scale and still needs RLS).

## D-025 MCP endpoint: one per toolset, stateless, a resource server that authorizes every request

- **Decision:** `packages/mcp`. Streamable HTTP via the official SDK's low-level `Server` (tool
  lists differ per caller, and input schemas are already JSON Schema, so the high-level
  `McpServer` with Zod tools doesn't fit). One endpoint per toolset: `/mcp/{tenantId}/{toolsetId}`.
- **Why per toolset:** tool names are unique only within a toolset, an MCP client connects to one
  URL with one token, and access is granted per toolset (D-023).
- **Stateless:** no MCP sessions; every POST is authenticated and loads membership, toolset, and
  access fresh, with JSON responses (no SSE). Revoking access applies to the next call, and any
  instance can serve any request. GET and DELETE answer 405.
- **Tokens (resource server only):** JWTs signed with an asymmetric key (RS256, PS256, ES256,
  EdDSA) by a configured trusted issuer (keys from its JWKS), with `aud` equal to the endpoint's
  exact URL (RFC 8707), `exp`, and `sub`. The issuer and subject resolve to a user through
  `find_user`; the endpoint never creates users. 401s carry `WWW-Authenticate` with
  `resource_metadata` (RFC 9728), and the metadata names the trusted issuers. The embedded
  authorization server, which issues these tokens, comes next and is configured as one trusted
  issuer.
- **Authorization:** not a member, unknown user, and unknown tenant get the same 403; a member
  without access gets 403; a member with access sees only the tools `canCall` allows, and
  calling any other tool by name gets "unknown tool", the same as a tool that doesn't exist.
  RLS can't catch a member of tenant B calling tenant A's endpoint (the server sets tenant A on
  purpose), so this membership check is the boundary there, and the tests cover it.
- **Hardening:** resource URLs come from `CAIRNMCP_PUBLIC_URL`, never the `Host` header;
  requests with an `Origin` not in `CAIRNMCP_ALLOWED_ORIGINS` get 403 (DNS rebinding); error
  responses never echo tokens or internals.
- **Rejected:** one endpoint per tenant serving all toolsets (name clashes, coarser access);
  MCP sessions (in-memory state per instance, and stale permissions until the session ends);
  opaque tokens with introspection (a network call per request; JWTs from the embedded server
  verify locally).
- **Not yet:** scopes (no scope is required yet), token revocation before expiry (keep access
  tokens short-lived), and per-instance rate limits becoming shared ones once there is more than
  one instance.

## D-026 Embedded authorization server: OIDC sign-in, consent, short-lived endpoint-bound tokens

- **Decision:** `packages/auth`, an OAuth 2.1 authorization server in the same process and image
  as the MCP endpoint (`packages/server`), following the MCP authorization spec (2025-11-25):
  RFC 8414 metadata, dynamic client registration (RFC 7591), authorization code with PKCE (S256
  only), resource indicators (RFC 8707), and `iss` in the authorization response (RFC 9207). The
  MCP endpoint trusts it like any other issuer (D-022); its tokens carry the cairnmcp user id as
  `sub`, so no lookup is needed.
- **Sign-in is delegated** to OpenID Connect providers set in `CAIRNMCP_OIDC_PROVIDERS` (Google,
  Okta, Entra, Keycloak, ...), through `openid-client` (code flow, PKCE, state, nonce, ID token
  validation). cairnmcp never handles passwords or sends email. A user is the provider's issuer +
  subject (`ensure_user`). GitHub isn't an OIDC provider and needs its own adapter later.
- **Pages live in the container:** a provider chooser and a consent page, server-rendered with
  every value escaped, a strict CSP, and no framing. One container stays enough to self-host;
  the web app can restyle them later.
- **Consent** names the app, the account, the toolset and tenant, the access level, and where the
  app returns. Only members with access to the toolset reach it (others see "no access"). The
  flow is bound to the browser that started it by an HttpOnly, SameSite=Lax cookie whose hash is
  stored with the request; the consent form also refuses a foreign `Origin`.
- **Clients:** public only, so no client secrets to store or leak; a requested secret-based auth
  method is replaced with `none` (RFC 7591 allows that). Redirect URIs: https, loopback http on
  any port (RFC 8252), or a native app's private scheme; never `javascript:`, `data:`, `file:`,
  fragments, or credentials. Until the client and redirect URI are verified, errors are shown
  as a page, never redirected (no open redirect).
- **Tokens:** access tokens are ES256 JWTs (`typ: at+jwt`) with `aud` set to exactly one MCP
  endpoint, valid 15 minutes. Membership and access are still checked on every MCP call (D-025),
  so revoking access doesn't wait for expiry. Refresh tokens are opaque, rotate on every use,
  and last 30 days. Codes are single-use for 60 seconds. A reused code or refresh token revokes
  every token from that sign-in (RFC 9700). Codes, refresh tokens, and browser bindings are
  stored only as SHA-256 hashes.
- **Signing keys:** one active ES256 key, created on first start and stored wrapped by the KEK
  (D-019); the MCP endpoint verifies with the same keys in memory. Retired keys stay in the JWKS
  for a day. Rotation itself is not built yet.
- **Scope:** one scope, `mcp`. What a user may do is decided per call by toolset access (D-023),
  not by scopes.
- **Deferred:** Client ID Metadata Documents (the 2025-11-25 alternative to registration). The
  server would fetch a URL each client names, which needs the private-address blocking planned
  for egress hardening (milestone 3). Also deferred: rate limits on registration and sign-in,
  pruning clients that never sign in, and a page to see and revoke connected apps.
- **Rejected:** a hosted identity service (Auth0, Clerk, ...) as the authorization server (a
  required third party for self-hosters, against D-018); passwords or magic links (credential
  storage or an email dependency for every deployment); MCP-session-length tokens (the endpoint
  is stateless, D-025).

## D-027 Container image: one Node image, no build step, migrations as a separate command

- **Decision:** a root `Dockerfile` for the image of D-018. Base `node:24-trixie-slim` pinned by
  digest (Dependabot keeps it current). Node runs the TypeScript sources directly, as everywhere
  else (D-009), so there is no compile stage. A first stage installs only `@cairnmcp/server` and
  its runtime dependencies with the lockfile (`pnpm fetch` then an offline install, cached by
  lockfile); the final stage copies the result without pnpm or Corepack.
- **Layout:** workspace packages stay where they are and are linked from `node_modules`, because
  Node won't strip types from files under `node_modules` (so `pnpm deploy`, which copies them
  there, doesn't work for us).
- **Runtime:** runs as the unprivileged `node` user; the code is owned by root and read-only.
  `PORT` defaults to 8080; `SIGTERM` closes the server and the pool. A `HEALTHCHECK` calls
  `/healthz` with Node's `fetch`, so the image needs no curl.
- **Migrations aren't run at startup.** They need the owner role, which the running app must not
  have (D-024), so they are a separate command in the same image
  (`node packages/db/scripts/migrate.ts`), run before a deploy as a release step or one-off job.
- **CI** builds the image and runs `scripts/image-smoke.sh` against Postgres: migrate inside the
  image, start it as the app role, check health, metadata, registration, the MCP 401, and the
  non-root user. Publishing the image waits for self-hosting (milestone 2b).
- **Rejected:** a compile step to JavaScript (another build to keep in sync, for no runtime
  gain); distroless or Alpine bases (slim keeps glibc and a shell for debugging, at a modest size
  cost); running migrations on start (needs owner credentials in the app, and several instances
  starting at once would race to migrate).

## D-028 Hosted deployment: Cloud Run and Neon, free tier for now

- **Superseded by D-029** (Oracle Cloud VM). The Cloud Run scripts were removed; they're in git
  history if we move back.

- **Decision:** our deployment runs the D-027 image on Google Cloud Run (`us-west1`) with Neon
  Postgres (AWS `us-west-2`, next to it), sized to stay free: scale to zero, at most one instance,
  CPU only during requests (request-based billing). Google is also the first sign-in provider
  (D-026), with the OAuth client in the same project. Closes the platform question left open in
  D-018.
- **Why free now:** one user (D-016). Fly.io, the cheapest always-on option with a dedicated
  outbound IP (about $7-10/month), no longer has a free plan; Railway's static IPs need its paid
  plan and may be shared; Render's dedicated IPs cost $100/month.
- **Trade-off accepted for now: no stable outbound IP.** Upstream calls leave from Google's
  shared addresses, so a per-IP rate limit (Intervals.icu) is shared with whoever else uses them.
  Fix when it matters: Cloud NAT with a reserved IP on Cloud Run, or move the same image to
  Fly.io with a static egress IP.
- **One instance on purpose:** the rate limiter and throttles are in memory (D-020), so a second
  instance would double the limits. A shared limiter comes before raising `max-instances`.
- **Cold starts:** a second or two after idle; the endpoint is stateless (D-025) and signing keys
  load from the database on start, so nothing is lost. The hourly cleanup of expired sign-in state
  only runs while an instance is up, which is fine at this size.
- **Secrets** live in Secret Manager. Two service accounts: the service reads the app database URL,
  master key, and sign-in config; the migration job reads only the owner URL. The master key is
  generated into Secret Manager and never displayed.
- **Neon roles:** the project is managed with the Neon CLI (`neon.ts`, `neon deploy`), whose env pull
  gives only the branch owner's URLs. The app role is created with SQL by
  `pnpm --filter @cairnmcp/db roles`, not in Neon's Console, whose roles join `neon_superuser` and
  can bypass RLS (the app refuses to run as such a role anyway, D-024). The app uses Neon's pooled
  endpoint with `pg` (a long-running process, so the pool is reused); migrations use the direct
  one (session advisory lock), falling back to Neon's `DATABASE_URL_UNPOOLED`.
- **Deploys** are a script for now (`deploy/cloud-run/deploy.sh`): build for amd64, push to
  Artifact Registry, run the migration job, deploy the revision, check health and metadata.
  Deploying from CI (with workload identity federation, no stored keys) comes later.

## D-029 Hosted deployment: an Oracle Cloud Always Free VM, behind Caddy

- **Decision:** our deployment runs the D-027 image on one Oracle Cloud Always Free Arm VM
  (Ubuntu 24.04, Ampere A1), with Docker Compose: the app plus Caddy for HTTPS (Let's Encrypt,
  automatic renewal). The database stays on Neon's free plan (D-028's Neon setup, in `us-west-2`);
  the VM's home region should be US West (San Jose or Phoenix). Replaces Cloud Run (D-028).
- **Why:** free, and the only free option with a **stable outbound IP**: the VM's public IP is
  ours alone, so per-IP upstream rate limits (Intervals.icu) see only our traffic, which D-028
  had to give up. One long-running process also suits the in-memory rate limiter (D-020), with no
  cold starts.
- **Costs of the choice:** a server to look after (security updates are automatic; reboots aren't),
  and Oracle reclaims idle Always Free VMs (under 20% use for a week). We upgrade the account to Pay
  As You Go, which community reports say exempts it (Always Free resources stay free), with a $1
  budget alert, rather than faking load. Oracle has
  cut the A1 allowance before (reportedly to 2 OCPU / 12 GB in 2026); we need far less (1 OCPU,
  6 GB).
- **Shapes:** Ampere A1 (Arm) when Oracle has capacity, which it often doesn't; otherwise the free
  x86 `E2.1.Micro` (1 GB). The Micro can run the stack (app capped at 512 MB, Caddy at 128 MB, plus
  2 GB of swap) but not build it, so `ship.sh` builds the image on the operator's machine for the
  VM's architecture and streams it over SSH (`docker save | docker load`). No registry and no
  GitHub access on the VM; the repo stays private.
- **Layout:** `deploy/oracle/compose.yaml`; on an A1 VM with a clone of the repo, `deploy.sh` can
  also build there. The app runs read-only, with no capabilities and no privilege escalation, and is
  only reachable through Caddy. Migrations run in a one-off `migrate` container that alone gets the
  owner URL (`migrate.env`); the app's settings are in `app.env`. Both are mode 600 and gitignored.
- **Infrastructure as code:** Terraform (`deploy/oracle/infra`, provider `oracle/oci`): the VCN,
  public subnet, security list, a **reserved** public IP (survives replacing the VM), the Ubuntu VM
  with cloud-init (Docker, swap, firewall, updates), a quota allowing only the Always Free shapes,
  and a budget alerting on any spend. App settings and secrets stay out of Terraform state;
  `setup-vm.sh` writes them on the VM. Local state, gitignored; Resource Manager also works.
- **Domain:** the operator's own, or `<ip>.sslip.io` (free wildcard DNS) to start. The public URL is
  the OAuth issuer (D-026), so changing it later invalidates sessions and tokens.
- **Master key:** generated on the VM into `app.env`. With no managed secret store, the disk is the
  only copy, so the guide makes backing it up to a password manager a setup step.
- **Rejected:** Cloud Run (free, but no stable outbound IP without paid Cloud NAT, and a Google
  billing account); Neon Functions (free in beta, regions don't include our `us-west-2`, unknown
  pricing later); Render's free tier (sleeps, slow wake); Fly.io and Railway (no free plans).

## D-030 Admin CLI until the curation UI: run where the master key is

- **Decision:** `packages/server/scripts/admin.ts` sets up tenants: `tenant create` (optionally with
  a chosen id, migration `0003`, so endpoint URLs are readable and known before the tenant exists),
  `source add` (ingest an OpenAPI document from stdin, with per-API curation such as a fixed
  basic-auth username), `toolset put` (a curated JSON definition, or the default), `access grant`
  (adds the user as a member if needed), `credential set` (secret from stdin), and `tenant show`
  (no secrets). The logic is in `src/admin.ts` and tested against Postgres, including an MCP client
  seeing the tools afterwards.
- **Where it runs:** inside the app container, as the app role (RLS applies, D-024), because storing
  a credential needs the master key, which lives only there (D-029). `deploy/oracle/admin.sh` runs
  it over SSH from the operator's machine, forwarding stdin; for `credential set` it asks for the
  secret locally, hidden, so it never appears in a command line, shell history, or process list.
- **First user:** users are created by signing in (`ensure_user`, D-026). The "No access" page shows
  the account id, which the operator uses as the owner. No account ids or emails are guessed.
- **Curation data stays out of the product (D-021):** the Intervals.icu starter toolset (pins and
  descriptions) is `examples/intervals-icu/toolset.json`; the fixed username is a CLI argument.
- **Rejected:** an HTTP admin API now (another authenticated surface before there is a UI to use
  it); running the CLI from the operator's machine against the database directly (it would need
  the master key and the database URL outside the VM).

## D-031 Sign-in through Auth0, managed with Terraform

- **Decision:** the embedded authorization server's OIDC provider (D-026) for our deployment is
  Auth0, set up by Terraform in `deploy/auth0`: one `regular_web` application with its callback
  (`<public URL>/oauth/callback/auth0`), a `client_secret_post` credential, an email/password
  connection with brute-force protection, and optionally Google through Auth0's developer keys.
  `push-provider.sh` installs the resulting `CAIRNMCP_OIDC_PROVIDERS` on the VM over SSH stdin
  and restarts the app.
- **Why Auth0:** sign-in fully as code. Google has no API for OAuth consent screens or web clients
  (the IAP OAuth Admin API, the only route, shut down in March 2026), so Google directly would
  always need console clicks. Auth0's free plan (25,000 monthly active users) is far above our
  needs and offers email/password and Google behind one provider, with no cairnmcp code changes.
- **Open sign-up is fine:** an Auth0 account grants nothing in cairnmcp; access is granted per
  toolset (D-023, D-030).
- **Trade-off:** the client secret is in Terraform state on Terraform 1.5 (write-only secrets need
  1.11+). The state is local, gitignored, and kept private like `app.env`.
- **Rejected:** Google directly (manual setup, no IaC); Microsoft Entra (its multi-tenant issuer
  varies per tenant, which our exact issuer check rejects); self-hosted Keycloak (too heavy for the
  1 GB VM).
