#!/usr/bin/env bash
# One-time setup so a push to main deploys to the VM (D-036). Run from the repo
# on your machine, with SSH to the VM and `gh` signed in:
#
#   deploy/oracle/setup-ci-deploy.sh cairnmcp      # an SSH host, e.g. from ~/.ssh/config
#
# It makes a deploy key that can only run ci-receive.sh on the VM, pins the VM's
# host key, stores both as secrets of a "production" environment that only main
# can use, and turns the deploy job on. Run it again to rotate the key.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
host="${1:?usage: deploy/oracle/setup-ci-deploy.sh <ssh host>}"
remote="${CAIRNMCP_REMOTE_DIR:-cairnmcp}"
marker="cairnmcp-ci-deploy"
step() { printf '\n• %s\n' "$*"; }

repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
address="$(ssh -G "$host" | awk '/^hostname /{print $2}')"
user="$(ssh -G "$host" | awk '/^user /{print $2}')"
domain="$(ssh "$host" "sed -n 's/^CAIRNMCP_DOMAIN=//p' '$remote/deploy/oracle/.env'")"
[ -n "$domain" ] || { echo "no CAIRNMCP_DOMAIN on the VM: is it set up (setup-vm.sh)?" >&2; exit 1; }
echo "  repo $repo, VM $user@$address, site https://$domain"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

step "deploy key (only for GitHub; it never touches this disk outside $work)"
ssh-keygen -q -t ed25519 -N "" -C "$marker" -f "$work/key"

step "install the deploy command on the VM (outside the repo copy, so CI can't change it)"
ssh "$host" "mkdir -p ~/cairnmcp-ci && cat > ~/cairnmcp-ci/receive.sh && chmod 755 ~/cairnmcp-ci/receive.sh" < "$here/ci-receive.sh"

step "authorize the key for that command only"
# Earlier deploy keys are replaced; your own keys are left as they are (a backup is kept).
# The key's words arrive as arguments ($*), so no quoting is nested inside quoting.
ssh "$host" bash -s -- "$(cat "$work/key.pub")" <<'REMOTE'
set -euo pipefail
cd ~/.ssh
cp authorized_keys authorized_keys.bak-ci
grep -v 'cairnmcp-ci-deploy' authorized_keys > authorized_keys.new || true
# Your own key must still be there before anything is replaced.
[ -s authorized_keys.new ] || { echo "no other keys in authorized_keys; refusing to change it" >&2; rm -f authorized_keys.new; exit 1; }
printf 'restrict,command="%s/cairnmcp-ci/receive.sh" %s\n' "$HOME" "$*" >> authorized_keys.new
chmod 600 authorized_keys.new
mv authorized_keys.new authorized_keys
REMOTE

step "pin the VM's host key (read over your already-trusted connection)"
host_key="$(ssh "$host" 'cat /etc/ssh/ssh_host_ed25519_key.pub' | awk '{print $1, $2}')"
printf '%s %s\n' "$address" "$host_key" > "$work/known_hosts"

step "check the key is locked to the deploy command"
out="$(ssh -i "$work/key" -o IdentitiesOnly=yes -o UserKnownHostsFile="$work/known_hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes \
  "$user@$address" "id" 2>&1 || true)"
grep -q "refused: the only command is" <<<"$out" || { echo "✗ expected the key to be refused for other commands; got: $out" >&2; exit 1; }
echo "  ✓ the key can't run other commands"

step "GitHub: a production environment only main can deploy from"
gh api -X PUT "repos/$repo/environments/production" -F "deployment_branch_policy[protected_branches]=false" -F "deployment_branch_policy[custom_branch_policies]=true" >/dev/null
gh api "repos/$repo/environments/production/deployment-branch-policies" -q '.branch_policies[].name' | grep -qx main ||
  gh api -X POST "repos/$repo/environments/production/deployment-branch-policies" -f name=main >/dev/null

step "GitHub: secrets and settings"
gh secret set DEPLOY_SSH_KEY --env production --repo "$repo" < "$work/key"
gh secret set DEPLOY_KNOWN_HOSTS --env production --repo "$repo" < "$work/known_hosts"
printf '%s' "$address" | gh secret set DEPLOY_HOST --env production --repo "$repo"
printf '%s' "$user" | gh secret set DEPLOY_USER --env production --repo "$repo"
gh variable set DEPLOY_DOMAIN --repo "$repo" --body "$domain"
gh variable set DEPLOY_ENABLED --repo "$repo" --body true

printf '\n✓ pushes to main now deploy to https://%s after CI passes.\n' "$domain"
printf '  To approve each deploy first: GitHub → Settings → Environments → production → Required reviewers.\n'
printf '  To pause deploys: gh variable set DEPLOY_ENABLED --body false\n'
