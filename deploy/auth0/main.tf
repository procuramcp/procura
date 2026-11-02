# Sign-in for cairnmcp through Auth0 (D-031): one Auth0 application that the
# embedded authorization server (D-026) uses as its OIDC provider, plus the
# ways people can sign in at Auth0. Who may use which toolset is still decided
# by cairnmcp (D-023); signing in only proves who someone is.

terraform {
  required_version = ">= 1.5"

  required_providers {
    auth0 = {
      source  = "auth0/auth0"
      version = "~> 1.60"
    }
  }
}

# Credentials: AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET of a
# Machine-to-Machine application allowed to use the Management API (README).
provider "auth0" {}

variable "auth0_domain" {
  description = "Your Auth0 tenant domain, e.g. cairnmcp.us.auth0.com (also in AUTH0_DOMAIN)."
  type        = string
}

variable "public_url" {
  description = "cairnmcp's public URL (CAIRNMCP_PUBLIC_URL), e.g. https://163-192-43-4.sslip.io"
  type        = string

  validation {
    condition     = can(regex("^https://[^/]+$", var.public_url))
    error_message = "public_url must be https:// plus a host, with no path or trailing slash."
  }
}

variable "enable_google" {
  description = "Offer 'Continue with Google' at Auth0, using Auth0's developer keys (no Google client needed; Auth0 marks them for testing)."
  type        = bool
  default     = true
}

variable "allow_signup" {
  description = "Let people create an email/password account at Auth0. Safe: an account grants nothing in cairnmcp until an owner grants access."
  type        = bool
  default     = true
}

resource "auth0_client" "cairnmcp" {
  name            = "cairnmcp"
  description     = "cairnmcp's authorization server (managed by Terraform in deploy/auth0)."
  app_type        = "regular_web"
  is_first_party  = true
  oidc_conformant = true
  grant_types     = ["authorization_code"]
  # MCP clients' sign-in (D-026) and the curation console's (D-033).
  callbacks = ["${var.public_url}/oauth/callback/auth0", "${var.public_url}/app/callback/auth0"]

  jwt_configuration {
    alg = "RS256"
  }
}

# openid-client sends the secret in the token request body (client_secret_post).
resource "auth0_client_credentials" "cairnmcp" {
  client_id             = auth0_client.cairnmcp.id
  authentication_method = "client_secret_post"
}

resource "auth0_connection" "users" {
  name     = "cairnmcp-users"
  strategy = "auth0"

  options {
    password_policy        = "good"
    brute_force_protection = true
    disable_signup         = !var.allow_signup
  }
}

resource "auth0_connection" "google" {
  count    = var.enable_google ? 1 : 0
  name     = "google-oauth2"
  strategy = "google-oauth2"

  # No client_id/secret: Auth0's developer keys.
  options {
    scopes = ["email", "profile"]
  }
}

resource "auth0_connection_clients" "users" {
  connection_id   = auth0_connection.users.id
  enabled_clients = [auth0_client.cairnmcp.id]
}

resource "auth0_connection_clients" "google" {
  count           = var.enable_google ? 1 : 0
  connection_id   = auth0_connection.google[0].id
  enabled_clients = [auth0_client.cairnmcp.id]
}

output "callback_urls" {
  value = auth0_client.cairnmcp.callbacks
}

output "issuer" {
  value = "https://${var.auth0_domain}/"
}

# The value for CAIRNMCP_OIDC_PROVIDERS. Contains the client secret: install it
# with push-provider.sh rather than copying it by hand.
output "oidc_providers_json" {
  sensitive = true
  value = jsonencode([{
    id           = "auth0"
    name         = "Auth0"
    issuer       = "https://${var.auth0_domain}/"
    clientId     = auth0_client.cairnmcp.client_id
    clientSecret = auth0_client_credentials.cairnmcp.client_secret
  }])
}
