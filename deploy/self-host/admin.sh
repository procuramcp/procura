#!/usr/bin/env bash
# Run an admin command (packages/server/scripts/admin.ts) inside the app container.
# Stdin goes along, so files can be piped in; for `credential set` the secret is
# asked for here, hidden, and never appears in a command line or history.
#
#   ./admin.sh tenant create --name "Acme" --owner <account id> --id acme
#   ./admin.sh source add --tenant acme --id petstore < openapi.json
#   ./admin.sh credential set --tenant acme --source petstore --scheme api_key --kind api_key
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
run=(docker compose --project-directory "$here" exec -T app node packages/server/scripts/admin.ts "$@")

if [ "${1:-} ${2:-}" = "credential set" ] && [ -t 0 ]; then
  read -r -s -p "Secret (hidden): " secret
  echo >&2
  [ -n "$secret" ] || { echo "empty secret" >&2; exit 1; }
  printf '%s' "$secret" | "${run[@]}"
  unset secret
else
  "${run[@]}"
fi
