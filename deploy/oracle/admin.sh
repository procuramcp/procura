#!/usr/bin/env bash
# Run an admin command (packages/server/scripts/admin.ts) inside the app
# container on the VM, from your machine. Stdin goes along, so files can be
# piped in. For `credential set`, the secret is asked for here, hidden, and
# sent over SSH's stdin: never in a command line, history, or process list.
#
#   deploy/oracle/admin.sh cairnmcp tenant show --tenant colter
#   deploy/oracle/admin.sh cairnmcp source add --tenant colter --id intervals-icu < openapi.json
#   deploy/oracle/admin.sh cairnmcp credential set --tenant colter --source intervals-icu --scheme APIKey --kind basic
set -euo pipefail
host="${1:?usage: deploy/oracle/admin.sh <ssh host> <command> [options]}"
shift
remote="${CAIRNMCP_REMOTE_DIR:-cairnmcp}"
# Quote every argument for the remote shell.
args="$(printf '%q ' "$@")"
cmd="cd '$remote' && docker compose -f deploy/oracle/compose.yaml exec -T app node packages/server/scripts/admin.ts $args"

if [ "${1:-} ${2:-}" = "credential set" ] && [ -t 0 ]; then
  read -r -s -p "Secret (hidden): " secret
  echo >&2
  [ -n "$secret" ] || { echo "empty secret" >&2; exit 1; }
  printf '%s' "$secret" | ssh "$host" "$cmd"
  unset secret
else
  ssh "$host" "$cmd"
fi
