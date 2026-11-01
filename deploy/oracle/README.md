# Deploying to an Oracle Cloud Always Free VM

cairnmcp on one free Arm VM (D-029): the app image (D-027) in Docker, behind Caddy, which gets and
renews the HTTPS certificate. The database stays on Neon's free plan. The VM's public IP is also a
**stable outbound IP**, so upstream APIs that rate-limit per IP see only our traffic.

What you need: an Oracle Cloud account (signing up needs a card for verification), the Neon
project already set up (see below), and an SSH key.

## 1. Oracle account and VM

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
   - Shape: **Ampere `VM.Standard.A1.Flex`**, 1 OCPU and 6 GB is plenty (stay within the Always
     Free allowance shown in the console). "Out of capacity" is common; retry later or in another
     availability domain.
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

## 2. Google sign-in

People sign in with Google (D-026). In a Google Cloud project (no billing needed for this):
OAuth consent screen → External, keep it in **Testing**, add yourself as a test user, scopes
`openid`, `email`, `profile`. Then Credentials → OAuth client ID → Web application, with the
redirect URI that `setup-vm.sh` prints: `https://<your domain>/oauth/callback/google`. The value
the setup asks for is:

```json
[{"id":"google","name":"Google","issuer":"https://accounts.google.com","clientId":"…apps.googleusercontent.com","clientSecret":"…"}]
```

## 3. Set up and deploy (on the VM)

```bash
ssh ubuntu@<public ip>
git clone https://github.com/cairnmcp/cairnmcp.git && cd cairnmcp
deploy/oracle/setup-vm.sh     # once: Docker, firewall, automatic updates, settings
newgrp docker                 # or log out and back in, after the first run
deploy/oracle/deploy.sh       # every release: pull, build, migrate, restart, check
```

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

## Operating it

- Logs: `docker compose -f deploy/oracle/compose.yaml logs -f app` (or `caddy`).
- The containers restart on failure and after a reboot. Ubuntu installs security updates
  automatically; reboot now and then for kernel updates (`sudo reboot`).
- `deploy.sh` builds the image on the VM (it's an Arm machine, so natively), runs migrations in a
  one-off container, restarts, checks `https://<domain>/healthz` and the OAuth metadata, and prunes
  old images.
- Hardening in the stack: the app has a read-only filesystem, no Linux capabilities, and no
  privilege escalation, and isn't published on the host; only Caddy listens on 80/443.

## What it costs

Nothing within the Always Free allowance (an A1 VM, up to 200 GB of block volumes, 10 TB of outbound
data a month) and Neon's free plan. Oracle has changed the A1 allowance before; check the current
limits in the console before sizing the VM.
