#!/usr/bin/env bash
# The only thing GitHub Actions' deploy key can do on the VM (D-036). It is the
# key's forced command in ~/.ssh/authorized_keys, so the key gets no shell:
#
#   restrict,command="/home/ubuntu/cairnmcp-ci/receive.sh" ssh-ed25519 AAAA… cairnmcp-ci-deploy
#
# CI runs `ssh <vm> deploy <tag> <hash>` with a gzipped `docker save` of
# cairnmcp:<tag> on stdin. This loads it and runs the VM's own deploy.sh.
#
# It lives outside the repo copy (~/cairnmcp-ci/, installed by
# setup-ci-deploy.sh) and CI never copies files, so a commit can't change what
# this key may run. If the commit's deploy files differ from the VM's, it stops
# and asks for ship.sh, which you run with your own key.
set -euo pipefail
dir="${CAIRNMCP_DEPLOY_DIR:-$HOME/cairnmcp/deploy/oracle}"
max_bytes="${CAIRNMCP_MAX_IMAGE_BYTES:-$((400 * 1024 * 1024))}"
deny() { echo "refused: $*" >&2; exit 2; }

read -r verb tag hash extra <<<"${SSH_ORIGINAL_COMMAND:-}"
[ "${verb:-}" = deploy ] || deny "the only command is: deploy <tag> <deploy-files-sha256>"
[ -z "${extra:-}" ] || deny "unexpected arguments"
[[ "${tag:-}" =~ ^[0-9a-f]{12}$ ]] || deny "tag must be 12 hex characters (a short commit hash)"
[[ "${hash:-}" =~ ^[0-9a-f]{64}$ ]] || deny "deploy-files hash must be a sha256"

# The files this deploy runs must be the ones the commit was built with.
have="$(cd "$dir" && sha256sum compose.yaml Caddyfile deploy.sh | sha256sum | cut -c1-64)"
if [ "$have" != "$hash" ]; then
  echo "✗ this commit changes compose.yaml, Caddyfile, or deploy.sh. CI only ships images;" >&2
  echo "  run deploy/oracle/ship.sh <host> once from a machine with the repo, then re-run the job." >&2
  exit 3
fi

echo "• load cairnmcp:$tag"
# Cap the stream, then load it; the image must carry exactly the expected tag.
head -c "$max_bytes" | gunzip | docker load | sed 's/^/  /'
docker image inspect "cairnmcp:$tag" >/dev/null 2>&1 || deny "the stream didn't contain cairnmcp:$tag"
docker tag "cairnmcp:$tag" cairnmcp:local

cd "$dir/../.."
CAIRNMCP_VERSION="$tag" exec deploy/oracle/deploy.sh --no-pull --no-build
