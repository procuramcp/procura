# Deploying to Google Cloud Run (free tier)

cairnmcp on Cloud Run with Neon Postgres, sized to stay within both free tiers (D-028): the service
scales to zero, runs at most one instance, and uses CPU only while handling a request. Expect a
cold start of a second or two after a quiet spell.

What you need: a Google account, a [Neon](https://neon.com) account, `gcloud` signed in, and Docker.

## 1. Google Cloud project

1. Create a project and note its id. Cloud Run needs a billing account even on the free tier.
2. Add a budget alert so nothing surprises you: Billing → Budgets & alerts → a $1 monthly budget
   with email alerts.
3. Print the URL your service will have (it's known before the first deploy):

   ```bash
   CAIRNMCP_GCP_PROJECT=your-project bash -c 'source deploy/cloud-run/config.sh; public_url'
   ```

## 2. Neon database

The project is linked with the Neon CLI (`neon.ts` and a local `.neon` file); its database is in
**AWS us-west-2 (Oregon)**, next to Cloud Run's `us-west1`.

```bash
neon deploy                              # applies neon.ts, pulls DATABASE_URL(_UNPOOLED) into .env.local
pnpm --filter @cairnmcp/db roles         # creates cairnmcp_app + cairnmcp_server, writes CAIRNMCP_DATABASE_URL
pnpm --filter @cairnmcp/db migrate       # as the owner, over the direct (unpooled) host
```

`DATABASE_URL` and `DATABASE_URL_UNPOOLED` are the branch owner (`neondb_owner`). The app never
uses them: `roles` creates a separate login role with SQL (roles made in Neon's Console join
`neon_superuser` and can bypass RLS) and writes its pooled URL as `CAIRNMCP_DATABASE_URL`.
Re-running `roles` rotates that password. `neon env pull` keeps other lines in `.env.local`.

For `setup.sh` you need two of these values: `CAIRNMCP_DATABASE_URL` (app, pooled) and
`DATABASE_URL_UNPOOLED` (owner, direct).

## 3. Google sign-in

People sign in with Google (D-026). In the same Google Cloud project:

1. APIs & Services → OAuth consent screen: External, keep it in **Testing**, and add your own
   Google account as a test user. Scopes: `openid`, `email`, `profile`.
2. Credentials → Create OAuth client ID → Web application. Authorized redirect URI:
   `<your public URL>/oauth/callback/google`.
3. Build the value of the sign-in secret from the client id and secret:

   ```json
   [{"id":"google","name":"Google","issuer":"https://accounts.google.com","clientId":"…apps.googleusercontent.com","clientSecret":"…"}]
   ```

## 4. Set up and deploy

```bash
export CAIRNMCP_GCP_PROJECT=your-project
deploy/cloud-run/setup.sh    # once: APIs, image registry, service accounts, secrets (asks for the values above)
deploy/cloud-run/deploy.sh   # every release: build, push, migrate, deploy, check
```

`setup.sh` generates the master key straight into Secret Manager and never shows it. Keep it there:
without it, stored credentials can't be decrypted. Each service account can read only its own
secrets, and only the migration job sees the owner URL.

`deploy.sh` needs a clean working tree (the image is tagged with the commit). It runs migrations as
a Cloud Run job before the new revision serves traffic, then checks `/healthz` and the
authorization server metadata.

## What it costs

Within free tiers at low traffic: Cloud Run's monthly allowance, Artifact Registry's 0.5 GB (the
registry keeps only the newest images), Secret Manager's free secret versions and accesses, and
Neon's free plan (1 GB storage, scale to zero, 6 hours of point-in-time restore). Check current
limits on each provider's pricing page.

Not included: a stable outbound IP. Calls to upstream APIs leave from Google's shared addresses
until we add Cloud NAT with a reserved IP, which costs money (D-028).

## Using it

An MCP client connects to `<public URL>/mcp/<tenant id>/<toolset id>`. Signing in without access
shows your **account id**; a tenant's owner grants access to that id. Creating tenants, sources, and
toolsets has no UI or command yet, so a new deployment can sign people in but has nothing to serve
until that tooling lands.
