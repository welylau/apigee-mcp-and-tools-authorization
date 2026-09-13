#!/usr/bin/env bash
set -euo pipefail

# Sourced environment variables
if [ -f .env ]; then
  source .env
fi

PROJECT="${GOOGLE_CLOUD_PROJECT:-YOUR_GCP_PROJECT_ID}"
REGION="${GOOGLE_CLOUD_REGION:-asia-southeast1}"

echo "================================================="
echo "Syncing canonical agent files to web-ui/agents..."
echo "================================================="
rm -rf web-ui/agents
cp -r biscuit-coffee/python/agents web-ui/agents

echo "================================================="
echo "Deploying apigee-coffee-shop-ui to Cloud Run..."
echo "================================================="
gcloud run deploy apigee-coffee-shop-ui \
  --source=./web-ui \
  --project="$PROJECT" \
  --region="$REGION" \
  --quiet

echo "Deployment complete."
