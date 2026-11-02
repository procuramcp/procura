-- Plan limits (D-039): what each customer holding an access profile may call,
-- and the counters that enforce daily and monthly allowances.

ALTER TABLE cairnmcp.access_profiles
  ADD COLUMN per_day     integer CHECK (per_day BETWEEN 1 AND 1000000000),
  ADD COLUMN per_month   integer CHECK (per_month BETWEEN 1 AND 1000000000),
  ADD COLUMN upgrade_url text    CHECK (upgrade_url ~ '^https://' AND length(upgrade_url) <= 2000);

-- Calls per person per UTC day and calendar month, across the tenant. Every
-- admitted call counts, limited or not, so usage is there to show (and bill)
-- later. Keyed to the tenant, not the membership: removing and re-adding
-- someone doesn't reset what they've used.
CREATE TABLE cairnmcp.usage_counters (
  tenant_id    cairnmcp.id_text NOT NULL REFERENCES cairnmcp.tenants (id) ON DELETE CASCADE,
  user_id      cairnmcp.id_text NOT NULL REFERENCES cairnmcp.users (id) ON DELETE CASCADE,
  period       text NOT NULL CHECK (period IN ('day', 'month')),
  period_start date NOT NULL,
  calls        bigint NOT NULL CHECK (calls >= 0),
  PRIMARY KEY (tenant_id, user_id, period, period_start)
);
-- Old periods can be swept by date.
CREATE INDEX usage_counters_period_idx ON cairnmcp.usage_counters (period_start);

ALTER TABLE cairnmcp.usage_counters ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cairnmcp.usage_counters
  USING (tenant_id = cairnmcp.current_tenant_id()) WITH CHECK (tenant_id = cairnmcp.current_tenant_id());

-- No TRUNCATE: it ignores row-level security.
GRANT SELECT, INSERT, UPDATE, DELETE ON cairnmcp.usage_counters TO cairnmcp_app;
