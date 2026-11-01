# @cairnmcp/mcp

The MCP endpoint (Streamable HTTP, protocol 2025-11-25). An OAuth resource server: it checks tokens,
it doesn't issue them (D-022). Design: `docs/DECISIONS.md` D-025.

- **One endpoint per toolset:** `POST /mcp/{tenantId}/{toolsetId}`. Stateless, with JSON responses.
- **Tokens:** `Authorization: Bearer <JWT>` from an issuer in `CAIRNMCP_TRUSTED_ISSUERS`, with `aud`
  set to the endpoint's exact URL (RFC 8707) and a `sub`. Without a valid token the endpoint
  answers 401 with a `WWW-Authenticate` header pointing at its protected-resource metadata
  (`/.well-known/oauth-protected-resource/mcp/{tenantId}/{toolsetId}`, RFC 9728).
- **Authorization (D-023), checked on every request:** the token's issuer and subject must belong to
  a member of the tenant who has access to the toolset. `tools/list` shows only the tools their
  level allows (`use`: reads; `use_writes`: also writes and destructive tools), and `tools/call`
  treats any other tool as unknown.

Run it (after migrating, see `packages/db/README.md`):

```bash
pnpm --filter @cairnmcp/mcp start
```

Settings are environment variables, validated at startup; see the root `.env.example`.
