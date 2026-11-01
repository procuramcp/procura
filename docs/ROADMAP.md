# Roadmap

Milestones from the planning handoff, with status. Numbers are stable: other docs refer to
them, so new work gets a letter suffix (e.g. 2b) instead of renumbering.

| | Milestone | Status |
| --- | --- | --- |
| 1 | IR, OpenAPI ingestor, runtime, vault; single tenant; Intervals.icu end to end | ✅ Done 2026-10-30: first live call read real activities (see `docs/sources/intervals-icu.md`) |
| 2 | Tenancy (RLS plus isolation tests), per-member toolset access, MCP server with OAuth; the app container image and our hosted deployment of it. Design rules below | Started: `packages/db` with RLS and isolation tests (D-024); MCP endpoint as a resource server (D-025); embedded authorization server with OIDC sign-in (D-026); container image built and smoke-tested in CI (D-027); Neon set up; deployed on an Oracle Cloud Always Free VM behind Caddy, infrastructure in Terraform (D-029). Next: tooling to create tenants, sources, and toolsets |
| 2b | Self-host: published image, `docker compose`, config and upgrade docs | — |
| 3 | Curation UI, side-effect classification review, egress hardening (with a configurable egress policy, see 3b) | — |
| 3b | Custom and on-behalf-of upstream auth; external identity providers for the MCP endpoint; claim-based tool policies; private-network targets for self-hosted deployments (D-022, D-023) | — |
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

## Milestone 3b: custom and on-behalf-of auth

For teams exposing internal APIs, often from an OpenAPI document they already generate a client from.

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
