-- Access profiles (D-034): named permission sets a tenant assigns to members.
-- A member's access to a toolset is their direct grant (toolset_access) plus
-- every rule from their profiles. Tenant tables, isolated like the rest (D-024).

CREATE TABLE cairnmcp.access_profiles (
  tenant_id   cairnmcp.id_text NOT NULL REFERENCES cairnmcp.tenants (id) ON DELETE CASCADE,
  id          cairnmcp.slug NOT NULL,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text CHECK (length(description) <= 2000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

-- At most one rule per profile and toolset. `operations` NULL means every
-- tool the level allows; a list narrows it to those operations.
CREATE TABLE cairnmcp.profile_rules (
  tenant_id  cairnmcp.id_text NOT NULL,
  profile_id cairnmcp.slug NOT NULL,
  toolset_id cairnmcp.slug NOT NULL,
  level      text NOT NULL CHECK (level IN ('use', 'use_writes')),
  operations text[] CHECK (operations IS NULL OR cardinality(operations) BETWEEN 1 AND 2000),
  PRIMARY KEY (tenant_id, profile_id, toolset_id),
  FOREIGN KEY (tenant_id, profile_id) REFERENCES cairnmcp.access_profiles (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, toolset_id) REFERENCES cairnmcp.toolsets (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX profile_rules_toolset_idx ON cairnmcp.profile_rules (tenant_id, toolset_id);

CREATE TABLE cairnmcp.member_profiles (
  tenant_id  cairnmcp.id_text NOT NULL,
  user_id    cairnmcp.id_text NOT NULL,
  profile_id cairnmcp.slug NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, profile_id),
  FOREIGN KEY (tenant_id, profile_id) REFERENCES cairnmcp.access_profiles (tenant_id, id) ON DELETE CASCADE,
  -- Only members can hold a profile; leaving the tenant removes it.
  FOREIGN KEY (tenant_id, user_id) REFERENCES cairnmcp.memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX member_profiles_profile_idx ON cairnmcp.member_profiles (tenant_id, profile_id);

ALTER TABLE cairnmcp.access_profiles ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE cairnmcp.profile_rules   ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE cairnmcp.member_profiles ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON cairnmcp.access_profiles
  USING (tenant_id = cairnmcp.current_tenant_id()) WITH CHECK (tenant_id = cairnmcp.current_tenant_id());
CREATE POLICY tenant_isolation ON cairnmcp.profile_rules
  USING (tenant_id = cairnmcp.current_tenant_id()) WITH CHECK (tenant_id = cairnmcp.current_tenant_id());
CREATE POLICY tenant_isolation ON cairnmcp.member_profiles
  USING (tenant_id = cairnmcp.current_tenant_id()) WITH CHECK (tenant_id = cairnmcp.current_tenant_id());

-- No TRUNCATE: it ignores row-level security.
GRANT SELECT, INSERT, UPDATE, DELETE ON cairnmcp.access_profiles, cairnmcp.profile_rules, cairnmcp.member_profiles TO cairnmcp_app;
