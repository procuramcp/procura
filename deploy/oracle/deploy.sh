#!/usr/bin/env bash
# Deploy the current commit on the VM: build the image, migrate, restart, check.
# Run on the VM from the repo clone, after setup-vm.sh:
#
#   deploy/oracle/deploy.sh            # pulls the latest main first
#   deploy/oracle/deploy.sh --no-pull  # deploy what's checked out
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
compose=(docker compose -f "$here/compose.yaml")
step() { printf '\n• %s\n' "$*"; }

for f in .env app.env migrate.env; do [ -f "$here/$f" ] || { echo "missing deploy/oracle/$f: run setup-vm.sh first" >&2; exit 1; }; done
domain="$(sed -n 's/^CAIRNMCP_DOMAIN=//p' "$here/.env")"

if [ "${1:-}" != "--no-pull" ]; then
  step "update the checkout"
  git -C "$root" pull --ff-only
fi
echo "  deploying $(git -C "$root" rev-parse --short=12 HEAD)"

step "build the image (natively for this VM)"
"${compose[@]}" build app

step "migrate (owner role, one-off container)"
"${compose[@]}" run --rm migrate

step "start"
"${compose[@]}" up -d --wait

step "check https://$domain"
# The first start also obtains the certificate, which can take a little while.
for _ in $(seq 1 30); do
  [ "$(curl -fsS "https://$domain/healthz" 2>/dev/null)" = "ok" ] && break
  sleep 2
done
[ "$(curl -fsS "https://$domain/healthz")" = "ok" ] && curl -fsS "https://$domain/.well-known/oauth-authorization-server" | grep -q "\"issuer\":\"https://$domain\"" ||
  { echo "✗ https://$domain didn't answer as expected; see: docker compose -f deploy/oracle/compose.yaml logs" >&2; exit 1; }

# Old images add up on a small disk.
docker image prune -f >/dev/null
printf '\n✓ deployed at https://%s\n' "$domain"
