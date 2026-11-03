# @procura/server

The procura app: the embedded authorization server (`packages/auth`) and the MCP endpoint
(`packages/mcp`) in one Node process, the one container image of D-018.

```bash
pnpm --filter @procura/db migrate      # as the owner role, see packages/db/README.md
pnpm --filter @procura/server start    # as the app role
```

Settings are environment variables, validated at startup; the process refuses to start and lists
every problem if something is missing. See the root `.env.example`. Health check: `GET /healthz`.

## Container image

The root `Dockerfile` builds the image we deploy (D-018, D-027): Node 24 slim pinned by digest, no
build step, production dependencies only, running as the unprivileged `node` user with read-only
code. It listens on `PORT` (default 8080) and has a `HEALTHCHECK` on `/healthz`.

```bash
docker build -t procura .
# Migrate as the owner role (a one-off "release" command on most platforms):
docker run --rm -e PROCURA_DATABASE_OWNER_URL=postgres://… procura node packages/db/scripts/migrate.ts
# Run as the app role:
docker run -p 8080:8080 --env-file .env procura
```

`scripts/image-smoke.sh <image>` migrates and starts an image against a real Postgres and checks
health, discovery, registration, and the MCP endpoint's 401; CI runs it on every push.
