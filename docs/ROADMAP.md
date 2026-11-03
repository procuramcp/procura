# Roadmap

Milestones from the planning handoff, with status. Numbers are stable: other docs refer to
them, so new work gets a letter suffix (e.g. 2b) instead of renumbering. What each kind of user
needs to be able to do is in `docs/USER-STORIES.md` (story ids like P-13 below).

**Order** (D-037: API providers are the main customer): finish 3 (source updates with a diff),
then 3c, then the rest of 3b, then 2b. 3d (composite tools) comes after 3c; 4 and 5 wait. 2b moves up if a provider needs to run
cairnmcp itself.

| | Milestone | Status |
| --- | --- | --- |
| 1 | IR, OpenAPI ingestor, runtime, vault; single tenant; Intervals.icu end to end | ✅ Done 2026-10-30: first live call read real activities (see `docs/sources/intervals-icu.md`) |
| 2 | Tenancy (RLS plus isolation tests), per-member toolset access, MCP server with OAuth; the app container image and our hosted deployment of it. Design rules below | Started: `packages/db` with RLS and isolation tests (D-024); MCP endpoint as a resource server (D-025); embedded authorization server with OIDC sign-in (D-026); container image built and smoke-tested in CI (D-027); Neon set up; deployed on an Oracle Cloud Always Free VM behind Caddy, infrastructure in Terraform (D-029); push to main deploys there after CI (D-036). admin CLI for tenants, sources, toolsets, access, and credentials (D-030) |
| 2b | Self-host: published image, `docker compose`, config and upgrade docs | — |
| 3 | Curation UI, side-effect classification review, egress hardening (with a configurable egress policy, see 3b) | Started: curation console at `/app` (D-033): sign-in, toolset editor (tools, names, descriptions, pins, write tools marked), access, and a tool test panel; access profiles, named permission sets assigned to members (D-034); adding APIs from OpenAPI (URL, Swagger UI page, paste, or file) and their keys (D-035). Next: updating a source with a diff of what changed |
| 3b | Custom and on-behalf-of upstream auth; provider-hosted servers with per-user credentials (D-032); external identity providers for the MCP endpoint; claim-based tool policies; private-network targets for self-hosted deployments (D-022, D-023) | — |
| 3c | Provider features: customers separate from the team, plans with per-customer limits and allowances, the provider's own sign-in with plans from claims, usage page and export, draft and published toolsets, branding. Details below | Next after 3 |
| 3d | Composite tools: one tool that runs several API calls in order (P-8). Details below | After 3c |
| 4 | GraphQL ingestor | — |
| 5 | Docs-page ingestor with the verification loop (experimental) | — |
| 6 | ~~Analyzer tool pack~~ | Removed: data analysis is a separate project; cairnmcp returns API output as-is (D-021) |
| 7 | Docs: architecture diagram, threat model, decisions doc, eval report | Ingest eval started (`packages/eval`) |
| — | Hybrid runner: hosted control plane, credential-holding runner in the user's infra | Parked until users ask (D-018) |

## Milestone 2: design rules

Cheap now, expensive to retrofit (D-022, D-023):

- **Caller identity reaches the runtime.** `invoke` and the credential lookup receive who is calling
  (user id, token claims), even though today's credential providers ignore it. On-behalf-of calls
  in 3b depend on it.
- **Token checking is separate from token issuing.** The MCP endpoint validates tokens as an
  OAuth resource server (with protected-resource metadata, RFC 9728). The embedded authorization
  server is one issuer it trusts; a company's own identity provider can be another.
- **cairnmcp authorizes every call itself** (D-023). A token resolves to tenant, user, and role;
  each member has access per toolset (`use` for reads, `use_writes` to also call write and
  destructive tools that the toolset enables). Checked on `tools/list` (hide what the caller can't
  use) and again on `tools/call` (never trust that the client only calls what it was shown).
- **The audit log records who.** Every entry carries the acting user, not just the tenant.
- **Isolation tests cover members too:** a member without access to a toolset can't list or call
  its tools, and a read-only member can't call a write tool even if they know its name.

## Milestone 2b: self-host

Done when someone can run their own cairnmcp with only Docker, a Postgres URL, and a master key:

- The same container image we deploy, published with version tags.
- A `docker compose` file (app and Postgres) that works out of the box on a laptop.
- `.env.example` documenting every setting; the app validates its config at startup and refuses
  to start with a clear message if something required is missing.
- Docs for running behind a domain with TLS, setting up OAuth for the MCP endpoint, backups, and
  upgrades (including database migrations).
- CI builds the image and runs the compose setup through a smoke test.

## Milestone 3c: provider features

For an API provider serving all its customers from one MCP server (D-032, D-037). In this order;
each step is usable on its own:

1. **Customers separate from the team** (P-16, T-1), ✅ D-038: roles owner, admin, editor, viewer,
   and customer; customers searchable and paged, with suspend, notes, and per-customer grants and
   profiles; isolation tests cover them. Creating them on first sign-in comes with step 3.
2. **Plans with limits** (P-11, P-13, P-14, C-3), ✅ D-039: an access profile has per-customer
   daily and monthly allowances and an upgrade link, counted in Postgres; `limit_reached` says
   which limit, when it starts over, and where to upgrade. Left for later: a per-minute rate per
   customer (with a shared store once there's more than one instance), a cost per tool, and
   turning the upstream's own quota errors into `limit_reached`.
3. **The provider's sign-in, plans from claims** (P-10, P-12, C-1, C-4): moved here from 3b. The
   tenant names its OIDC or OAuth provider; a claim picks the plan and is re-read on token refresh.
4. **Usage** (P-30, P-31, P-32): a usage page by tool, customer, and plan; export and a webhook
   per period for the provider's billing. Small per-call counters, separate from the audit log;
   audit retention as a setting.
5. **How the upstream learns the caller** (P-20, C-5): per-user OAuth credentials (D-032) or a
   service key plus a signed identity header; decided in D-037's open question before this step.
6. **Drafts and branding** (P-5, P-6): draft and published toolset versions; custom domain,
   branded sign-in and consent.

## Milestone 3d: composite tools

A provider builds one tool for a task that takes several calls (e.g. "find the customer by
email, then list their open invoices"), so agents make one call instead of chaining several
themselves and getting the order or the ids wrong (P-8). Speakeasy's Gram offers this as
"custom tools".

- **Declarative, no code:** a composite is an ordered list of steps over the source's
  operations, each step's inputs taken from the tool's inputs, a pinned value, or an earlier
  step's output (a path into its JSON). No loops or branches at first. The hosted service never
  runs customer code (same rule as 3b).
- **Stored with the toolset,** edited in the console next to the other tools, and tested in the
  tool test panel step by step.
- **Side effect is the most severe step,** so a composite with any write step is a write tool
  and needs `use_writes` (D-005, D-023). Each step is still checked against egress rules and
  the toolset's pins.
- **Fail closed, report what ran:** stop at the first failing step and return which step failed
  and which earlier steps already ran (writes are not rolled back), as a tool result (D-020).
- **Audit and limits per step:** every upstream call is audited as today, tagged with the
  composite. Each step is one upstream request, so it counts once per step against plan
  allowances and our pricing (D-040).
- **Source updates:** a composite that uses a removed or changed operation is flagged in the
  source diff (P-4) and fails closed until fixed (D-015).

## Milestone 3b: custom and on-behalf-of auth

For teams exposing internal APIs, often from an OpenAPI document they already generate a client from,
and for API providers hosting one MCP server for all their customers (D-032).

- **Provider-hosted, first step** (D-032; the sign-in, claims, and per-user credentials now come
  in 3c, D-037): a tenant's own sign-in provider; a `per_user`
  credential mode per source, filled by the sign-in itself when the provider is also the
  upstream's OAuth server (tokens stored and refreshed per user); claim-based access (e.g.
  `plan = premium` gets `use`) re-checked on refresh; rate limits per user.

- **Inbound:** the MCP endpoint accepts tokens from an external identity provider (Okta, Entra,
  Google Workspace, and the like) by configuration, alongside the embedded one.
- **Outbound, declarative** (hosted and self-hosted): header templates (several headers, static
  values), tokens fetched from an internal endpoint with a non-standard request and cached, and
  request-signing presets (HMAC, AWS SigV4-style).
- **Outbound, on-behalf-of:** credentials derived per call from the caller's inbound token by token
  exchange (RFC 8693), so calls run as the user rather than a shared account and nothing is stored
  in the vault.
- **Outbound, custom code** (self-host only): a small provider interface ("given this request and
  credential, add or sign headers") so a team can reuse the auth middleware from its existing
  client. Not offered on the hosted service, which would mean running customer code.
- **mTLS client certificates** (self-host only), set on the egress connection.
- **Egress policy by deployment:** hosted stays public-internet-only; self-hosted can allow named
  private hosts explicitly. Never "allow everything".
- **Claim-based policies:** identity-provider groups or roles map to toolsets and tools (e.g.
  `eng-oncall` may call write tools; everyone else reads), and policies can constrain arguments per
  caller (e.g. only these project ids), extending what pinned inputs do for everyone today. Start
  with simple declarative rules; if they aren't enough, use an established engine (Cedar or OPA)
  rather than a home-grown one.
- Out of scope: interactive per-request login (browser sessions, MFA prompts), which agents can't
  complete.
