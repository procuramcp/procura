#!/usr/bin/env bash
# Build the image on this machine and deploy it to the VM over SSH. For VMs
# too small to build it (the free x86 VM.Standard.E2.1.Micro has 1 GB), and
# quicker on any VM. The VM doesn't need the repo, only Docker and its settings.
#
#   deploy/oracle/ship.sh cairnmcp     # an SSH host, e.g. from ~/.ssh/config
#
# First time: this copies deploy/oracle/ to the VM and stops; run
# deploy/oracle/setup-vm.sh there, then run ship.sh again.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
host="${1:?usage: deploy/oracle/ship.sh <ssh host>}"
remote="${CAIRNMCP_REMOTE_DIR:-cairnmcp}"
step() { printf '\n• %s\n' "$*"; }

step "copy deploy files to $host:$remote/deploy/oracle (settings on the VM are left alone)"
ssh "$host" "mkdir -p '$remote/deploy/oracle'"
# Settings stay on the VM, and infra/ (Terraform state and variables) stays on this machine.
rsync -az --exclude '.env' --exclude '*.env' --exclude 'infra/' "$here/" "$host:$remote/deploy/oracle/"
if ! ssh "$host" "test -f '$remote/deploy/oracle/app.env'"; then
  printf '\nNot set up yet. On the VM run:\n  cd %s && deploy/oracle/setup-vm.sh\nthen run this again.\n' "$remote"
  exit 1
fi

case "$(ssh "$host" uname -m)" in
  x86_64) platform=linux/amd64 ;;
  aarch64) platform=linux/arm64 ;;
  *) echo "unsupported VM architecture" >&2; exit 1 ;;
esac
tag="$(git -C "$root" rev-parse --short=12 HEAD)"
[ -z "$(git -C "$root" status --porcelain)" ] || { tag="$tag-dirty"; echo "  note: shipping uncommitted changes ($tag)"; }

step "build $tag for $platform"
docker buildx build --platform "$platform" --tag cairnmcp:local --tag "cairnmcp:$tag" --load "$root"

step "copy the image to $host"
docker save cairnmcp:local "cairnmcp:$tag" | gzip -1 | ssh "$host" 'gunzip | docker load' | sed 's/^/  /'

step "deploy on $host"
ssh "$host" "cd '$remote' && CAIRNMCP_VERSION='$tag' deploy/oracle/deploy.sh --no-pull --no-build"
