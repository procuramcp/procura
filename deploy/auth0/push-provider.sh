#!/usr/bin/env bash
# Install the Auth0 sign-in settings on the VM and restart the app. Run from
# the repo after `terraform apply` in deploy/auth0:
#
#   deploy/auth0/push-provider.sh cairnmcp
#
# The settings (they include the client secret) go over SSH's stdin, straight
# into the CAIRNMCP_OIDC_PROVIDERS line of app.env: never in a command line,
# your terminal, or shell history.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
host="${1:?usage: deploy/auth0/push-provider.sh <ssh host>}"
remote="${CAIRNMCP_REMOTE_DIR:-cairnmcp}"

value="$(terraform -chdir="$here" output -raw oidc_providers_json)"
[ -n "$value" ] || { echo "no oidc_providers_json output: run terraform apply in deploy/auth0 first" >&2; exit 1; }

# shellcheck disable=SC2016 # expanded on the VM, not here
printf '%s' "$value" | ssh "$host" "cd '$remote/deploy/oracle' && python3 -c '
import json, os, sys
value = sys.stdin.read()
json.loads(value)  # refuse anything that is not JSON
lines = open(\"app.env\").read().splitlines()
lines = [l for l in lines if not l.startswith(\"CAIRNMCP_OIDC_PROVIDERS=\")] + [\"CAIRNMCP_OIDC_PROVIDERS=\" + value]
tmp = \"app.env.tmp\"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, \"w\") as f:
    f.write(\"\\n\".join(lines) + \"\\n\")
os.replace(tmp, \"app.env\")
print(\"  updated CAIRNMCP_OIDC_PROVIDERS in app.env\")
' && docker compose -f compose.yaml up -d --force-recreate --wait app >/dev/null && echo '  restarted the app'"
unset value

domain="$(ssh "$host" "sed -n 's/^CAIRNMCP_DOMAIN=//p' '$remote/deploy/oracle/.env'")"
curl -fsS "https://$domain/healthz" >/dev/null && echo "✓ https://$domain is up with Auth0 sign-in"
