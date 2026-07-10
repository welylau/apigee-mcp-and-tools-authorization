#!/bin/bash

# Exit on error
set -e

# Sourced environment variables
if [ -f .env ]; then
  echo "Sourcing .env..."
  source .env
fi

PROJECT="${GOOGLE_CLOUD_PROJECT:-$PROJECT_ID}"
if [ -z "$PROJECT" ]; then
  echo "ERROR: GOOGLE_CLOUD_PROJECT or PROJECT_ID must be set"
  exit 1
fi

DEV_ENV="$APIGEE_DEV_ENV"
PROD_ENV="$APIGEE_PROD_ENV"

if [ -z "$DEV_ENV" ] || [ -z "$PROD_ENV" ]; then
  echo "ERROR: APIGEE_DEV_ENV and APIGEE_PROD_ENV must be set"
  exit 1
fi

TOKEN=$(gcloud auth application-default print-access-token 2>/dev/null || gcloud auth print-access-token 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to get GCP access token."
  exit 1
fi

# Ensure apigeecli is installed
if ! command -v apigeecli &> /dev/null; then
  if [ -f "$HOME/.apigeecli/bin/apigeecli" ]; then
    export PATH=$PATH:$HOME/.apigeecli/bin
  else
    echo "apigeecli not found. Nothing to clean."
    exit 0
  fi
fi

echo "================================================="
echo "Cleaning up Apigee Assets"
echo "================================================="

echo "Deleting Developer Apps..."
apigeecli apps delete --name "biscuit-coffee-admin-app" --org "$PROJECT" --token "$TOKEN" 2>/dev/null || true
apigeecli apps delete --name "biscuit-coffee-agent-app" --org "$PROJECT" --token "$TOKEN" 2>/dev/null || true

echo "Deleting Developers..."
apigeecli developers delete --email "admin-developer@biscuit-coffee.com" --org "$PROJECT" --token "$TOKEN" 2>/dev/null || true
apigeecli developers delete --email "agent-developer@biscuit-coffee.com" --org "$PROJECT" --token "$TOKEN" 2>/dev/null || true

echo "Deleting API Products..."
apigeecli products delete --name "biscuit-coffee-admin" --org "$PROJECT" --token "$TOKEN" 2>/dev/null || true
apigeecli products delete --name "biscuit-coffee-agent" --org "$PROJECT" --token "$TOKEN" 2>/dev/null || true

# Helper to get the currently deployed revision of a proxy in a specific environment
get_deployed_revision() {
  local name=$1
  local env=$2
  local rev
  rev=$(apigeecli apis listdeploy --name "$name" --org "$PROJECT" --env "$env" --token "$TOKEN" 2>/dev/null | jq -r '.deployments[0].revision' 2>/dev/null || true)
  if [ "$rev" != "null" ] && [ -n "$rev" ]; then
    echo "$rev"
  fi
}

# Function to undeploy and delete a proxy
undeploy_and_delete_proxy() {
  local name=$1
  local envs=("$2" "$3")
  for env in "${envs[@]}"; do
    if [ -n "$env" ]; then
      local rev
      rev=$(get_deployed_revision "$name" "$env")
      if [ -n "$rev" ]; then
        echo "Undeploying proxy: $name (revision $rev) from environment: $env"
        apigeecli apis undeploy --name "$name" --org "$PROJECT" --env "$env" --rev "$rev" --token "$TOKEN" 2>/dev/null || true
      else
        echo "Proxy $name is not deployed in environment: $env"
      fi
    fi
  done
  echo "Deleting proxy: $name"
  apigeecli apis delete --name "$name" --org "$PROJECT" --token "$TOKEN" 2>/dev/null || true
}

# Cleanup MCP proxies
undeploy_and_delete_proxy "mcp-proxy-dev" "$DEV_ENV"
undeploy_and_delete_proxy "mcp-proxy-prod" "$PROD_ENV"

# Cleanup Biscuit-Coffee-Shop proxy from both environments
undeploy_and_delete_proxy "Biscuit-Coffee-Shop" "$DEV_ENV" "$PROD_ENV"

echo "================================================="
echo "Apigee Cleanup Complete!"
echo "================================================="
