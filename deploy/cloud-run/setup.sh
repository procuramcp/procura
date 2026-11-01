#!/usr/bin/env bash
# One-time Google Cloud setup for cairnmcp on Cloud Run. Safe to re-run: it
# creates what's missing and leaves the rest alone. See deploy/cloud-run/README.md.
#
#   CAIRNMCP_GCP_PROJECT=my-project deploy/cloud-run/setup.sh
#
# Secret values are read from your terminal (hidden), never from arguments,
# so they don't end up in shell history.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/cloud-run/config.sh
source "$here/config.sh"

step() { printf '\n• %s\n' "$*"; }

printf 'Public URL: %s\nGoogle sign-in redirect URI: %s/oauth/callback/google\n' "$(public_url)" "$(public_url)"

step "APIs (Cloud Run, Artifact Registry, Secret Manager)"
gcloud_ services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com

step "image registry $REPO in $REGION"
gcloud_ artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 ||
  gcloud_ artifacts repositories create "$REPO" --location "$REGION" --repository-format docker \
    --description "cairnmcp images"
# Keep storage inside the free 0.5 GB: only the newest images.
cat >"${TMPDIR:-/tmp}/cairnmcp-cleanup.json" <<'JSON'
[{"name": "keep-recent", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 3}},
 {"name": "delete-old", "action": {"type": "Delete"}, "condition": {"olderThan": "1d"}}]
JSON
gcloud_ artifacts repositories set-cleanup-policies "$REPO" --location "$REGION" \
  --policy "${TMPDIR:-/tmp}/cairnmcp-cleanup.json" >/dev/null

step "service accounts"
for sa in "$RUN_SA" "$MIGRATE_SA"; do
  name="${sa%%@*}"
  gcloud_ iam service-accounts describe "$sa" >/dev/null 2>&1 ||
    gcloud_ iam service-accounts create "$name" --display-name "$name"
done

put_secret() { # name prompt
  local name="$1" prompt="$2" value
  if gcloud_ secrets describe "$name" >/dev/null 2>&1; then
    printf '  %s exists (to replace it: gcloud secrets versions add %s --data-file=-)\n' "$name" "$name"
    return
  fi
  read -r -s -p "  $prompt: " value
  echo
  [ -n "$value" ] || { echo "  empty value, skipped $name" >&2; return 1; }
  gcloud_ secrets create "$name" --replication-policy automatic >/dev/null
  printf '%s' "$value" | gcloud_ secrets versions add "$name" --data-file=- >/dev/null
}

step "secrets"
put_secret "$SECRET_DATABASE_URL" "CAIRNMCP_DATABASE_URL from .env.local (cairnmcp_server, pooled)"
put_secret "$SECRET_OWNER_URL" "DATABASE_URL_UNPOOLED from .env.local (owner, direct)"
if ! gcloud_ secrets describe "$SECRET_MASTER_KEY" >/dev/null 2>&1; then
  # Generated here and never shown: losing it makes stored credentials unreadable, so it lives only in Secret Manager.
  gcloud_ secrets create "$SECRET_MASTER_KEY" --replication-policy automatic >/dev/null
  openssl rand -base64 32 | tr -d '\n' | gcloud_ secrets versions add "$SECRET_MASTER_KEY" --data-file=- >/dev/null
  echo "  $SECRET_MASTER_KEY generated"
else
  echo "  $SECRET_MASTER_KEY exists"
fi
put_secret "$SECRET_OIDC_PROVIDERS" "CAIRNMCP_OIDC_PROVIDERS JSON (see README: Google sign-in)"

step "access: each service account reads only its own secrets"
grant() { # secret member
  gcloud_ secrets add-iam-policy-binding "$1" --member "serviceAccount:$2" --role roles/secretmanager.secretAccessor >/dev/null
}
for s in "$SECRET_DATABASE_URL" "$SECRET_MASTER_KEY" "$SECRET_OIDC_PROVIDERS"; do grant "$s" "$RUN_SA"; done
grant "$SECRET_OWNER_URL" "$MIGRATE_SA"

printf '\n✓ setup done. Public URL will be %s\n' "$(public_url)"
printf '  Google sign-in redirect URI: %s/oauth/callback/google\n' "$(public_url)"
printf '  Next: deploy/cloud-run/deploy.sh\n'
