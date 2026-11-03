# User stories

Who cairnmcp is for and what each of them needs to be able to do. The roadmap orders the work;
this file says what "done" means for the people using it. Why the focus is API providers: D-037.

Ids are stable (other docs cite them); new stories get the next number. Status is one of
**built**, **partial** (what's missing is noted), or **—** (not started).

## Who

| | Who | What they want | Pays? |
| --- | --- | --- | --- |
| **Provider** | A company or developer with an API and an OpenAPI document | One MCP server for all its customers, on its own domain, with different tools and limits per plan, and usage it can bill for | Yes: the main customer |
| **Customer** | A provider's customer, using an MCP client (Claude, ChatGPT, an IDE) | Connect, sign in with the account they already have, and use the tools their plan includes | No: pays the provider |
| **Team** | The provider's staff in the console: owners, admins, editors | Curate tools, decide what each plan gets, watch usage, handle support | (part of the provider) |
| **Individual** | Someone hosting a server for their own key, alone or with a few people | A working MCP server for an API they use, in minutes | Free tier: the on-ramp |

Running example: Intervals.icu offering an MCP server to its users, with its paid tier getting
write tools and higher limits. It has an OpenAPI document, OAuth, and paid plans, and it's
already our test API (`docs/sources/intervals-icu.md`).

Team members and customers are different people (D-037): a provider has a handful of the first
and up to tens of thousands of the second. They're stored, listed, and managed separately.

## Provider: set up

| Id | Story | Done when | Status |
| --- | --- | --- | --- |
| P-1 | As a provider, I add my API from its OpenAPI document (URL, Swagger UI page, paste, or file). | Preview shows operations and auth schemes before saving (D-035). | built |
| P-2 | I choose which operations become tools and how they're named and described. | Toolset editor: enable, rename, describe, pin inputs; reads on by default (D-016). | built |
| P-3 | I see which tools write or delete, and can correct a classification. | Side effects shown on every tool; heuristics only escalate, a person may lower one (D-005). | partial: shown, not yet editable in the console |
| P-4 | When my API changes, I update the source and see what changed before it reaches customers. | Diff of added, removed, and changed operations; toolsets and plans that use removed ones are flagged. | — |
| P-5 | I edit a toolset without changing what customers see until I publish it. | Draft and published versions; publish is one action and can be rolled back. | — |
| P-6 | My server runs on my domain, with my name and logo on sign-in and consent. | Custom domain with TLS; branded sign-in, consent, and server name and instructions. | — |
| P-7 | I can run cairnmcp myself, next to my API. | Published image, compose file, config docs (milestone 2b); private-network targets allowed explicitly (D-022). | partial: image exists, not published |
| P-8 | I combine several operations into one tool for a common task, so agents don't have to chain calls themselves. | Composite tools: ordered steps whose inputs come from the tool's inputs, pins, or earlier steps' outputs; side effect is the most severe step; stops at the first failure and says what ran (milestone 3d). | — |

## Provider: customers and plans

| Id | Story | Done when | Status |
| --- | --- | --- | --- |
| P-10 | My customers sign in with their existing account on my service; I don't create them one by one. | The tenant names its own OIDC or OAuth provider; a customer record is created on first sign-in (D-032). | — |
| P-11 | I define plans (e.g. Free, Pro) that decide which tools a customer can use. | A plan is an access profile: tools, level, and optional operation list (D-034). | partial: profiles exist, assigned only by hand to members |
| P-12 | A customer's plan follows what they pay for, without me syncing anything. | A claim in the sign-in token (`plan = pro`) picks the plan, re-read when the token refreshes, so a lapsed plan ends within minutes (D-032). | — |
| P-13 | Each plan has limits: requests per minute and a daily or monthly allowance per customer. | Limits enforced per customer across restarts and instances; a tool can count for more than one call. | partial: daily and monthly allowances on profiles, held across restarts and instances (D-039); no per-minute rate or cost per tool yet |
| P-14 | One customer can't use up my API's own rate limit for everyone. | Per-customer limits sit under the tenant-wide limit and the upstream's `Retry-After` (D-020). | built: plan limits per customer (D-039) under the tenant and source limits |
| P-15 | Plans can limit arguments, not just tools (e.g. Free may read at most 100 items). | Per-plan input pins and bounds, extending today's toolset pins (D-015, D-023). | — |
| P-16 | I find a customer, see their plan and usage, give them an exception, or suspend them. | Customer list that scales to tens of thousands: search, per-customer override, suspend. | built: search, paging, profiles, calls today and this month, direct grants (which lift plan limits), suspend, notes (D-038, D-039) |

## Provider: how my API knows who's calling

| Id | Story | Done when | Status |
| --- | --- | --- | --- |
| P-20 | Calls reach my API as the customer, so my own permissions still apply. | Per-user credentials from the customer's OAuth grant, stored and refreshed per user (D-032), or a signed identity header next to a service key (to decide, D-037). The MCP token itself is never forwarded. | — |
| P-21 | Some of my plans call my API with one shared service key. | Shared credential per source (today's mode), chosen per source. | built |

## Provider: usage and billing

| Id | Story | Done when | Status |
| --- | --- | --- | --- |
| P-30 | I see how my server is used: calls by tool, customer, and plan; errors; limit refusals. | Usage page over a chosen period. | — |
| P-31 | My billing system gets usage per customer so I can charge for it. | Usage export (API and CSV) and a webhook per period; cairnmcp meters and enforces, it doesn't take payments (D-037). | — |
| P-32 | I can answer "what did this customer's agent do?" | Audit log per call: who, tool, inputs, outcome (D-020); retention set by the provider. | partial: recorded, not shown in the console; no retention setting |

## Customer

| Id | Story | Done when | Status |
| --- | --- | --- | --- |
| C-1 | I add the provider's MCP URL to my client and sign in with my existing account. | Standard MCP OAuth: discovery, client registration, consent (D-025, D-026), through the provider's sign-in (P-10). | partial: works with the embedded sign-in |
| C-2 | I see only the tools my plan includes. | `tools/list` filtered per caller; `tools/call` re-checked (D-023). | built |
| C-3 | When I hit a limit, I'm told which one, when it resets, and how to get more. | Limit errors as tool results with reset time and the provider's upgrade link (D-020). | built: `limit_reached` with `resetsAt` and the upgrade link (D-039) |
| C-4 | When I upgrade, the new tools appear without reconnecting. | Plan from refreshed claims (P-12); access checked per request (D-034). | — |
| C-5 | My data stays mine: my calls use my account, not someone else's. | Per-user credentials (P-20); isolation tests cover customers. | partial: isolation tests cover customers (D-038); per-user credentials not yet |

## Team

| Id | Story | Done when | Status |
| --- | --- | --- | --- |
| T-1 | As an owner, I invite teammates as admins or editors. | Invite by email; roles owner, admin, editor, viewer; separate from customers. | partial: added by account id in the console (D-038), no email invites yet |
| T-2 | Editors curate tools and plans; only owners and admins change keys, sign-in, and billing settings. | Role checks in the console API. | built: viewer, editor, admin, owner (D-038) |
| T-3 | I see who changed a toolset, plan, or key, and when. | Change history for console edits. | — |

## Individual

| Id | Story | Done when | Status |
| --- | --- | --- | --- |
| I-1 | I host an MCP server for an API I use, with my own key, in a few minutes. | Sign up, add API, set key, copy URL (P-1, P-2, D-035). | partial: tenants created through the admin CLI |
| I-2 | I share it with a few people and choose what each may do. | Customers or viewers, with profiles (D-034, D-038). | built |
| I-3 | When I'm ready to offer it to others, I turn on provider features without starting over. | Same tenant, same toolsets; plans and provider sign-in are added on. | — |

## Open questions

Tracked in D-037 until answered:

- **How the upstream learns the caller** (P-20): per-user OAuth tokens (D-032) need the provider
  to have OAuth; a signed identity header is simpler for providers whose API we sit in front of.
  Likely both, header first for self-hosted providers.
- **A first real provider.** Intervals.icu is the working example; a real design partner would
  settle P-6 and P-31 details.
- **Self-hosting for providers:** hosted first (D-018), but larger API companies may require it
  early, which would move milestone 2b up.
