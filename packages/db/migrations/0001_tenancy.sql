-- Tenancy, members, sources, toolsets, vault, audit (D-024).
--
-- Runs as the owner role, which owns every object here. The app connects as a
-- different login role that is a member of `cairnmcp_app` (NOLOGIN, created
-- before migrations run; see README). Tenant isolation is enforced by
-- row-level security keyed on `app.tenant_id`, which the app sets per
-- transaction with set_config(..., true). Unset means no rows.

-- The migrator has already created the cairnmcp schema.
REVOKE ALL ON SCHEMA cairnmcp FROM PUBLIC;
GRANT USAGE ON SCHEMA cairnmcp TO cairnmcp_app;

-- The tenant of the current transaction, or NULL. After a transaction ends,
-- a once-set custom setting reads as '' rather than NULL, hence nullif.
CREATE FUNCTION cairnmcp.current_tenant_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '') $$;

-- Same shape as TenantId / UserId in core.
CREATE DOMAIN cairnmcp.id_text AS text CHECK (VALUE ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$');
CREATE DOMAIN cairnmcp.slug AS text CHECK (VALUE ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(VALUE) <= 64);

-- Tenants -------------------------------------------------------------------

CREATE TABLE cairnmcp.tenants (
  id         cairnmcp.id_text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Users are global: one row per (issuer, subject). Not a tenant table, so RLS
-- is enabled but not forced: the app sees only users who are members of the
-- current tenant, and the owner (SECURITY DEFINER functions) sees all.
CREATE TABLE cairnmcp.users (
  id         cairnmcp.id_text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  issuer     text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2000),
  subject    text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);

CREATE TABLE cairnmcp.memberships (
  tenant_id  cairnmcp.id_text NOT NULL REFERENCES cairnmcp.tenants (id) ON DELETE CASCADE,
  user_id    cairnmcp.id_text NOT NULL REFERENCES cairnmcp.users (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON cairnmcp.memberships (user_id);

-- Sources and toolsets ------------------------------------------------------

CREATE TABLE cairnmcp.sources (
  tenant_id  cairnmcp.id_text NOT NULL REFERENCES cairnmcp.tenants (id) ON DELETE CASCADE,
  id         cairnmcp.slug NOT NULL,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- The source's IR document (core IrDocument).
  ir         jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE cairnmcp.toolsets (
  tenant_id  cairnmcp.id_text NOT NULL,
  id         cairnmcp.slug NOT NULL,
  source_id  cairnmcp.slug NOT NULL,
  -- The toolset (core Toolset).
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  -- Composite: a toolset can only point at a source of its own tenant.
  FOREIGN KEY (tenant_id, source_id) REFERENCES cairnmcp.sources (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE cairnmcp.toolset_access (
  tenant_id  cairnmcp.id_text NOT NULL,
  toolset_id cairnmcp.slug NOT NULL,
  user_id    cairnmcp.id_text NOT NULL,
  level      text NOT NULL CHECK (level IN ('use', 'use_writes')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, toolset_id, user_id),
  FOREIGN KEY (tenant_id, toolset_id) REFERENCES cairnmcp.toolsets (tenant_id, id) ON DELETE CASCADE,
  -- Only members of this tenant can be granted access; leaving the tenant removes it.
  FOREIGN KEY (tenant_id, user_id) REFERENCES cairnmcp.memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX toolset_access_user_idx ON cairnmcp.toolset_access (tenant_id, user_id);

-- Vault ---------------------------------------------------------------------

-- One wrapped data key per tenant (D-019). Base64 fields, as the vault produces them.
CREATE TABLE cairnmcp.data_keys (
  tenant_id  cairnmcp.id_text PRIMARY KEY REFERENCES cairnmcp.tenants (id) ON DELETE CASCADE,
  key_id     text NOT NULL,
  iv         text NOT NULL,
  ciphertext text NOT NULL,
  tag        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cairnmcp.credentials (
  tenant_id  cairnmcp.id_text NOT NULL,
  id         text NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  source_id  cairnmcp.slug NOT NULL,
  scheme_id  text NOT NULL CHECK (scheme_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  kind       text NOT NULL CHECK (kind IN ('basic', 'bearer', 'api_key', 'oauth2')),
  iv         text NOT NULL,
  ciphertext text NOT NULL,
  tag        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES cairnmcp.sources (tenant_id, id) ON DELETE CASCADE,
  -- The data key must exist first, and can't be deleted while credentials use it.
  FOREIGN KEY (tenant_id) REFERENCES cairnmcp.data_keys (tenant_id)
);
CREATE INDEX credentials_source_idx ON cairnmcp.credentials (tenant_id, source_id);

-- Audit ---------------------------------------------------------------------

-- Append-only for the app: no UPDATE or DELETE grant or policy. Deliberately
-- no foreign keys to sources or memberships, so entries outlive what they name.
CREATE TABLE cairnmcp.audit_events (
  tenant_id     cairnmcp.id_text NOT NULL REFERENCES cairnmcp.tenants (id) ON DELETE CASCADE,
  seq           bigint GENERATED ALWAYS AS IDENTITY,
  invocation_id text NOT NULL,
  actor_user_id cairnmcp.id_text NOT NULL REFERENCES cairnmcp.users (id),
  at            timestamptz NOT NULL,
  phase         text NOT NULL CHECK (phase IN ('intent', 'outcome')),
  source_id     text NOT NULL,
  tool_name     text NOT NULL,
  operation_id  text NOT NULL,
  side_effect   text NOT NULL CHECK (side_effect IN ('read', 'write', 'destructive')),
  method        text NOT NULL,
  path_template text NOT NULL,
  input         jsonb NOT NULL,
  outcome       jsonb,
  PRIMARY KEY (tenant_id, seq),
  CHECK ((phase = 'outcome') = (outcome IS NOT NULL))
);
CREATE INDEX audit_events_invocation_idx ON cairnmcp.audit_events (tenant_id, invocation_id);

-- Row-level security ----------------------------------------------------------

ALTER TABLE cairnmcp.tenants        ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE cairnmcp.memberships    ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE cairnmcp.sources        ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE cairnmcp.toolsets       ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE cairnmcp.toolset_access ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE cairnmcp.data_keys      ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE cairnmcp.credentials    ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE cairnmcp.audit_events   ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE cairnmcp.users          ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON cairnmcp.tenants
  USING (id = cairnmcp.current_tenant_id()) WITH CHECK (id = cairnmcp.current_tenant_id());

CREATE POLICY tenant_isolation ON cairnmcp.memberships
  USING (tenant_id = cairnmcp.current_tenant_id()) WITH CHECK (tenant_id = cairnmcp.current_tenant_id());
CREATE POLICY tenant_isolation ON cairnmcp.sources
  USING (tenant_id = cairnmcp.current_tenant_id()) WITH CHECK (tenant_id = cairnmcp.current_tenant_id());
CREATE POLICY tenant_isolation ON cairnmcp.toolsets
  USING (tenant_id = cairnmcp.current_tenant_id()) WITH CHECK (tenant_id = cairnmcp.current_tenant_id());
CREATE POLICY tenant_isolation ON cairnmcp.toolset_access
  USING (tenant_id = cairnmcp.current_tenant_id()) WITH CHECK (tenant_id = cairnmcp.current_tenant_id());
CREATE POLICY tenant_isolation ON cairnmcp.data_keys
  USING (tenant_id = cairnmcp.current_tenant_id()) WITH CHECK (tenant_id = cairnmcp.current_tenant_id());
CREATE POLICY tenant_isolation ON cairnmcp.credentials
  USING (tenant_id = cairnmcp.current_tenant_id()) WITH CHECK (tenant_id = cairnmcp.current_tenant_id());

-- Audit: read and append only, no UPDATE or DELETE policy.
CREATE POLICY audit_read ON cairnmcp.audit_events FOR SELECT
  USING (tenant_id = cairnmcp.current_tenant_id());
CREATE POLICY audit_append ON cairnmcp.audit_events FOR INSERT
  WITH CHECK (tenant_id = cairnmcp.current_tenant_id());

-- The app sees users who are members of the current tenant (memberships is
-- itself filtered by tenant). Writes go through the functions below.
CREATE POLICY members_of_current_tenant ON cairnmcp.users FOR SELECT
  USING (EXISTS (SELECT 1 FROM cairnmcp.memberships m WHERE m.user_id = users.id));

-- Grants ---------------------------------------------------------------------
-- No TRUNCATE anywhere: it ignores row-level security.

GRANT SELECT, UPDATE (name) ON cairnmcp.tenants TO cairnmcp_app;
GRANT SELECT ON cairnmcp.users TO cairnmcp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  cairnmcp.memberships, cairnmcp.sources, cairnmcp.toolsets, cairnmcp.toolset_access,
  cairnmcp.data_keys, cairnmcp.credentials
  TO cairnmcp_app;
GRANT SELECT, INSERT ON cairnmcp.audit_events TO cairnmcp_app;

-- Cross-tenant operations -------------------------------------------------------
-- The only way to act outside the current tenant. Each does one narrow thing,
-- runs as the owner with a fixed search_path, and is callable only by the app.

-- Create a tenant with `owner_user_id` as its owner. Points app.tenant_id at
-- the new tenant so the inserts pass the forced RLS policies, then puts the
-- caller's value back. (A function-level SET clause would do this, but needs
-- superuser for a custom setting.) On error the transaction aborts, which
-- discards the change too.
CREATE FUNCTION cairnmcp.create_tenant(tenant_name text, owner_user_id text) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = cairnmcp, pg_temp
  AS $$
DECLARE
  new_id text := gen_random_uuid()::text;
  prior text := coalesce(current_setting('app.tenant_id', true), '');
BEGIN
  PERFORM set_config('app.tenant_id', new_id, true);
  INSERT INTO cairnmcp.tenants (id, name) VALUES (new_id, tenant_name);
  INSERT INTO cairnmcp.memberships (tenant_id, user_id, role) VALUES (new_id, owner_user_id, 'owner');
  PERFORM set_config('app.tenant_id', prior, true);
  RETURN new_id;
END
$$;

-- The user for a validated token's issuer and subject, or NULL.
CREATE FUNCTION cairnmcp.find_user(user_issuer text, user_subject text) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = cairnmcp, pg_temp
  AS $$ SELECT id FROM cairnmcp.users WHERE issuer = user_issuer AND subject = user_subject $$;

-- Find or create the user for a validated token's issuer and subject.
CREATE FUNCTION cairnmcp.ensure_user(user_issuer text, user_subject text) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = cairnmcp, pg_temp
  AS $$
DECLARE
  found_id text;
BEGIN
  INSERT INTO cairnmcp.users (issuer, subject) VALUES (user_issuer, user_subject)
    ON CONFLICT (issuer, subject) DO NOTHING
    RETURNING id INTO found_id;
  IF found_id IS NULL THEN
    SELECT id INTO found_id FROM cairnmcp.users WHERE issuer = user_issuer AND subject = user_subject;
  END IF;
  RETURN found_id;
END
$$;

REVOKE ALL ON FUNCTION cairnmcp.create_tenant(text, text), cairnmcp.find_user(text, text), cairnmcp.ensure_user(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cairnmcp.create_tenant(text, text), cairnmcp.find_user(text, text), cairnmcp.ensure_user(text, text) TO cairnmcp_app;
