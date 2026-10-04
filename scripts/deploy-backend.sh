#!/usr/bin/env bash
set -euo pipefail

# Sourced environment variables
if [ -f .env ]; then
  source .env
fi

PROJECT="${GOOGLE_CLOUD_PROJECT:-YOUR_GCP_PROJECT_ID}"
REGION="${GOOGLE_CLOUD_REGION:-asia-southeast1}"
# Keycloak realm whose access tokens the backend accepts in X-User-Token
# (must match the issuer the Apigee proxy verifies).
KEYCLOAK_ISSUER="${KEYCLOAK_ISSUER:-https://keycloak.YOUR_KEYCLOAK_IP.nip.io/realms/apigee-demo}"
KEYCLOAK_AUDIENCE="${KEYCLOAK_AUDIENCE:-biscuit-coffee}"
# Dedicated runtime identity with Firestore access only (roles/datastore.user).
RUN_SA="${BACKEND_RUN_SA:-biscuit-backend-run@${PROJECT}.iam.gserviceaccount.com}"
# Backend copy of the gateway's order rules (dollars): >= ORDER_CAP is refused,
# >= APPROVAL_THRESHOLD waits for staff approval. Keep in step with the API
# product attributes Apigee uses (maxOrderAmount / approval threshold).
ORDER_CAP="${ORDER_CAP:-100.00}"
APPROVAL_THRESHOLD="${APPROVAL_THRESHOLD:-50.00}"

echo "================================================="
echo "Deploying biscuit-coffee-backend to Cloud Run..."
echo "  project=$PROJECT region=$REGION"
echo "  runtime SA=$RUN_SA"
echo "  KEYCLOAK_ISSUER=$KEYCLOAK_ISSUER"
echo "================================================="
# The service stays private (Cloud Run IAM: only the Apigee SA and named
# operators hold run.invoker). Every non-public route also verifies the
# user's Keycloak token forwarded by Apigee in X-User-Token (see auth.py).
gcloud run deploy biscuit-coffee-backend \
  --source=./coffee-shop-backend \
  --project="$PROJECT" \
  --region="$REGION" \
  --service-account="$RUN_SA" \
  --no-allow-unauthenticated \
  --update-env-vars="KEYCLOAK_ISSUER=${KEYCLOAK_ISSUER},KEYCLOAK_AUDIENCE=${KEYCLOAK_AUDIENCE},ORDER_CAP=${ORDER_CAP},APPROVAL_THRESHOLD=${APPROVAL_THRESHOLD}" \
  --quiet

echo "Backend deployment complete."
