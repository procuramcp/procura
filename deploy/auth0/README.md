# Sign-in through Auth0 (Terraform)

cairnmcp's authorization server (D-026) delegates sign-in to an OIDC provider. This sets up Auth0
as that provider, as code (D-031): an Auth0 application for cairnmcp, an email/password user
store (brute-force protection on), and optionally "Continue with Google" through Auth0's
developer keys, so no Google OAuth client is needed. Auth0's free plan covers 25,000 monthly
active users.

Signing in only proves who someone is. What they can do is still granted in cairnmcp
(`deploy/oracle/admin.sh … access grant`), so open sign-up is safe.

## One-time setup in Auth0 (the only clicks)

1. Sign up at [auth0.com](https://auth0.com) and create a tenant (any region). Its domain looks
   like `cairnmcp.us.auth0.com`.
2. Give Terraform access: Applications → **Create Application** → **Machine to Machine** → name
   it `terraform` → authorize the **Auth0 Management API** with all permissions (or at least
   clients, client credentials, and connections). From its Settings, copy the domain, client ID,
   and client secret.

## Apply

```bash
cd deploy/auth0
cp terraform.tfvars.example terraform.tfvars   # set auth0_domain (and public_url if it changed)
export AUTH0_DOMAIN=cairnmcp.us.auth0.com AUTH0_CLIENT_ID=… AUTH0_CLIENT_SECRET=…
terraform init
terraform apply
chmod 600 terraform.tfstate                    # it holds the app's client secret (see below)
cd ../..
deploy/auth0/push-provider.sh cairnmcp         # installs it on the VM and restarts the app
```

A new Auth0 tenant already has a `google-oauth2` connection, so the first apply stops with
"409 Conflict: A connection with the same name already exists". Import it and the list of apps
it's enabled for (its `con_…` id is under Authentication → Social → google-oauth2), then apply
again. The apply leaves only cairnmcp on it:

```bash
terraform import 'auth0_connection.google[0]' con_…
terraform import 'auth0_connection_clients.google[0]' con_…
terraform apply
```

Set the three `AUTH0_` variables in your shell only (or a password manager's CLI), not in a file
in the repo. `push-provider.sh` sends the sign-in settings to the VM over SSH's stdin, so the
client secret never appears in a command line or your terminal.

Then connect from your MCP client: it now goes to Auth0's sign-in page, where you can create an
account or continue with Google.

The application allows two callbacks: `/oauth/callback/auth0` for MCP clients and
`/app/callback/auth0` for the curation console (D-033). If you set up Auth0 before the console
existed, run `terraform apply` again to add the second one (nothing needs pushing to the VM).

## Notes

- **The client secret is in `terraform.tfstate`** (Terraform 1.5 can't keep it out). Keep the file
  private (mode 600, gitignored) like `app.env`. Terraform 1.11+ supports write-only secrets that
  are never stored; upgrading means installing Terraform from HashiCorp's tap
  (`brew install hashicorp/tap/terraform`), since Homebrew's main catalog stops at 1.5.
- **Rotating the secret:** `terraform apply -replace=auth0_client_credentials.cairnmcp`, then
  `push-provider.sh` again.
- **Accounts are per provider:** cairnmcp identifies people by provider + account, so the same
  person signing in with Auth0's email/password and with "Continue with Google" gets two cairnmcp
  accounts. Pick one.
- **Auth0's Google developer keys** are meant for testing: Auth0 shows its own name on Google's
  consent screen and some features (e.g. using Google APIs) aren't available. For a public
  deployment, add your own Google client to the connection's `options` (`client_id`,
  `client_secret`).
- Changing the public URL: update `public_url`, apply (it changes the callback), and push again.
