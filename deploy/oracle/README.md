# Deploying to an Oracle Cloud Always Free VM

cairnmcp on one free Arm VM (D-029): the app image (D-027) in Docker, behind Caddy, which gets and
renews the HTTPS certificate. The database stays on Neon's free plan. The VM's public IP is also a
**stable outbound IP**, so upstream APIs that rate-limit per IP see only our traffic.

What you need: an Oracle Cloud account (signing up needs a card for verification), the Neon
project already set up (see below), and an SSH key.

## 1. Oracle account and VM

**With Terraform (recommended):** [infra/README.md](infra/README.md) creates the network, firewall
rules, a reserved public IP, the Ubuntu VM with first-boot setup, a free-shapes-only quota, and the
budget alerts. Do steps 1–2 below (account, region, upgrade), then use it instead of steps 3–4.

**By hand:**

1. Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/). Pick a **home region**
   near the database: **US West (San Jose)** or **US West (Phoenix)** for Neon's `us-west-2`. Always
   Free resources exist only in the home region, and it can't be changed later.
2. **Upgrade to Pay As You Go** (Billing → Upgrade). Always Free resources stay free. Oracle reclaims
   Always Free VMs that stay under 20% CPU, network, and memory use for a week, and an MCP server is
   idle most of the time; community reports (not an Oracle guarantee we could confirm) say upgraded
   accounts aren't reclaimed. Then add a budget with
   an alert at $1 (Billing → Budgets) so a mistake can't cost money quietly.
3. Create the VM (Compute → Instances → Create):
   - Image: **Canonical Ubuntu 24.04**.
   - Shape, either:
     - **Ampere `VM.Standard.A1.Flex`** (Arm), 1 OCPU and 6 GB. Roomier, but often "out of
       capacity"; Pay As You Go accounts reportedly get it more easily.
     - **`VM.Standard.E2.1.Micro`** (x86), almost always available: 1 GB of memory and a small
       share of a CPU. Enough to run cairnmcp (setup adds swap), not to build it, so build on
       your own machine with `ship.sh` (below).
     
     Check for the **Always Free-eligible** label before creating it.
   - Networking: choose **Create new virtual cloud network** with a **public subnet**, turn on
     **Assign a public IPv4 address**, and add your SSH public key. Creating the network here (or
     with the "VCN with Internet Connectivity" wizard) also creates the **Internet Gateway** and the
     `0.0.0.0/0` route the VM needs, so there's no separate gateway step. Only a network built by
     hand needs one added: an Internet Gateway, plus that route in the public subnet's route
     table. No NAT gateway is needed; the VM's own public IP is its outbound IP.
4. Open the ports in the subnet's security list (Networking → the VCN → Security Lists → Default →
   Add Ingress Rules): source `0.0.0.0/0`, TCP `80` and TCP `443` (and UDP `443` for HTTP/3).

The public IP stays with the VM for its whole life. To keep the same address even if you ever
recreate the VM, promote it to a reserved public IP in the console.

## 2. Sign-in

People sign in through an OIDC provider (D-026). The recommended setup is **Auth0, as code**:
follow [../auth0/README.md](../auth0/README.md) after the VM is set up; its `push-provider.sh`
installs the settings on the VM. When `setup-vm.sh` asks for `CAIRNMCP_OIDC_PROVIDERS` before that
exists, enter a placeholder such as
`[{"id":"auth0","name":"Auth0","issuer":"https://example.us.auth0.com/","clientId":"x","clientSecret":"x"}]`;
the push replaces it.

Any other OIDC provider works too (Google, Microsoft, Okta, …): its redirect URI is
`https://<your domain>/oauth/callback/<id>`, and the value is a JSON list of
`{"id","name","issuer","clientId","clientSecret"}`.

## 3. Set up and deploy

The image is built on your machine (needs Docker and an SSH host entry, e.g. `cairnmcp` in
`~/.ssh/config`) and shipped to the VM, so the VM needs no copy of the repo and no GitHub access.

```bash
deploy/oracle/ship.sh cairnmcp           # first run: copies deploy/oracle/ to the VM and stops
ssh cairnmcp
cd cairnmcp && deploy/oracle/setup-vm.sh # once, on the VM: Docker, swap, firewall, updates, settings
exit                                     # log out so the docker group applies
deploy/oracle/ship.sh cairnmcp           # every release: build, copy the image, migrate, start, check
```

On an A1 VM you can instead clone the repo there (it needs a read-only deploy key, since the repo
is private) and run `deploy/oracle/deploy.sh`, which builds on the VM.

`setup-vm.sh` asks for:
- **Domain:** your own (an A record pointing at the VM), or Enter for `<ip>.sslip.io`, a free
  hostname that resolves to the IP. It becomes the public URL and the OAuth issuer, so changing it
  later means signing in again.
- **`CAIRNMCP_DATABASE_URL`** and **`DATABASE_URL_UNPOOLED`** from your local `.env.local`
  (created by `neon deploy` and `pnpm --filter @cairnmcp/db roles`; see `packages/db/README.md`).
- **The Google sign-in JSON** above.

Settings are written to `deploy/oracle/app.env` (the app) and `migrate.env` (only the migration
container gets the owner URL), readable only by your user and gitignored. The master key is
generated into `app.env` and not printed.

## Back up the master key

Unlike a managed secret store, the VM's disk is the only copy. If the VM is lost without a backup,
credentials stored in the vault can't be decrypted. Copy it into your password manager once:

```bash
grep CAIRNMCP_MASTER_KEY deploy/oracle/app.env
```

## Set up your first tenant

Creating a tenant is done with `deploy/oracle/admin.sh` (APIs and their keys can also be added in the console at `/app`), run from the repo
on your machine. It runs the admin CLI inside the app container on the VM (where the master key
is), forwards files on stdin, and asks for secrets hidden. Example with Intervals.icu:

1. **Pick the ids, which make up your MCP URL:** tenant `colter`, toolset `intervals` →
   `https://<domain>/mcp/colter/intervals`.
2. **Sign in once to get your account id:** add that URL to your MCP client (in Claude: Settings →
   Connectors → Add custom connector) and connect. You'll sign in (through Auth0) and land on
   **No access**, which shows **Your account id**. Copy it.
3. **Create everything** (replace `<account id>`):

   ```bash
   deploy/oracle/admin.sh cairnmcp tenant create --name "Colter" --owner <account id> --id colter
   deploy/oracle/admin.sh cairnmcp source add --tenant colter --id intervals-icu --fixed-username APIKey=API_KEY < packages/ingest/fixtures/intervals-icu/openapi.json
   deploy/oracle/admin.sh cairnmcp toolset put --tenant colter --source intervals-icu --id intervals --definition < examples/intervals-icu/toolset.json
   deploy/oracle/admin.sh cairnmcp access grant --tenant colter --toolset intervals --user <account id> --level use
   deploy/oracle/admin.sh cairnmcp credential set --tenant colter --source intervals-icu --scheme APIKey --kind basic
   ```

   The last one asks for your Intervals.icu API key (Settings → Developer Settings), hidden; it's
   encrypted into the vault and never printed. Check with
   `deploy/oracle/admin.sh cairnmcp tenant show --tenant colter`.
4. **Connect again** in your MCP client. You'll see the toolset's tools and can ask about your
   training.

The starter toolset (`examples/intervals-icu/toolset.json`) is read-only: eight tools with the
athlete pinned to your own (`id = 0`). `toolset put` without `--definition` makes the default
instead: every operation as a tool, reads enabled (D-016). `--level use_writes` also allows write
tools a toolset enables.

## The curation console

`https://<domain>/app/` is where owners and admins edit toolsets (D-033): turn tools on or off,
rename them, rewrite their descriptions for agents, pin inputs, grant access, and try a tool with
a real call before saving. Sign in with the same account as your MCP client. Its sign-in uses a
second Auth0 callback (`/app/callback/auth0`), added by `deploy/auth0` (run `terraform apply`
there once after upgrading).

## Operating it

- Logs: `docker compose -f deploy/oracle/compose.yaml logs -f app` (or `caddy`).
- The containers restart on failure and after a reboot. Ubuntu installs security updates
  automatically; reboot now and then for kernel updates (`sudo reboot`).
- `ship.sh` builds the image for the VM's architecture on your machine, streams it over SSH
  (about 95 MB compressed), syncs `deploy/oracle/` (never the settings files), then runs
  `deploy.sh --no-pull --no-build` on the VM: migrations in a one-off container, restart, a check of
  `https://<domain>/healthz` and the OAuth metadata, and pruning of old images. The image is tagged
  with the commit (`-dirty` if you ship uncommitted changes).
- Hardening in the stack: the app has a read-only filesystem, no Linux capabilities, and no
  privilege escalation, and isn't published on the host; only Caddy listens on 80/443.

## What it costs

Nothing within the Always Free allowance (an A1 or E2.1.Micro VM, up to 200 GB of block volumes, 10 TB of outbound
data a month) and Neon's free plan. Oracle has changed the A1 allowance before; check the current
limits in the console before sizing the VM.
