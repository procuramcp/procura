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
- **Later:** a Postgres `VaultStore` with RLS (milestone 2), a KMS `KeyWrapper` for the hosted
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

