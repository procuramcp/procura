#!/usr/bin/env bash
# Build, migrate, and deploy cairnmcp to Cloud Run. Run setup.sh once first.
#
#   CAIRNMCP_GCP_PROJECT=my-project deploy/cloud-run/deploy.sh
#
# Order matters: migrations run (as the owner role, in a job) before the new
# revision starts serving. Migrations only add things (D-024), so the running
# revision keeps working while they apply.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# shellcheck source=deploy/cloud-run/config.sh
source "$here/config.sh"

[ -z "$(git -C "$root" status --porcelain)" ] || { echo "commit or stash your changes first: the image is tagged with the commit" >&2; exit 1; }
TAG="$(git -C "$root" rev-parse --short=12 HEAD)"
IMAGE="${IMAGE_BASE}:${TAG}"
URL="$(public_url)"

step() { printf '\n• %s\n' "$*"; }

step "build $IMAGE"
# Cloud Run runs amd64; build for it even on Apple silicon.
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet >/dev/null
docker buildx build --platform linux/amd64 --tag "$IMAGE" --push "$root"

step "migrate (job $MIGRATE_JOB, owner role)"
gcloud_ run jobs deploy "$MIGRATE_JOB" --region "$REGION" --image "$IMAGE" \
  --service-account "$MIGRATE_SA" \
  --command node --args packages/db/scripts/migrate.ts \
  --set-secrets "CAIRNMCP_DATABASE_OWNER_URL=${SECRET_OWNER_URL}:latest" \
  --max-retries 0 --task-timeout 5m --cpu 1 --memory 512Mi
gcloud_ run jobs execute "$MIGRATE_JOB" --region "$REGION" --wait

step "deploy service $SERVICE"
# Free-tier shape (D-028): scale to zero, at most one instance (the in-memory
# rate limits are per instance), CPU only while handling requests.
gcloud_ run deploy "$SERVICE" --region "$REGION" --image "$IMAGE" \
  --service-account "$RUN_SA" \
  --allow-unauthenticated \
  --port 8080 --cpu 1 --memory 512Mi --concurrency 40 --timeout 60s \
  --min-instances 0 --max-instances 1 --cpu-throttling --cpu-boost \
  --startup-probe "httpGet.path=/healthz,initialDelaySeconds=0,periodSeconds=2,failureThreshold=15,timeoutSeconds=2" \
  --set-env-vars "CAIRNMCP_PUBLIC_URL=${URL}" \
  --set-secrets "CAIRNMCP_DATABASE_URL=${SECRET_DATABASE_URL}:latest,CAIRNMCP_MASTER_KEY=${SECRET_MASTER_KEY}:latest,CAIRNMCP_OIDC_PROVIDERS=${SECRET_OIDC_PROVIDERS}:latest"

step "check"
[ "$(curl -fsS "$URL/healthz")" = "ok" ] && curl -fsS "$URL/.well-known/oauth-authorization-server" | grep -q "\"issuer\":\"$URL\"" ||
  { echo "✗ the service didn't answer as expected at $URL" >&2; exit 1; }
printf '\n✓ deployed %s at %s\n' "$TAG" "$URL"
