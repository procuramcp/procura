# Self-hosting procura

Run your own procura with Docker: the app (the MCP endpoint, its OAuth authorization server,
and the curation console in one container), Postgres, and a one-off migration step that runs
before every start. You need Docker with Compose v2.20 or later, and nothing else from this
repository but this folder.

procura is licensed under the AGPL-3.0 (`LICENSE`, D-046). If you change it and let others use
your copy over a network, offer them your changed source.

| File | What it is |
| --- | --- |
| `compose.yaml` | The services. Optional ones are switched on by `COMPOSE_PROFILES` in `.env`. |
| `.env.example` | Every setting, documented. Copy it to `.env`. |
| `admin.sh` | Runs the admin CLI inside the app container (tenants, sources, keys). |
| `dex.yaml` | A local sign-in provider with one demo login, for trying it on a laptop. |
| `postgres-init.sh` | Creates the database roles on the bundled Postgres's first start. |
| `Caddyfile` | HTTPS on your domain, for the `caddy` profile. |

## Try it on your laptop

```bash
cp .env.example .env
```

Fill in the two secrets in `.env`:

```bash
sed -i.bak -e "s|^PROCURA_MASTER_KEY=.*|PROCURA_MASTER_KEY=$(openssl rand -base64 32)|" -e "s|^PROCURA_POSTGRES_PASSWORD=.*|PROCURA_POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env && rm .env.bak
```

```bash
docker compose up -d
```

Open <http://localhost:8080/app/> and sign in with **Dex (local demo)**: `admin@example.com`,
password `procura`. You land on **No tenants yet**, which shows your account id. Create your
tenant (the id becomes part of your MCP URLs):

```bash
./admin.sh tenant create --name "My APIs" --owner <account id> --id mine
```

Reload the console. From there, add an API (an OpenAPI document by URL, Swagger UI page, paste,
or file), store its key, curate a toolset, and give yourself access to it. Each toolset has an MCP
URL, `http://localhost:8080/mcp/<tenant>/<toolset>`, which you add to any MCP client that supports
OAuth. With Claude Code:

```bash
claude mcp add --transport http mine http://localhost:8080/mcp/mine/<toolset>
```

The client opens a browser to sign in (Dex again), then lists the toolset's tools.

Stop with `docker compose down` (your data stays in the `pgdata` volume);
`docker compose down --volumes` deletes it.

## On a server

The same files, with three changes in `.env`.

### 1. A domain with HTTPS

Point a DNS record for your domain at the server, open ports 80 and 443, then set:

```bash
COMPOSE_PROFILES=postgres,caddy
PROCURA_DOMAIN=mcp.example.com
PROCURA_PUBLIC_URL=https://mcp.example.com
```

Caddy gets a certificate from Let's Encrypt on first start and renews it on its own. The app stays
on `127.0.0.1:8080`; only Caddy listens publicly.

Already running a reverse proxy (nginx, Traefik, a load balancer)? Leave `caddy` out and proxy
`https://<your domain>` to port 8080 (`PROCURA_BIND=0.0.0.0` if the proxy is on another host).
Don't buffer responses, and pass the path through unchanged. `PROCURA_PUBLIC_URL` must be the
https address people use: procura builds every URL and token issuer from it, never from the
request's Host header.

### 2. A real sign-in provider

Dex's demo login is for laptops only (and works only at `http://localhost:8080`). Remove `dex`
from `COMPOSE_PROFILES` and configure your own OpenID Connect provider: Google, Microsoft Entra,
Okta, Auth0, Keycloak, or any other.

1. Create an OAuth/OIDC web application at the provider, with two redirect URIs:
   `https://mcp.example.com/oauth/callback/<id>` (MCP clients) and
   `https://mcp.example.com/app/callback/<id>` (the console). `<id>` is a short slug you pick,
   e.g. `google`. It needs the `openid email profile` scopes.
2. Put it in `.env`, on one line:

   ```bash
   PROCURA_OIDC_PROVIDERS=[{"id":"google","name":"Google","issuer":"https://accounts.google.com","clientId":"…","clientSecret":"…"}]
   ```

   Several providers are allowed; each gets a button on the sign-in page. People are identified
   by provider and subject, never by email, so the same person signing in through two providers
   is two accounts.

**How MCP clients sign in.** procura is its own OAuth 2.1 authorization server (D-025, D-026),
so MCP clients need no setup: an unauthenticated request to an MCP URL gets a 401 pointing at
`/.well-known/oauth-protected-resource/…`, which names procura as the authorization server;
the client registers itself (`/oauth/register`), sends the user to sign in through your provider,
shows a consent page, and gets a token for that one toolset. Access is checked on every call:
signing in gives no access until a tenant owner or admin grants it in the console.

To also accept tokens from another authorization server (e.g. your company's), list it in
`PROCURA_TRUSTED_ISSUERS`.

### 3. Your own Postgres (optional)

The bundled Postgres is fine for one server. To use a managed one (RDS, Cloud SQL, Neon, ...),
remove `postgres` from `COMPOSE_PROFILES`, create the roles as in `packages/db/README.md` (or
`postgres-init.sh`), and set `PROCURA_DATABASE_URL` (the app role) and
`PROCURA_DATABASE_OWNER_URL` (the owner, used only by the migration step). The app refuses to
start as a superuser, a `BYPASSRLS` role, or the tables' owner: tenant isolation depends on
row-level security (D-024).

### Start it

```bash
docker compose up -d
```

If a setting is missing or wrong, the app exits and its log names every problem (never a value):

```bash
docker compose logs app
```

## Backups

Two things to keep, stored apart:

- **The master key** (`PROCURA_MASTER_KEY`). It decrypts the API keys stored in the vault.
  Without it a restored database has every key unreadable, and each has to be entered again.
  Keep a copy in a password manager.
- **The database.** With the bundled Postgres, a compressed dump:

  ```bash
  docker compose exec -T postgres pg_dump -U postgres -Fc procura > procura-$(date +%F).dump
  ```

  Run it from cron and copy the files off the server. Stored API keys are encrypted in it; the
  dump is still sensitive (who has access to what, the audit log). With your own Postgres, use
  its backups.

**Restore** into a fresh volume, then start the rest:

```bash
docker compose down --volumes
```

```bash
docker compose up -d --wait postgres
```

```bash
docker compose exec -T postgres pg_restore -U postgres -d procura --clean --if-exists --exit-on-error < procura-<date>.dump
```

```bash
docker compose up -d
```

Use the same `.env` as before (the same master key; the Postgres password is set again by the
fresh volume).

## Upgrades

Images are tagged by version: `0.1.0` (exact), `0.1` (latest patch), `latest` (latest release),
and `edge` (every change on main, not for servers). Pin one on a server:

```bash
PROCURA_IMAGE=ghcr.io/procuramcp/procura:0.1
```

To upgrade, back up the database, change the tag if you pin a minor version, then:

```bash
docker compose pull
```

```bash
docker compose up -d
```

The migration step runs before the new app starts and applies any new database migrations; the
app doesn't start if they fail (`docker compose logs migrate`). Migrations only move forward, so
**rolling back means restoring the backup** taken before the upgrade, then starting the previous
tag. Read the release notes before skipping several versions.

Changing `PROCURA_PUBLIC_URL` signs every MCP client out (it's the tokens' issuer); they sign in
again on their next connection.

## Operating it

- Logs: `docker compose logs -f app` (or `caddy`, `migrate`).
- Containers restart on failure and after a reboot.
- Hardening: the app and the migration step run as an unprivileged user with a read-only
  filesystem, no Linux capabilities, and no privilege escalation. Postgres isn't published on the
  host.
- Admin CLI: `./admin.sh` with no arguments lists its commands. Most of them are also in the
  console; creating a tenant is CLI-only for now.
