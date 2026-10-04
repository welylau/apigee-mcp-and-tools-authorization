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

echo "================================================="
echo "Deploying apigee-coffee-shop-adk to Cloud Run..."
echo "(serves coffee_agent_prod and coffee_agent_staff)"
echo "================================================="
gcloud run deploy apigee-coffee-shop-adk \
  --source=./biscuit-coffee \
  --project="$PROJECT" \
  --region="$REGION" \
  --update-env-vars="KEYCLOAK_STAFF_CLIENT_ID=${STAFF_CLIENT_ID}" \
  --quiet

echo "ADK deployment complete."
