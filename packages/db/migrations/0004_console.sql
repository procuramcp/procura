-- The curation console (D-033): browser sign-in and sessions, and the list of
-- tenants a user belongs to. Like the OAuth tables (0002), the session tables
-- are global and hold secrets only as hashes.

-- One console sign-in in progress, from /app/login to the provider's callback.
CREATE TABLE cairnmcp.console_logins (
  state_hash   text PRIMARY KEY,
  provider     text NOT NULL,
  nonce        text NOT NULL,
  verifier     text NOT NULL,
  -- Ties the sign-in to the browser that started it (a cookie holds the secret).
  browser_hash text NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX console_logins_expires_idx ON cairnmcp.console_logins (expires_at);

CREATE TABLE cairnmcp.console_sessions (
  token_hash text PRIMARY KEY,
  user_id    cairnmcp.id_text NOT NULL REFERENCES cairnmcp.users (id) ON DELETE CASCADE,
  user_label text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX console_sessions_expires_idx ON cairnmcp.console_sessions (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON cairnmcp.console_logins, cairnmcp.console_sessions TO cairnmcp_app;

-- The tenants a user is a member of, with their role. Cross-tenant by nature,
-- so it is a narrow SECURITY DEFINER function like find_user (0001). Row-level
-- security is forced on the owner too, so two read policies let the owner role
-- (CURRENT_USER while migrating) see one user's memberships while
-- app.lookup_user_id is set. The app role can't use them: they name only the
-- owner, and the app reaches them only through this function.
CREATE POLICY owner_member_lookup ON cairnmcp.memberships FOR SELECT TO CURRENT_USER
  USING (user_id = nullif(current_setting('app.lookup_user_id', true), ''));
CREATE POLICY owner_member_lookup ON cairnmcp.tenants FOR SELECT TO CURRENT_USER
  USING (EXISTS (SELECT 1 FROM cairnmcp.memberships m WHERE m.tenant_id = tenants.id));

CREATE FUNCTION cairnmcp.user_tenants(member_user_id text)
  RETURNS TABLE (tenant_id text, tenant_name text, role text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = cairnmcp, pg_temp
  AS $$
#variable_conflict use_column
DECLARE
  prior text := coalesce(current_setting('app.lookup_user_id', true), '');
BEGIN
  PERFORM set_config('app.lookup_user_id', member_user_id, true);
  RETURN QUERY
    SELECT t.id::text, t.name, m.role
    FROM cairnmcp.memberships m JOIN cairnmcp.tenants t ON t.id = m.tenant_id
    WHERE m.user_id = member_user_id
    ORDER BY t.name;
  PERFORM set_config('app.lookup_user_id', prior, true);
END
$$;

REVOKE ALL ON FUNCTION cairnmcp.user_tenants(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cairnmcp.user_tenants(text) TO cairnmcp_app;
