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

- **Decision:** `Instant` = UTC ISO-8601 ending in `Z`. `LocalDate` = `YYYY-MM-DD` in the
  athlete's own time zone. Both are branded Zod types (`packages/core/src/time.ts`). Training-day
  keys, dated settings, and baselines use `LocalDate`; audit and ingest timestamps use `Instant`.
- **Why:** A late-evening workout belongs to the athlete's local day; mixing the two is a classic
  off-by-one-day bug, so the types keep them apart.

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

## D-015 Toolsets pin inputs; any policy issue fails the whole toolset

- **Decision:** A tool binding can pin input values (hidden from the agent), e.g. Intervals.icu
  athlete `id`. `resolveToolset` returns either all tools or a list of issues, never a partial set.
- **Why:** Pinning narrows what an agent can reach. Failing closed means a bad edit can't quietly
  serve a different set of tools than the one reviewed.
