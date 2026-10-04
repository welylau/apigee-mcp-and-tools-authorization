#!/usr/bin/env bash
set -euo pipefail

# Sourced environment variables
if [ -f .env ]; then
  source .env
fi

PROJECT="${GOOGLE_CLOUD_PROJECT:-YOUR_GCP_PROJECT_ID}"
REGION="${GOOGLE_CLOUD_REGION:-asia-southeast1}"
# The staff agent (coffee_agent_staff) uses the staff Keycloak client id as its
# Apigee API key. It is not a secret. --update-env-vars merges, so the
# service's other env vars are left as they are.
STAFF_CLIENT_ID="${KEYCLOAK_STAFF_CLIENT_ID:-biscuit-coffee-staff}"
# Model, Apigee prod hostname and store timezone are set explicitly so the
# service never runs on code defaults by accident. Override via env / .env.
MODEL_NAME="${MODEL_NAME:-gemini-3.5-flash-lite}"
APIGEE_PROD_HOSTNAME="${APIGEE_PROD_HOSTNAME:-prod.apigee-demo.com}"
case "$APIGEE_PROD_HOSTNAME" in
  ""|"<"*|"@"*) echo "APIGEE_PROD_HOSTNAME is not set to a real hostname" >&2; exit 1 ;;
esac
STORE_TIMEZONE="${STORE_TIMEZONE:-Asia/Singapore}"
# Comma-separated browser origins for `adk web`; empty = no CORS (default).
ALLOW_ORIGINS="${ADK_ALLOW_ORIGINS:-}"

echo "================================================="
echo "Deploying apigee-coffee-shop-adk to Cloud Run..."
echo "(serves coffee_agent_prod and coffee_agent_staff)"
echo "Project: ${PROJECT}  Region: ${REGION}"
echo "MODEL_NAME=${MODEL_NAME} APIGEE_PROD_HOSTNAME=${APIGEE_PROD_HOSTNAME} STORE_TIMEZONE=${STORE_TIMEZONE}"
echo "================================================="
gcloud run deploy apigee-coffee-shop-adk \
  --source=./biscuit-coffee \
  --project="$PROJECT" \
  --region="$REGION" \
  --update-env-vars="^|^KEYCLOAK_STAFF_CLIENT_ID=${STAFF_CLIENT_ID}|MODEL_NAME=${MODEL_NAME}|APIGEE_PROD_HOSTNAME=${APIGEE_PROD_HOSTNAME}|STORE_TIMEZONE=${STORE_TIMEZONE}|ALLOW_ORIGINS=${ALLOW_ORIGINS}" \
  --quiet

echo "ADK deployment complete."
