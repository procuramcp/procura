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

## D-032 Provider-hosted servers: one toolset, many users, each calling as themselves

- **Context:** An API provider (say Intervals.icu, for its paid tier) wants to offer one MCP server
  to all its customers. Today a toolset belongs to a tenant whose owner stores one credential and
  grants access per person (D-023, D-030). That fits "my own server", not thousands of customers
  on one URL, and with one shared key the upstream can't tell users apart.
- **Decision:** one tenant (the provider) owns the toolset and one MCP URL serves every customer.
  Three changes make that work, all in milestone 3b:
  - **Sign-in through the provider:** the tenant names its own OIDC provider (here, Intervals.icu's
    OAuth), so customers sign in with the account they already have. cairnmcp users are created on
    first sign-in; nobody runs admin commands per customer.
  - **Per-user credentials:** each source has a credential mode, `shared` (today: one credential
    per tenant, source, and scheme) or `per_user` (one per tenant, source, scheme, and user). Two
    ways to fill `per_user`:
    1. **Sign-in doubles as the API grant (first):** when the sign-in provider is also the
       upstream's OAuth server, the sign-in also asks for the API scopes, and the user's access and
       refresh tokens are stored in the vault under that user, refreshed as needed. One consent
       screen, and it works with any OAuth API without the provider's help (a provider's OAuth
       app is enough).
    2. **Token exchange (RFC 8693, later):** for a provider running cairnmcp next to its API,
       cairnmcp trades the caller's token for a short-lived upstream token per call and stores
       nothing (D-022).
  - **Access from claims, not grants:** a toolset can grant a level to everyone whose token carries
    a claim (e.g. `plan = premium` gets `use`), checked on every request like today's grants. When
    the plan lapses, access should end within minutes, so refreshing a cairnmcp token (access
    tokens last 15 minutes, D-026) has to fetch the claims from the provider again rather than
    reuse the ones from sign-in.
- **Never token passthrough:** the MCP access token is never sent upstream. The MCP authorization
  spec forbids it, and it would let any MCP client's token act on the API directly.
- **Already in place:** the caller reaches the runtime and the credential lookup
  (`credentialsForSource(tenant, source, caller)`, D-022); the vault has an `oauth2` credential
  kind; the audit log records the acting user; pins like Intervals.icu `id = "0"` (the signed-in
  athlete) become per-user automatically once the credential is.
- **Also needed:** rate limits per user as well as per tenant, so one customer can't use up the
  provider's upstream quota; the curation UI (milestone 3) for the provider to choose and describe
  tools; a custom domain on hosted cairnmcp, or the self-hosted image (milestone 2b).
- **Where it runs:** the provider self-hosts the image next to its API (private-network targets,
  D-022), or uses hosted cairnmcp. Either way the security model is the same, and with per-user
  credentials the upstream enforces its own permissions too, with cairnmcp's checks on top
  (D-023).
- **Rejected:** one cairnmcp tenant per customer (each would set up sources, toolsets, and keys
  themselves, which is the inefficiency this removes); asking each customer to paste their own API
  key (works, but worse to use and less safe than OAuth; may still be offered as a `per_user`
  fallback for APIs without OAuth).

## D-033 Curation console: a React app with shadcn/ui, served by the app at /app

- **Decision:** the curation UI (milestone 3) is a single-page app in `packages/web`: React,
  Vite, Tailwind, shadcn/ui components, and Vercel's AI Elements for the tool test panel. Vite
  builds it to static files in a Docker build stage; the app serves them at `/app` with a small
  JSON API at `/app/api`. The first version edits toolsets (tools on or off, names, descriptions,
  pins, with write tools marked) and access; sources, credentials, and tenants stay in the admin
  CLI (D-030) for now.
- **No build step still holds for the server** (D-009): Node runs the server's TypeScript as
  before. The build is only for the browser bundle, which needs one anyway (JSX, Tailwind).
- **Sign-in:** the same OIDC providers as the authorization server (D-026), with their own
  callback (`/app/callback/<provider>`, added to the Auth0 application, D-031). A session is a
  random token in a `__Host-` cookie (HttpOnly, Secure, SameSite=Lax), stored only as a hash,
  for 8 hours. The console never sees access tokens for MCP endpoints.
- **Who may edit:** tenant owners and admins. Members get 403. Every API call runs inside the
  tenant (RLS), like the MCP endpoint; listing your tenants uses one more narrow cross-tenant
  function, `cairnmcp.user_tenants(user_id)`.
- **CSRF:** the API accepts unsafe methods only with `Origin` equal to the public URL and a JSON
  body; together with SameSite=Lax, a form or fetch from another site can't act as the user.
- **Tool test panel:** runs one tool from the editor (including unsaved changes) through the same
  runtime as the MCP endpoint: same pins, credentials, and rate limits, and writes are audited
  under the signed-in user. Write and destructive tools ask for confirmation first, since the call is
  real. The panel shows the call and the response with AI Elements' tool view; no LLM is involved,
  so it costs nothing.
- **Content security policy:** scripts only from the app's own origin; inline styles are allowed
  (Radix and the code view set them), nothing else inline.
- **Rejected:** server-rendered HTML (chosen first, then replaced to use shadcn/ui and AI
  Elements, which are React); a separate frontend deployment (another origin means CORS and
  token handling for no gain on one VM).

## D-034 Access profiles: named permission sets, assigned to members

- **Context:** access is granted per person and per toolset (D-023). Ten people who should be able
  to do the same thing need ten grants, and changing what that group may do means editing each one.
- **Decision:** a tenant defines **access profiles** (e.g. "Athlete", "Coach") and assigns them to
  members. A profile is a list of rules, at most one per toolset: an access level (`use` or
  `use_writes`) and optionally the operations it is limited to. Edit a profile and everyone with it
  changes on their next request: access is checked on every `tools/list` and `tools/call`, so no
  token is reissued and nobody reconnects.
- **Effective access** to a tool is the union of the caller's direct grant (today's per-person
  access, kept as an exception) and every rule from their profiles: a rule allows a tool when its
  level allows the tool's side effect (`canCall`) and, if it lists operations, the tool's operation
  is listed. Never more than the toolset enables.
- **Operation lists only narrow.** A list picks tools within what the level allows; it can't add a
  write tool to a `use` rule. Simpler to reason about, and a write always needs `use_writes`
  somewhere. Lists name operations, not tool names, so renaming a tool keeps its rules.
- **Profiles govern calling tools, not editing the tenant.** Owner, admin, and member (who may use
  the console) stay separate. Letting a profile edit a toolset is a later, bigger decision.
- **Storage:** `access_profiles`, `profile_rules`, and `member_profiles`, tenant tables with forced
  row-level security like the rest. Deleting a toolset removes its rules; a member leaving removes
  their assignments.
- **Later:** claim-based assignment (D-032: "`plan = premium` gets Athlete") assigns the same
  profiles from the sign-in token instead of by hand.
- **Rejected:** replacing direct grants with profiles (more churn for no gain; a one-person
  exception is common); a policy language (D-023: Cedar or OPA if declarative rules stop being
  enough).

## D-035 Adding APIs in the console: find, preview, add, then the key

- **Decision:** owners and admins add an API from its OpenAPI description in the console:
  1. **Find:** a URL, pasted text, or an uploaded file. A URL may be the document, a Swagger UI
     page (followed through its `swagger-config`), or the API's address (the usual paths such as
     `/openapi.json` and `/v3/api-docs`); at most 12 fetches.
  2. **Preview:** the ingestor runs and nothing is stored: name, base URL, operations by side
     effect, auth schemes, warnings. A basic-auth fixed username is pre-filled when the scheme's
     description states one ("Username is API_KEY").
  3. **Add:** the source and, optionally, a first toolset with only reads enabled (D-016).
     Everything is checked before anything is written, so a refusal leaves nothing half-added.
  4. **Key:** per auth scheme, a key is sent once, stored encrypted (D-019), and never returned;
     the page shows only "key set" with Replace and Remove.
- **Fetching untrusted URLs:** https only, port 443, no credentials in the URL. The host is
  resolved once and every address must be public (no loopback, private, link-local and cloud
  metadata, carrier-grade NAT, unique-local, or multicast ranges); the connection is pinned to
  the checked address, so DNS can't change between check and request; redirects are re-checked;
  10 MB and 15 seconds at most. The same checks will move into the runtime's egress guard
  (milestone 3).
- **Shared with the CLI:** `mapSource` (ingest plus curation) is used by both `admin.sh source add`
  and the console, so they can't drift.
- **Not yet:** replacing an existing source with a new version (a 409 for now). That needs a diff
  of operations and a check of the toolsets and profiles that use removed ones, which is phase 2.
- **Benchmark:** the Intervals.icu Swagger UI page
  (`https://intervals.icu/api/v1/docs/swagger-ui/index.html`) leads to `/api/v1/docs` in three
  fetches; the preview shows 153 operations, two auth schemes, and `API_KEY` pre-filled.

## D-036 Push to main deploys to the VM, with a key that can only deploy

- **Decision:** after the tests and the image smoke test pass on `main`, a `deploy` job builds
  the x86 image on GitHub's runner and streams it over SSH to the VM, where it is loaded and
  `deploy.sh` runs (migrate, restart, health check). No registry: the image goes the same way
  `ship.sh` sends it. Deploys never overlap, and runs on `main` are no longer cancelled by a
  newer push, so a deploy is never cut off halfway.
- **The key can only deploy.** Its `authorized_keys` entry has `restrict` and a forced command,
  `~/cairnmcp-ci/receive.sh` (from `deploy/oracle/ci-receive.sh`). It accepts exactly
  `deploy <12-hex tag> <sha256>`, loads a size-capped image stream, checks the stream carried that
  tag, and runs the VM's own `deploy.sh`. No shell, no file copies, no port forwarding.
- **CI never changes the deploy files.** The command lives outside the repo copy, and if a
  commit's `compose.yaml`, `Caddyfile`, or `deploy.sh` differ from the VM's (compared by hash),
  it stops and asks for `ship.sh`, which you run with your own key. Otherwise a commit could
  rewrite the script the key is locked to.
- **Secrets:** the private key, the VM's pinned host key (read over your trusted connection, so
  no trust on first use), host, and user are secrets of a `production` environment that only
  `main` can deploy from. Required reviewers on that environment turn every deploy into a
  one-click approval. `DEPLOY_ENABLED=false` pauses deploys.
- **Accepted risk:** anyone who can push to `main` can deploy code that runs with the app's
  secrets. That's inherent in push-to-deploy; branch protection (required PR review) is the
  control for it. Caddy is pinned by digest, so a loaded image can't stand in for it.
- **Not blue-green:** a deploy restarts the one container (a few seconds of 502s), as with
  `ship.sh`. Fine for now (D-029).
- **Also:** `ship.sh` no longer copies `infra/` (Terraform state and variables) to the VM.

## D-037 API providers are the main customer; individuals are the on-ramp

- **Context:** everything so far assumes one person or a small team hosting a server for their own
  key: one shared credential, members added by hand. The business is API providers: a company
  that wants one MCP server for all its customers, with different tools and limits per plan, and
  usage it can charge for (D-032 designed this but filed it under milestone 3b).
- **Decision:** design for the provider first; `docs/USER-STORIES.md` lists what each kind of
  user needs. Personal hosting stays, as the free tier and the quickest way to try cairnmcp, on
  the same code: a tenant can grow from one into the other without starting over (I-3).
- **Team members and customers are separate.** "Member" today covers both the people who edit in
  the console and the people who call tools. A provider has a few of the first and up to tens of
  thousands of the second, created on first sign-in. Customers get their own records (search,
  suspend, per-customer exceptions); team roles stay owner, admin, and editor. Cheap to split
  now, expensive once real customers exist, so it comes first.
- **A plan is an access profile with limits.** Profiles (D-034) already say which tools; plans
  add per-customer requests per minute and a daily or monthly allowance, with an optional cost
  per tool. Allowances need counters in Postgres; the in-memory limiter can't hold them across
  restarts or instances. A sign-in claim picks the plan (D-032).
- **cairnmcp meters and enforces; it doesn't take payments.** The provider's billing system
  decides the plan and sets the claim; cairnmcp enforces it and reports usage per customer
  (export and webhook). Taking payments would make us a party to every provider's pricing,
  taxes, and refunds, for little gain over a usage feed.
- **Usage is counted separately from the audit log.** The audit log keeps full inputs per call
  (D-020); at provider scale that's too heavy to count from. Usage gets small per-call counters,
  and audit retention becomes a provider setting.
- **Roadmap:** provider work (milestone 3c) moves ahead of the GraphQL and docs-page ingestors.
- **Open:** how the upstream learns the caller (per-user OAuth tokens, D-032, or a service key
  plus a signed identity header; never the MCP token itself); a first real provider; whether
  providers need self-hosting early, which would move milestone 2b up.
- **Rejected:** one tenant per customer (D-032); building billing into cairnmcp (above); keeping
  the individual case as the main design target (the provider case can't be added later without
  reworking members, limits, and sign-in).

## D-038 Team and customers: one membership table, five roles, suspension

- **Context:** D-037 puts the team (a provider's few staff) and customers (up to tens of thousands
  calling tools) on separate footing. Until now everyone was a `memberships` row with role owner,
  admin, or member, where "member" meant "calls tools, no console".
- **Decision:** keep one `memberships` row per person and say who they are with the role:
  `owner`, `admin`, `editor`, `viewer` (the team, who may open the console) or `customer` (calls
  tools only). Grants (`toolset_access`) and profiles (`member_profiles`) already point at
  memberships and work the same for both, so nothing about calling tools changes. A separate
  customers table would have needed a second copy of both, or foreign keys that can't point at
  either table.
- **Console roles:** viewers look at everything and change nothing; editors curate toolsets,
  sources, profiles, and customers; admins also set API keys and manage the team; only owners
  make, change, or remove owners. Nobody changes their own role or status or removes themselves,
  so a tenant always keeps an owner. Customers get the same 404 as an outsider. The console asks
  for the least role per route (`asTeam(api, tenant, "editor", …)`).
- **Existing members became viewers** (migration 0006): they keep their tool access and can now
  look at the console. Anyone added from now on by a grant or profile joins as a customer.
- **Suspension:** a `status` (active or suspended) on the row. `memberRole` treats suspended
  people as non-members, so the MCP endpoint, consent, and the console all refuse them on their
  next request. Grants and profiles stay, so resuming restores exactly what they had. Removing
  someone deletes their row and, through the foreign keys, their grants and profiles.
- **Finding people:** users get a `label` (usually an email) from their latest sign-in, through a
  three-argument `ensure_user`. Customers are listed newest first with keyset paging on
  (joined time, id); search is a case-insensitive substring of label, id, or note. Fine for tens of
  thousands; a trigram index is the next step if search gets slow. The cursor carries Postgres's
  own time text, since a JS `Date` drops microseconds and would skip rows.
- **Notes:** a short free-text note per person, seen only by the team.
- **Not yet:** customers created on first sign-in through the provider's own sign-in (3c step 3);
  inviting teammates by email (today they sign in once and an admin adds their account id);
  last-seen times (with usage, 3c step 4).
- **Rejected:** a separate `customers` table (above); a `kind` column beside the role (two fields
  that must agree); letting viewers run test calls (they spend the tenant's upstream key).

## D-039 Plan limits: daily and monthly allowances on access profiles

- **Context:** a provider sells plans (D-037). A plan already says which tools (an access profile,
  D-034); it also has to say how much each customer may call, so one customer can't use up the
  provider's own upstream quota and a free tier stays free.
- **Decision:** an access profile carries optional allowances: calls per UTC day and per calendar
  month (UTC), plus an https upgrade link. Each is per customer, across every toolset in the
  tenant. Left empty, an allowance doesn't apply.
- **More than one plan:** of the rules that allow a call, the most generous wins, separately for
  each limit (`callLimits` in core). A direct grant (D-034's per-person exception) has no limits,
  so it lifts them for that toolset. Limits follow plans, not roles: a team member holding a
  limited profile is limited too.
- **Where they're counted:** allowances in Postgres (`usage_counters`, one row per person, period,
  and period start). Taking one is a single upsert that only increments while the counter is under
  the limit, so concurrent calls can't overshoot; the month is taken before the day and given back
  if the day is full. Every admitted call counts, limited or not, which is also the usage the
  console shows and billing will read (3c step 4).
- **What counts:** calls that reach the API, plus ones it turns away for being busy. A call that
  fails before it's sent (invalid input, a missing key, our own throttling) is refunded: an
  agent's typo shouldn't cost a customer.
- **Telling the agent:** a refusal is a tool result, `limit_reached`, never an exception (D-020):
  which limit, when it starts over (`resetsAt`), and the upgrade link. Allowances are
  `retryable: false`, since an agent shouldn't wait hours; it should tell the person.
- **Counters are keyed to the tenant, not the membership,** so removing and re-adding someone
  doesn't reset what they've used.
- **The API stays the authority where it can see the caller.** These limits matter when calls go
  out with one shared key (the upstream can't tell customers apart) or when MCP access is sold as
  its own product. Once calls carry each customer's own credentials (P-20), the provider's API
  can enforce its own plans and these become an optional extra; usage is still counted, since
  it's what the console and billing show.
- **Postgres, not Redis, for counting:** two small upserts per call are noise next to the upstream
  call; allowances feed billing, so they must survive a crash; and self-hosting needs only
  Postgres (2b). Revisit at a sustained few thousand calls a second. `takeAllowance` and
  `refundAllowance` are the only seam to change.
- **Not yet:** a per-minute rate per customer (dropped for now: a burst limit across instances
  wants a shared store such as Redis; add it if usage calls for it), a cost per tool (an expensive call counting as several), plan changes from sign-in
  claims (3c step 3), the usage page and export (3c step 4), sweeping old counter rows.
- **Rejected:** counting from the audit log (writes only, and too heavy, D-037); limits per rule
  instead of per profile (a plan is one price, whatever toolsets it covers); retrying refused calls
  automatically (D-020).

## D-040 Our pricing unit: requests that reach the provider's API

- **Context:** cairnmcp needs a unit to charge providers by (D-037), and composite tools (3d)
  raised whether one tool call that makes several API requests counts once or several times.
- **Decision:** we charge a provider per upstream request: each request cairnmcp sends to their
  API. A composite tool with three steps is three requests. What counts is what D-039 already
  counts: requests that reach the API, plus ones it turns away for being busy; requests that fail
  before they're sent are not charged. Billing reads the same counters as allowances and usage.
- **Why requests, not bytes:** our cost per request is roughly flat (one fetch, an audit row, a
  counter update) and barely moves with response size, which the runtime already caps at 2 MB. A
  provider can't predict bytes (agents choose page sizes), and "GB a month" means nothing to
  someone buying an MCP server; requests are how providers already price their own APIs. Bytes
  may become a fair-use limit if a tenant's traffic is unusual, not a price.
- **Separate from the provider's own plans:** this is what we charge the provider. What a
  provider charges its customers stays theirs to set with allowances (D-039); a cost per tool (an
  expensive tool counting as several calls) remains an option for those plans, not something our
  pricing needs.
- **Not decided here:** the prices, the free tier, and tiers or overage.
- **Rejected:** per MCP tool call (a composite would hide its real cost); per byte (above).
