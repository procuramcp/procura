-- A tenant's own sign-in (D-040): its customers sign in with the provider's
-- accounts, are created on first sign-in, and get profiles from their claims,
-- re-read whenever their cairnmcp token is refreshed.

-- One sign-in per tenant. `config` is core's SignInConfig (OIDC issuer, or
-- plain OAuth 2 URLs). The client secret is sealed with the tenant's data key
-- (vault `sealSecret`), so this row alone never reveals it.
CREATE TABLE cairnmcp.tenant_sign_in (
  tenant_id         cairnmcp.id_text PRIMARY KEY REFERENCES cairnmcp.tenants (id) ON DELETE CASCADE,
  config            jsonb NOT NULL,
  secret_iv         text,
  secret_ciphertext text,
  secret_tag        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((secret_iv IS NULL) = (secret_ciphertext IS NULL) AND (secret_iv IS NULL) = (secret_tag IS NULL))
);

-- Claim rules: whoever's sign-in claim `claim` equals `value` holds the profile.
CREATE TABLE cairnmcp.profile_claims (
  tenant_id  cairnmcp.id_text NOT NULL,
  profile_id cairnmcp.slug NOT NULL,
  claim      text NOT NULL CHECK (length(claim) BETWEEN 1 AND 200),
  value      text NOT NULL CHECK (length(value) BETWEEN 1 AND 200),
  PRIMARY KEY (tenant_id, profile_id, claim, value),
  FOREIGN KEY (tenant_id, profile_id) REFERENCES cairnmcp.access_profiles (tenant_id, id) ON DELETE CASCADE
);

-- Where an assignment came from. Sign-in replaces its own on every sign-in
-- and refresh, and never touches the team's ('manual'), so an exception the
-- team made survives a plan change.
ALTER TABLE cairnmcp.member_profiles
  ADD COLUMN via text NOT NULL DEFAULT 'manual' CHECK (via IN ('manual', 'sign_in'));

-- The provider's refresh token for one cairnmcp token family (one MCP client
-- connection), sealed. Used to re-read claims when that family refreshes.
-- One per family, so two clients of the same person never race to rotate it.
CREATE TABLE cairnmcp.upstream_grants (
  tenant_id  cairnmcp.id_text NOT NULL REFERENCES cairnmcp.tenants (id) ON DELETE CASCADE,
  family_id  text NOT NULL CHECK (length(family_id) BETWEEN 1 AND 100),
  user_id    cairnmcp.id_text NOT NULL REFERENCES cairnmcp.users (id) ON DELETE CASCADE,
  iv         text NOT NULL,
  ciphertext text NOT NULL,
  tag        text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, family_id)
);
CREATE INDEX upstream_grants_expires_idx ON cairnmcp.upstream_grants (expires_at);

ALTER TABLE cairnmcp.tenant_sign_in  ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE cairnmcp.profile_claims  ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE cairnmcp.upstream_grants ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON cairnmcp.tenant_sign_in
  USING (tenant_id = cairnmcp.current_tenant_id()) WITH CHECK (tenant_id = cairnmcp.current_tenant_id());
CREATE POLICY tenant_isolation ON cairnmcp.profile_claims
  USING (tenant_id = cairnmcp.current_tenant_id()) WITH CHECK (tenant_id = cairnmcp.current_tenant_id());
CREATE POLICY tenant_isolation ON cairnmcp.upstream_grants
  USING (tenant_id = cairnmcp.current_tenant_id()) WITH CHECK (tenant_id = cairnmcp.current_tenant_id());

-- No TRUNCATE: it ignores row-level security.
GRANT SELECT, INSERT, UPDATE, DELETE ON cairnmcp.tenant_sign_in, cairnmcp.profile_claims, cairnmcp.upstream_grants TO cairnmcp_app;

-- Expired grants span tenants, so deleting them is a narrow owner function like
-- user_tenants (0004): a policy for the owner role, open only while the
-- function sets app.purging.
CREATE POLICY owner_purge ON cairnmcp.upstream_grants FOR ALL TO CURRENT_USER
  USING (current_setting('app.purging', true) = 'on');

CREATE FUNCTION cairnmcp.purge_upstream_grants() RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = cairnmcp, pg_temp
  AS $$
DECLARE
  removed integer;
BEGIN
  PERFORM set_config('app.purging', 'on', true);
  DELETE FROM cairnmcp.upstream_grants WHERE expires_at < now();
  GET DIAGNOSTICS removed = ROW_COUNT;
  PERFORM set_config('app.purging', '', true);
  RETURN removed;
END
$$;

REVOKE ALL ON FUNCTION cairnmcp.purge_upstream_grants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cairnmcp.purge_upstream_grants() TO cairnmcp_app;
