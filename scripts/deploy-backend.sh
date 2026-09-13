#!/usr/bin/env bash
set -euo pipefail

# Sourced environment variables
if [ -f .env ]; then
  source .env
fi

PROJECT="${GOOGLE_CLOUD_PROJECT:-YOUR_GCP_PROJECT_ID}"
REGION="${GOOGLE_CLOUD_REGION:-asia-southeast1}"

echo "================================================="
echo "Deploying biscuit-coffee-backend to Cloud Run..."
echo "================================================="
gcloud run deploy biscuit-coffee-backend \
  --source=./coffee-shop-backend \
  --project="$PROJECT" \
  --region="$REGION" \
  --quiet

echo "Backend deployment complete."
