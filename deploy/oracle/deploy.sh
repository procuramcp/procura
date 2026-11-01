#!/usr/bin/env bash
# Deploy on the VM: build the image, migrate, restart, check. Run on the VM,
# after setup-vm.sh:
#
#   deploy/oracle/deploy.sh                       # from a repo clone: pull, build, deploy
#   deploy/oracle/deploy.sh --no-pull             # deploy what's checked out
#   deploy/oracle/deploy.sh --no-pull --no-build  # use an image shipped by ship.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
compose=(docker compose -f "$here/compose.yaml")
step() { printf '\n• %s\n' "$*"; }

for f in .env app.env migrate.env; do [ -f "$here/$f" ] || { echo "missing deploy/oracle/$f: run setup-vm.sh first" >&2; exit 1; }; done
domain="$(sed -n 's/^CAIRNMCP_DOMAIN=//p' "$here/.env")"

pull=1 build=1
for arg in "$@"; do
  case "$arg" in
    --no-pull) pull=0 ;;
    --no-build) build=0 ;;
    *) echo "unknown option $arg" >&2; exit 1 ;;
  esac
done

if [ "$pull" = 1 ]; then
  step "update the checkout"
  git -C "$root" pull --ff-only
fi
version="${CAIRNMCP_VERSION:-$(git -C "$root" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)}"
echo "  deploying $version"

if [ "$build" = 1 ]; then
  step "build the image (natively for this VM)"
  "${compose[@]}" build app
else
  docker image inspect cairnmcp:local >/dev/null 2>&1 || { echo "no cairnmcp:local image: ship one with deploy/oracle/ship.sh" >&2; exit 1; }
fi

step "migrate (owner role, one-off container)"
"${compose[@]}" run --rm migrate

step "start"
"${compose[@]}" up -d --wait --no-build

step "check https://$domain"
# The first start also obtains the certificate, which can take a little while.
for _ in $(seq 1 30); do
  [ "$(curl -fsS "https://$domain/healthz" 2>/dev/null)" = "ok" ] && break
  sleep 2
done
[ "$(curl -fsS "https://$domain/healthz")" = "ok" ] && curl -fsS "https://$domain/.well-known/oauth-authorization-server" | grep -q "\"issuer\":\"https://$domain\"" ||
  { echo "✗ https://$domain didn't answer as expected; see: docker compose -f deploy/oracle/compose.yaml logs" >&2; exit 1; }

# Old images add up on a small disk: keep the running one and the previous shipped tag.
docker image prune -f >/dev/null
docker image ls cairnmcp --format '{{.Tag}}' | grep -vx local | tail -n +3 | sed 's/^/cairnmcp:/' | xargs -r docker image rm >/dev/null 2>&1 || true
printf '\n✓ deployed at https://%s\n' "$domain"
