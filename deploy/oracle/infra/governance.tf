# Guardrails for a Pay As You Go account: a quota that makes paid compute
# shapes impossible to create (the hard block), and a budget whose alerts
# warn on any spend (budgets alone never stop spending).

resource "oci_limits_quota" "free_shapes_only" {
  count          = var.manage_quota ? 1 : 0
  compartment_id = var.tenancy_ocid
  name           = "cairnmcp_free_shapes_only"
  description    = "Only Always Free compute shapes can be created in this tenancy (managed by cairnmcp's Terraform)."

  statements = [
    "zero compute-core quotas in tenancy",
    "set compute-core quota standard-e2-micro-core-count to 2 in tenancy",
    "set compute-core quota standard-a1-core-count to ${var.a1_quota_ocpus} in tenancy",
  ]
}

resource "oci_budget_budget" "monthly" {
  compartment_id = var.tenancy_ocid
  display_name   = "cairnmcp-monthly"
  description    = "Everything in the tenancy should cost nothing (managed by cairnmcp's Terraform)."
  amount         = var.budget_amount
  reset_period   = "MONTHLY"
  target_type    = "COMPARTMENT"
  targets        = [var.tenancy_ocid]
}

# 1% of a $1 budget: alerts on the first cent actually spent.
resource "oci_budget_alert_rule" "any_spend" {
  budget_id      = oci_budget_budget.monthly.id
  display_name   = "any-actual-spend"
  type           = "ACTUAL"
  threshold      = 1
  threshold_type = "PERCENTAGE"
  recipients     = var.budget_alert_email
  message        = "Oracle Cloud charged money this month. Something outside Always Free exists: check Billing > Cost Analysis."
}

resource "oci_budget_alert_rule" "forecast" {
  budget_id      = oci_budget_budget.monthly.id
  display_name   = "forecast-over-budget"
  type           = "FORECAST"
  threshold      = 100
  threshold_type = "PERCENTAGE"
  recipients     = var.budget_alert_email
  message        = "Oracle Cloud forecasts spend over the cairnmcp budget this month: check Billing > Cost Analysis."
}
