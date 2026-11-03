-- Source history and checks (D-049): the versions an update replaced, so one can
-- be restored, and when each source's document was last checked for a new version.

-- A row is a source's IR as it was just before an update replaced it.
CREATE TABLE cairnmcp.source_versions (
  tenant_id   cairnmcp.id_text NOT NULL,
  source_id   cairnmcp.slug NOT NULL,
  version     integer NOT NULL CHECK (version >= 1),
  ir          jsonb NOT NULL,
  replaced_at timestamptz NOT NULL DEFAULT now(),
  -- Who applied the update (null when the CLI did, or the person is gone).
  replaced_by cairnmcp.id_text REFERENCES cairnmcp.users (id) ON DELETE SET NULL,
  PRIMARY KEY (tenant_id, source_id, version),
  FOREIGN KEY (tenant_id, source_id) REFERENCES cairnmcp.sources (tenant_id, id) ON DELETE CASCADE
);

-- The latest check of a source's document URL for a new version.
CREATE TABLE cairnmcp.source_checks (
  tenant_id       cairnmcp.id_text NOT NULL,
  source_id       cairnmcp.slug NOT NULL,
  checked_at      timestamptz NOT NULL,
  status          text NOT NULL CHECK (status IN ('current', 'changed', 'failed')),
  -- Of the fetched text, so an unchanged document isn't ingested again.
  document_sha256 text CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  -- {added, removed, changed} for 'changed'; {message} for 'failed'.
  summary         jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, source_id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES cairnmcp.sources (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX source_checks_checked_idx ON cairnmcp.source_checks (checked_at);

ALTER TABLE cairnmcp.source_versions ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE cairnmcp.source_checks   ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cairnmcp.source_versions
  USING (tenant_id = cairnmcp.current_tenant_id()) WITH CHECK (tenant_id = cairnmcp.current_tenant_id());
CREATE POLICY tenant_isolation ON cairnmcp.source_checks
  USING (tenant_id = cairnmcp.current_tenant_id()) WITH CHECK (tenant_id = cairnmcp.current_tenant_id());

-- No TRUNCATE: it ignores row-level security.
GRANT SELECT, INSERT, UPDATE, DELETE ON cairnmcp.source_versions, cairnmcp.source_checks TO cairnmcp_app;

-- Which sources are due for a check, across tenants: ids only, never a URL or IR.
-- Like user_tenants (0004), two read policies let the owner role see sources and
-- their checks while app.source_check is set, and the app reaches them only
-- through this function; it then reads each source inside its own tenant.
CREATE POLICY owner_source_check ON cairnmcp.sources FOR SELECT TO CURRENT_USER
  USING (current_setting('app.source_check', true) = 'on');
CREATE POLICY owner_source_check ON cairnmcp.source_checks FOR SELECT TO CURRENT_USER
  USING (current_setting('app.source_check', true) = 'on');

CREATE FUNCTION cairnmcp.sources_due_for_check(older_than interval, max_rows integer)
  RETURNS TABLE (tenant_id text, source_id text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = cairnmcp, pg_temp
  AS $$
#variable_conflict use_column
DECLARE
  prior text := coalesce(current_setting('app.source_check', true), '');
BEGIN
  PERFORM set_config('app.source_check', 'on', true);
  RETURN QUERY
    SELECT s.tenant_id::text, s.id::text
    FROM cairnmcp.sources s
    LEFT JOIN cairnmcp.source_checks c ON c.tenant_id = s.tenant_id AND c.source_id = s.id
    WHERE s.ir #>> '{source,derivation,documentUrl}' IS NOT NULL
      AND (c.checked_at IS NULL OR c.checked_at < now() - older_than)
    ORDER BY c.checked_at NULLS FIRST, s.tenant_id, s.id
    LIMIT least(greatest(max_rows, 0), 1000);
  PERFORM set_config('app.source_check', prior, true);
END
$$;
REVOKE ALL ON FUNCTION cairnmcp.sources_due_for_check(interval, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cairnmcp.sources_due_for_check(interval, integer) TO cairnmcp_app;
