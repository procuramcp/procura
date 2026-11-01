#!/usr/bin/env bash
# Smoke-test a built image against a real Postgres: create roles and a scratch
# database, migrate from inside the image, start it, and check that the
# authorization server and MCP endpoint answer.
#
#   scripts/image-smoke.sh cairnmcp:dev
#
# Needs docker, psql, curl, and CAIRNMCP_TEST_DATABASE_URL (a superuser URL,
# as for the tests). Postgres must be reachable from containers through
# host.docker.internal (true for Docker Desktop and for CI's service container).
set -euo pipefail

IMAGE="${1:?usage: scripts/image-smoke.sh <image>}"
ADMIN_URL="${CAIRNMCP_TEST_DATABASE_URL:?CAIRNMCP_TEST_DATABASE_URL must be set}"
PORT="${SMOKE_PORT:-18080}"
DB="cairnmcp_smoke_$RANDOM"
PASSWORD="cairnmcp-smoke-only-not-a-secret"
NAME="cairnmcp-smoke-$RANDOM"
BASE="http://localhost:$PORT"

# Same server as the admin URL, seen from inside a container.
container_url() { # role database
  python3 - "$ADMIN_URL" "$1" "$PASSWORD" "$2" <<'EOF'
import sys
from urllib.parse import urlsplit, urlunsplit
url, role, password, db = sys.argv[1:]
u = urlsplit(url)
host = "host.docker.internal" if u.hostname in ("localhost", "127.0.0.1") else u.hostname
print(urlunsplit((u.scheme, f"{role}:{password}@{host}:{u.port or 5432}", f"/{db}", "", "")))
EOF
}

cleanup() {
  docker logs "$NAME" 2>/dev/null | tail -20 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null || true
}
trap cleanup EXIT

step() { printf '• %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

step "roles and database $DB"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cairnmcp_app') THEN CREATE ROLE cairnmcp_app NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cairnmcp_smoke_owner') THEN CREATE ROLE cairnmcp_smoke_owner LOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cairnmcp_smoke_app') THEN CREATE ROLE cairnmcp_smoke_app LOGIN NOBYPASSRLS; END IF;
END \$\$;
ALTER ROLE cairnmcp_smoke_owner PASSWORD '$PASSWORD';
ALTER ROLE cairnmcp_smoke_app PASSWORD '$PASSWORD';
GRANT cairnmcp_app TO cairnmcp_smoke_app;
CREATE DATABASE $DB OWNER cairnmcp_smoke_owner;
SQL

DOCKER_HOST_ARGS=(--add-host=host.docker.internal:host-gateway)

step "migrate (inside the image, as the owner)"
docker run --rm "${DOCKER_HOST_ARGS[@]}" -e CAIRNMCP_DATABASE_OWNER_URL="$(container_url cairnmcp_smoke_owner "$DB")" \
  "$IMAGE" node packages/db/scripts/migrate.ts

step "start (as the app role)"
docker run -d --name "$NAME" "${DOCKER_HOST_ARGS[@]}" -p "$PORT:8080" \
  -e CAIRNMCP_PUBLIC_URL="$BASE" \
  -e CAIRNMCP_DATABASE_URL="$(container_url cairnmcp_smoke_app "$DB")" \
  -e CAIRNMCP_MASTER_KEY="$(openssl rand -base64 32)" \
  -e CAIRNMCP_OIDC_PROVIDERS='[{"id":"idp","name":"Test IdP","issuer":"https://idp.invalid","clientId":"smoke","clientSecret":"smoke-not-a-secret"}]' \
  "$IMAGE" >/dev/null

step "healthz"
# Port proxies can accept connections before the app listens, so poll instead of curl --retry.
for _ in $(seq 1 30); do
  [ "$(curl -fsS "$BASE/healthz" 2>/dev/null)" = "ok" ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = "true" ] || fail "container exited"
  sleep 1
done
[ "$(curl -fsS "$BASE/healthz")" = "ok" ] || fail "healthz"

step "authorization server metadata"
curl -fsS "$BASE/.well-known/oauth-authorization-server" | grep -q "\"issuer\":\"$BASE\"" || fail "metadata"
curl -fsS "$BASE/oauth/jwks" | grep -q '"kty":"EC"' || fail "jwks"

step "client registration"
status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/oauth/register" -H 'content-type: application/json' \
  -d '{"redirect_uris":["http://localhost:4567/cb"],"client_name":"Smoke"}')
[ "$status" = "201" ] || fail "register returned $status"

step "MCP endpoint asks for a token"
headers=$(curl -s -o /dev/null -D - -X POST "$BASE/mcp/t1/mine")
grep -q "^HTTP/1.1 401" <<<"$headers" || fail "expected 401"
grep -qi "resource_metadata=\"$BASE/.well-known/oauth-protected-resource/mcp/t1/mine\"" <<<"$headers" || fail "missing resource_metadata"

step "runs as an unprivileged user"
[ "$(docker exec "$NAME" id -u)" != "0" ] || fail "running as root"

printf '✓ image smoke test passed\n'
