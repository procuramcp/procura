-- The embedded OAuth authorization server (D-026). These tables are global,
-- not per tenant: clients, sign-in flows, and tokens belong to users, and a
-- token is bound to one MCP endpoint (and so one tenant) by its resource.
-- No RLS: they hold no tenant data, and secrets are stored only as hashes
-- (codes, refresh tokens, browser bindings) or encrypted (signing keys).

-- Clients registered with dynamic client registration (RFC 7591). Public
-- clients only: none of them has a secret.
CREATE TABLE cairnmcp.oauth_clients (
  id            text PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 64),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One authorization request, from /authorize to the code exchange. The row
-- moves through: created -> upstream sign-in started -> signed in -> code
-- issued -> code used. Its id is also the refresh-token family id.
CREATE TABLE cairnmcp.oauth_requests (
  id                  text PRIMARY KEY,
  client_id           text NOT NULL REFERENCES cairnmcp.oauth_clients (id) ON DELETE CASCADE,
  redirect_uri        text NOT NULL,
  code_challenge      text NOT NULL,
  state               text,
  resource            text NOT NULL,
  scope               text NOT NULL,
  -- Ties the flow to the browser that started sign-in (a cookie holds the secret).
  browser_hash        text,
  provider            text,
  upstream_state_hash text UNIQUE,
  upstream_nonce      text,
  upstream_verifier   text,
  user_id             cairnmcp.id_text REFERENCES cairnmcp.users (id) ON DELETE CASCADE,
  user_label          text,
  code_hash           text UNIQUE,
  code_expires_at     timestamptz,
  code_used_at        timestamptz,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_requests_expires_idx ON cairnmcp.oauth_requests (expires_at);

-- Refresh tokens rotate on every use. Reusing a spent one revokes its family.
CREATE TABLE cairnmcp.oauth_refresh_tokens (
  token_hash text PRIMARY KEY,
  family_id  text NOT NULL,
  client_id  text NOT NULL REFERENCES cairnmcp.oauth_clients (id) ON DELETE CASCADE,
  user_id    cairnmcp.id_text NOT NULL REFERENCES cairnmcp.users (id) ON DELETE CASCADE,
  resource   text NOT NULL,
  scope      text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_refresh_tokens_family_idx ON cairnmcp.oauth_refresh_tokens (family_id);

-- Access-token signing keys. The private key is wrapped by the KEK (D-019),
-- like tenant data keys. At most one active key at a time.
CREATE TABLE cairnmcp.oauth_signing_keys (
  kid             text PRIMARY KEY,
  alg             text NOT NULL CHECK (alg IN ('ES256')),
  public_jwk      jsonb NOT NULL,
  wrapped_private jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz
);
CREATE UNIQUE INDEX oauth_signing_keys_one_active ON cairnmcp.oauth_signing_keys ((true)) WHERE retired_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  cairnmcp.oauth_clients, cairnmcp.oauth_requests, cairnmcp.oauth_refresh_tokens
  TO cairnmcp_app;
GRANT SELECT, INSERT ON cairnmcp.oauth_signing_keys TO cairnmcp_app;
