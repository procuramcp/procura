#!/usr/bin/env bash
# Smoke-test the self-host setup (deploy/self-host) the way a new user runs it:
# compose up with the bundled Postgres and Dex, sign in to the console through
# Dex, create the first tenant with admin.sh, then recreate the containers as
# an upgrade would and check nothing was lost.
#
#   scripts/compose-smoke.sh procura:dev
#
# Needs docker (with compose), curl, python3, and ports 8080 and 5556 free.
set -euo pipefail

IMAGE="${1:?usage: scripts/compose-smoke.sh <image>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/deploy/self-host"
work="$(mktemp -d)"
export COMPOSE_PROJECT_NAME="procura-smoke"
BASE="http://localhost:8080"

# Exactly what the README says to do: copy .env.example, fill in the two secrets.
sed -e "s|^PROCURA_MASTER_KEY=.*|PROCURA_MASTER_KEY=$(openssl rand -base64 32)|" \
  -e "s|^PROCURA_POSTGRES_PASSWORD=.*|PROCURA_POSTGRES_PASSWORD=$(openssl rand -hex 24)|" \
  -e "s|^PROCURA_IMAGE=.*|PROCURA_IMAGE=$IMAGE|" \
  "$dir/.env.example" >"$work/.env"
compose=(docker compose --project-directory "$dir" --env-file "$work/.env")

cleanup() {
  "${compose[@]}" logs --tail 20 app migrate 2>/dev/null || true
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

step() { printf '• %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }
healthy() {
  for _ in $(seq 1 60); do
    [ "$(curl -fsS "$BASE/healthz" 2>/dev/null)" = "ok" ] && return 0
    sleep 1
  done
  fail "the app didn't become healthy"
}
jar="$work/cookies"
me() { curl -fsS -b "$jar" "$BASE/app/api/me"; }
field() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {}, {'d': d}))" "$1"; }

step "compose up (postgres, migrate, app, dex)"
"${compose[@]}" up -d --quiet-pull
healthy
[ "$(docker inspect -f '{{.State.ExitCode}}' "$("${compose[@]}" ps -aq migrate)")" = "0" ] || fail "migrate didn't exit cleanly"

step "authorization server metadata"
curl -fsS "$BASE/.well-known/oauth-authorization-server" | grep -q "\"issuer\":\"$BASE\"" || fail "metadata"

step "console sign-in through Dex"
form=$(curl -fsS -c "$jar" -b "$jar" -L -o "$work/login.html" -w '%{url_effective}' "$BASE/app/login/dex")
grep -q 'name="password"' "$work/login.html" || fail "no Dex login form at $form"
landed=$(curl -fsS -c "$jar" -b "$jar" -L -o /dev/null -w '%{url_effective}' \
  --data-urlencode login=admin@example.com --data-urlencode password=procura "$form")
[ "$landed" = "$BASE/app/" ] || fail "sign-in ended at $landed"
[ "$(me | field 'd["user"]["label"]')" = "admin@example.com" ] || fail "not signed in"
[ "$(me | field 'len(d["tenants"])')" = "0" ] || fail "expected no tenants yet"
account=$(me | field 'd["user"]["id"]')

step "first tenant with admin.sh"
"$dir/admin.sh" tenant create --name "Smoke" --owner "$account" --id smoke
[ "$(me | field '[(t["id"], t["role"]) for t in d["tenants"]]')" = "[('smoke', 'owner')]" ] || fail "tenant not created"

step "upgrade: recreate the containers, migrate again, keep the data"
"${compose[@]}" up -d --force-recreate --quiet-pull
healthy
[ "$(me | field 'd["tenants"][0]["id"]')" = "smoke" ] || fail "data or session lost on recreate"

step "runs as an unprivileged user"
[ "$("${compose[@]}" exec -T app id -u)" != "0" ] || fail "running as root"

printf '✓ compose smoke test passed\n'
