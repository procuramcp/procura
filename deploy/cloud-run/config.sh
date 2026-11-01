# Shared settings for setup.sh and deploy.sh. Override any of these in the environment.
# shellcheck shell=bash

PROJECT="${CAIRNMCP_GCP_PROJECT:?set CAIRNMCP_GCP_PROJECT to your Google Cloud project id}"
# us-west1 (Oregon) sits next to the Neon project in aws-us-west-2.
REGION="${CAIRNMCP_GCP_REGION:-us-west1}"
SERVICE="${CAIRNMCP_SERVICE:-cairnmcp}"
MIGRATE_JOB="${SERVICE}-migrate"
REPO="${CAIRNMCP_ARTIFACT_REPO:-cairnmcp}"
IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/cairnmcp"

# One identity per job, each with only the secrets it needs.
RUN_SA="${SERVICE}-run@${PROJECT}.iam.gserviceaccount.com"
MIGRATE_SA="${SERVICE}-migrate@${PROJECT}.iam.gserviceaccount.com"

# Secret Manager names.
SECRET_DATABASE_URL="cairnmcp-database-url"            # app role (pooled)
SECRET_OWNER_URL="cairnmcp-database-owner-url"         # owner role (direct), migrations only
SECRET_MASTER_KEY="cairnmcp-master-key"
SECRET_OIDC_PROVIDERS="cairnmcp-oidc-providers"

gcloud_() { gcloud --project "$PROJECT" --quiet "$@"; }

project_number() { gcloud projects describe "$PROJECT" --format='value(projectNumber)'; }

# Cloud Run's default URL is predictable, so the public URL (also the OAuth issuer) is known before the first deploy.
public_url() { echo "${CAIRNMCP_PUBLIC_URL:-https://${SERVICE}-$(project_number).${REGION}.run.app}"; }
