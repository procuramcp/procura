# @procura/auth

The embedded OAuth 2.1 authorization server that issues tokens for the MCP endpoint. Design:
`docs/DECISIONS.md` D-026.

- **Metadata:** `/.well-known/oauth-authorization-server` (RFC 8414); the MCP endpoint's resource
  metadata names this server.
- **Clients** register themselves at `POST /oauth/register` (RFC 7591). All are public clients
  (no secret); redirect URIs must be https, loopback http, or a native app's own scheme.
- **Sign-in** is delegated to the OIDC providers in `PROCURA_OIDC_PROVIDERS`; procura never
  handles passwords. A user is that provider's issuer + subject.
- **Consent:** after sign-in, the person sees the app, the toolset, their access level, and where
  the app returns, and allows or denies. Only members with access to the toolset get this far.
- **Tokens:** `POST /oauth/token`. Authorization code with PKCE (S256 only); the code is single-use
  for 60 seconds. Access tokens are ES256 JWTs (`at+jwt`) for exactly one MCP endpoint
  (`aud` = its URL, RFC 8707), valid 15 minutes. Refresh tokens rotate on every use and last 30
  days; reusing a spent one, or a spent code, revokes everything issued from that sign-in.

Signing keys are created on first start and stored wrapped by the master key (D-019). It runs
inside `packages/server`.
