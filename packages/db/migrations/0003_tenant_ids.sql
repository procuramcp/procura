-- Create a tenant with a chosen id (e.g. "colter"), so MCP endpoint URLs can be
-- readable and known before the tenant exists: /mcp/colter/intervals.
-- Same rules as create_tenant(name, owner); the id must match TenantId in core
-- (the id_text domain checks it) and must not be taken.
CREATE FUNCTION cairnmcp.create_tenant(tenant_name text, owner_user_id text, tenant_id text) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = cairnmcp, pg_temp
  AS $$
DECLARE
  prior text := coalesce(current_setting('app.tenant_id', true), '');
BEGIN
  PERFORM set_config('app.tenant_id', tenant_id, true);
  INSERT INTO cairnmcp.tenants (id, name) VALUES (tenant_id, tenant_name);
  INSERT INTO cairnmcp.memberships (tenant_id, user_id, role) VALUES (tenant_id, owner_user_id, 'owner');
  PERFORM set_config('app.tenant_id', prior, true);
  RETURN tenant_id;
END
$$;

REVOKE ALL ON FUNCTION cairnmcp.create_tenant(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cairnmcp.create_tenant(text, text, text) TO cairnmcp_app;
