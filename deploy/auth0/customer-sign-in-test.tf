# Optional: an Auth0 application for testing customer sign-in (D-040) against a
# real provider, with cairnmcp's dev console on your machine. Off by default;
# turn on with customer_sign_in_test = true. See "Testing customer sign-in" in
# README.md. It doesn't touch the cairnmcp application above.

variable "customer_sign_in_test" {
  description = "Create the customer sign-in test application and its plan claim Action (D-040)."
  type        = bool
  default     = false
}

variable "customer_test_callback" {
  description = "Where Auth0 sends testers back: the dev console's tenant callback."
  type        = string
  default     = "http://localhost:8787/oauth/callback/tenant/colter"
}

locals {
  customer_test = var.customer_sign_in_test ? 1 : 0
  # The claim the dev console's Pro profile matches on (packages/server/scripts/dev-console.ts).
  plan_claim = "https://cairnmcp.test/plan"
}

resource "auth0_client" "customer_test" {
  count           = local.customer_test
  name            = "cairnmcp customer sign-in test"
  description     = "Stands in for an API provider's own sign-in when testing D-040 locally (deploy/auth0)."
  app_type        = "regular_web"
  is_first_party  = true
  oidc_conformant = true
  # refresh_token: cairnmcp re-reads claims with it on every refresh of its own tokens.
  grant_types = ["authorization_code", "refresh_token"]
  callbacks   = [var.customer_test_callback]

  jwt_configuration {
    alg = "RS256"
  }

  refresh_token {
    rotation_type                = "rotating"
    expiration_type              = "expiring"
    leeway                       = 0
    token_lifetime               = 2592000
    idle_token_lifetime          = 1296000
    infinite_token_lifetime      = false
    infinite_idle_token_lifetime = false
  }
}

resource "auth0_client_credentials" "customer_test" {
  count                 = local.customer_test
  client_id             = auth0_client.customer_test[0].id
  authentication_method = "client_secret_post"
}

# Puts the tester's app_metadata.plan into the ID token as a namespaced claim.
# Post-login Actions also run on refresh token exchanges, so a plan changed in
# the dashboard reaches cairnmcp at its next refresh. Only acts for the test app.
resource "auth0_action" "plan_claim" {
  count   = local.customer_test
  name    = "cairnmcp-test-plan-claim"
  runtime = "node22"
  deploy  = true

  supported_triggers {
    id      = "post-login"
    version = "v3"
  }

  code = <<-EOT
    exports.onExecutePostLogin = async (event, api) => {
      if (event.client.client_id !== "${auth0_client.customer_test[0].client_id}") return;
      const plan = event.user.app_metadata && event.user.app_metadata.plan;
      if (typeof plan === "string") api.idToken.setCustomClaim("${local.plan_claim}", plan);
    };
  EOT
}

# Adds the Action to the login flow without replacing any other Actions bound there.
resource "auth0_trigger_action" "plan_claim" {
  count     = local.customer_test
  trigger   = "post-login"
  action_id = auth0_action.plan_claim[0].id
}

output "customer_test_issuer" {
  value = var.customer_sign_in_test ? "https://${var.auth0_domain}/" : null
}

output "customer_test_client_id" {
  value = var.customer_sign_in_test ? auth0_client.customer_test[0].client_id : null
}

# terraform output -raw customer_test_client_secret, then paste it into the console's
# Customer sign-in page. A test app only: never use it for a real provider.
output "customer_test_client_secret" {
  sensitive = true
  value     = var.customer_sign_in_test ? auth0_client_credentials.customer_test[0].client_secret : null
}
