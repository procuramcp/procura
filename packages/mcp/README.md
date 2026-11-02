# @cairnmcp/mcp

The MCP endpoint (Streamable HTTP, protocol 2025-11-25). An OAuth resource server: it checks tokens,
it doesn't issue them (D-022). Design: `docs/DECISIONS.md` D-025.

- **One endpoint per toolset:** `POST /mcp/{tenantId}/{toolsetId}`. Stateless, with JSON responses.
- **Tokens:** `Authorization: Bearer <JWT>` from a trusted issuer (the embedded one, plus any in
  `CAIRNMCP_TRUSTED_ISSUERS`), with `aud`
  set to the endpoint's exact URL (RFC 8707) and a `sub`. Without a valid token the endpoint
  answers 401 with a `WWW-Authenticate` header pointing at its protected-resource metadata
  (`/.well-known/oauth-protected-resource/mcp/{tenantId}/{toolsetId}`, RFC 9728).
- **Authorization (D-023), checked on every request:** the token's issuer and subject must belong to
  an active member of the tenant (team or customer, not suspended, D-038) who has access to the
  toolset. `tools/list` shows only the tools their level allows (`use`: reads; `use_writes`: also
  writes and destructive tools), and `tools/call` treats any other tool as unknown.

It runs as part of `packages/server`, together with the embedded authorization server
(`packages/auth`), whose tokens carry the cairnmcp user id as `sub`.
