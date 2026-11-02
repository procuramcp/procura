-- Team and customers (D-038). Everyone in a tenant is still one memberships
-- row, so direct grants (toolset_access) and profiles (member_profiles) keep
-- working for both; the role says which kind of person they are.
--
--   owner, admin, editor, viewer  the team: may open the console
--   customer                      calls tools only, never the console
--
-- Before this, `member` meant "calls tools, no console". Those people become
-- viewers: they keep their tool access and can now look at the console.

ALTER TABLE cairnmcp.memberships DROP CONSTRAINT memberships_role_check;
-- Row-level security is forced on the owner too, so with no tenant set this
-- UPDATE would see no rows. Lift it for this one statement; the migration is a
-- single transaction, so nothing else runs in between.
ALTER TABLE cairnmcp.memberships NO FORCE ROW LEVEL SECURITY;
UPDATE cairnmcp.memberships SET role = 'viewer' WHERE role = 'member';
ALTER TABLE cairnmcp.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE cairnmcp.memberships
  ADD CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'admin', 'editor', 'viewer', 'customer')),
  -- Suspended people are refused everywhere (MCP, consent, console) but keep
  -- their grants and profiles, so resuming them restores what they had.
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  -- The team's own words about someone ("trial until March", a ticket link).
  ADD COLUMN note text CHECK (length(note) <= 2000);

-- Listing the team or paging through customers reads one role at a time.
CREATE INDEX memberships_role_idx ON cairnmcp.memberships (tenant_id, role, created_at);

-- A readable name for each user (usually an email), from their latest sign-in,
-- so the team can find a customer by something other than an id.
ALTER TABLE cairnmcp.users ADD COLUMN label text CHECK (length(label) <= 320);

-- ensure_user (0001) plus the label. The two-argument version stays for
-- callers that have no label.
CREATE FUNCTION cairnmcp.ensure_user(user_issuer text, user_subject text, user_label text) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = cairnmcp, pg_temp
  AS $$
DECLARE
  found_id text;
  clean_label text := nullif(left(btrim(user_label), 320), '');
BEGIN
  INSERT INTO cairnmcp.users (issuer, subject, label) VALUES (user_issuer, user_subject, clean_label)
    ON CONFLICT (issuer, subject) DO UPDATE SET label = coalesce(EXCLUDED.label, users.label)
    RETURNING id INTO found_id;
  RETURN found_id;
END
$$;

REVOKE ALL ON FUNCTION cairnmcp.ensure_user(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cairnmcp.ensure_user(text, text, text) TO cairnmcp_app;

-- The console lists only tenants where the user is an active team member:
-- customers and suspended people don't get in.
CREATE OR REPLACE FUNCTION cairnmcp.user_tenants(member_user_id text)
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
    WHERE m.user_id = member_user_id AND m.role <> 'customer' AND m.status = 'active'
    ORDER BY t.name;
  PERFORM set_config('app.lookup_user_id', prior, true);
END
$$;
