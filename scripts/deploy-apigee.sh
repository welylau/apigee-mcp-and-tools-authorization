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

echo "Setting gcloud project to $PROJECT..."
gcloud config set project "$PROJECT"

PROD_ENV="${APIGEE_PROD_ENV:-${APIGEE_ENV:-prod-env}}"

if [ -z "$PROD_ENV" ]; then
  echo "ERROR: APIGEE_PROD_ENV (or APIGEE_ENV) must be set"
  exit 1
fi

TOKEN=$(gcloud auth application-default print-access-token 2>/dev/null || gcloud auth print-access-token 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to get GCP access token. Please run 'gcloud auth application-default login' first."
  exit 1
fi

# Parse parameters
DEPLOY_PRODUCTS=true
DEPLOY_MCP=true
DEPLOY_REST=true

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --no-products) DEPLOY_PRODUCTS=false ;;
    --no-mcp) DEPLOY_MCP=false ;;
    --no-rest) DEPLOY_REST=false ;;
    *) echo "Unknown parameter passed: $1"; exit 1 ;;
  esac
  shift
done

# Ensure apigeecli is installed
if ! command -v apigeecli &> /dev/null; then
  if [ -f "$HOME/.apigeecli/bin/apigeecli" ]; then
    export PATH=$PATH:$HOME/.apigeecli/bin
  else
    echo "apigeecli not found. Installing..."
    curl -s https://raw.githubusercontent.com/apigee/apigeecli/main/downloadLatest.sh | bash
    export PATH=$PATH:$HOME/.apigeecli/bin
  fi
fi

# Determine sed in-place arguments for portability (macOS vs Linux)
sedi_args=("-i")
if [[ "$(uname)" == "Darwin" ]]; then
  sedi_args=("-i" "")
fi

echo "================================================="
echo "Replacing Placeholders in Agents & Proxies"
echo "================================================="

# 1. Replace hostnames and local agent python files
if [ -f "./biscuit-coffee/python/agents/coffee_agent_prod/tools.py" ]; then
  echo "Replacing prod hostname in coffee_agent_prod/tools.py..."
  sed "${sedi_args[@]}" "s|@APIGEE_PROD_HOSTNAME@|$APIGEE_PROD_HOSTNAME|g" ./biscuit-coffee/python/agents/coffee_agent_prod/tools.py
fi

# 2. Create a temporary staging directory to process proxy bundle files
TMP_DIR=$(mktemp -d)
echo "Staging proxy bundles in temporary directory: $TMP_DIR"

mkdir -p "$TMP_DIR/prod-proxy"
cp -r ./apiproxy/prod-proxy/apiproxy "$TMP_DIR/prod-proxy/"

mkdir -p "$TMP_DIR/mcp-proxy-prod"
cp -r ./apiproxy/mcp-proxy-prod/apiproxy "$TMP_DIR/mcp-proxy-prod/"

# Replace placeholders in temp copies
echo "Performing replacements on proxy files..."
find "$TMP_DIR" -type f -exec sed "${sedi_args[@]}" "s|@APIGEE_PROD_HOSTNAME@|$APIGEE_PROD_HOSTNAME|g" {} +
find "$TMP_DIR" -type f -exec sed "${sedi_args[@]}" "s|@GCP_PROJECT_ID@|$PROJECT|g" {} +

echo "================================================="
echo "Starting Apigee Deployment"
echo "================================================="

# 1. Deploy REST API Proxies
if [ "$DEPLOY_REST" = true ]; then
  echo "Deploying Biscuit-Coffee-Shop API proxy to $PROD_ENV..."
  apigeecli apis create bundle -n Biscuit-Coffee-Shop -f "$TMP_DIR/prod-proxy/apiproxy" --org "$PROJECT" --token "$TOKEN"
  apigeecli apis deploy --name Biscuit-Coffee-Shop --org "$PROJECT" --env "$PROD_ENV" -s "sa-apigee-aiservices@${PROJECT}.iam.gserviceaccount.com" --ovr --wait --token "$TOKEN"
fi

# 2. Deploy MCP Discovery Proxies (if enabled)
if [ "$DEPLOY_MCP" = true ]; then
  echo "Deploying Prod MCP Discovery Proxy to $PROD_ENV..."
  apigeecli apis create bundle -n mcp-proxy-prod -f "$TMP_DIR/mcp-proxy-prod/apiproxy" --org "$PROJECT" --token "$TOKEN"
  apigeecli apis deploy --name mcp-proxy-prod --org "$PROJECT" --env "$PROD_ENV" --ovr --wait --token "$TOKEN"
fi

# Clean up temp staging directory
rm -rf "$TMP_DIR"

# Helper function to create or update an API product using curl to support payloadOperationGroup
create_or_update_product() {
  local name="$1"
  local display_name="$2"
  local env="$3"
  local ops_file="$4"

  local payload
  payload=$(jq -n \
    --arg name "$name" \
    --arg displayName "$display_name" \
    --arg env "$env" \
    --slurpfile ops "$ops_file" \
    '{name: $name, displayName: $displayName, approvalType: "auto", environments: [$env]} + $ops[0]')

  local status_code
  status_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    "https://apigee.googleapis.com/v1/organizations/$PROJECT/apiproducts/$name")

  local response_file
  response_file=$(mktemp)
  local http_code

  if [ "$status_code" -eq 200 ]; then
    echo "Product $name already exists. Updating..."
    http_code=$(curl -s -X PUT \
      "https://apigee.googleapis.com/v1/organizations/$PROJECT/apiproducts/$name" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$payload" \
      -o "$response_file" \
      -w "%{http_code}")
  else
    echo "Product $name does not exist. Creating..."
    http_code=$(curl -s -X POST \
      "https://apigee.googleapis.com/v1/organizations/$PROJECT/apiproducts" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$payload" \
      -o "$response_file" \
      -w "%{http_code}")
  fi

  if [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
    echo "ERROR: Failed to save product $name (HTTP $http_code)"
    cat "$response_file"
    rm -f "$response_file"
    exit 1
  fi
  rm -f "$response_file"
}

# 3. Deploy API Products, Developer, and App (if enabled)
if [ "$DEPLOY_PRODUCTS" = true ]; then
  echo "Creating/Updating API Products..."
  # Admin Product
  create_or_update_product "biscuit-coffee-admin" "Biscuit Coffee Admin Product" "$PROD_ENV" "./config/admin-product-ops.json"

  # Agent Product
  create_or_update_product "biscuit-coffee-agent" "Biscuit Coffee AI Agent Product" "$PROD_ENV" "./config/agent-product-ops.json"


  echo "Creating/Updating Developers..."
  # Admin Dev
  if ! apigeecli developers get --email "admin-developer@biscuit-coffee.com" --org "$PROJECT" --token "$TOKEN" >/dev/null 2>&1; then
    apigeecli developers create --user "biscuit-coffee-admin-developer" \
      --email "admin-developer@biscuit-coffee.com" \
      --first "Admin" --last "Dev" \
      --org "$PROJECT" --token "$TOKEN"
  else
    echo "Developer admin-developer@biscuit-coffee.com already exists. Skipping."
  fi

  # Agent Dev
  if ! apigeecli developers get --email "agent-developer@biscuit-coffee.com" --org "$PROJECT" --token "$TOKEN" >/dev/null 2>&1; then
    apigeecli developers create --user "biscuit-coffee-agent-developer" \
      --email "agent-developer@biscuit-coffee.com" \
      --first "Agent" --last "Dev" \
      --org "$PROJECT" --token "$TOKEN"
  else
    echo "Developer agent-developer@biscuit-coffee.com already exists. Skipping."
  fi

  echo "Creating/Updating Developer Apps..."
  # Admin App
  admin_app_status=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    "https://apigee.googleapis.com/v1/organizations/$PROJECT/developers/admin-developer@biscuit-coffee.com/apps/biscuit-coffee-admin-app")
  if [ "$admin_app_status" -ne 200 ]; then
    apigeecli apps create --name "biscuit-coffee-admin-app" \
      --email "admin-developer@biscuit-coffee.com" \
      --prods "biscuit-coffee-admin" \
      --org "$PROJECT" --token "$TOKEN"
  else
    echo "App biscuit-coffee-admin-app already exists. Skipping."
  fi

  # Agent App
  agent_app_status=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    "https://apigee.googleapis.com/v1/organizations/$PROJECT/developers/agent-developer@biscuit-coffee.com/apps/biscuit-coffee-agent-app")
  if [ "$agent_app_status" -ne 200 ]; then
    apigeecli apps create --name "biscuit-coffee-agent-app" \
      --email "agent-developer@biscuit-coffee.com" \
      --prods "biscuit-coffee-agent" \
      --org "$PROJECT" --token "$TOKEN"
  else
    echo "App biscuit-coffee-agent-app already exists. Skipping."
  fi

  echo "Registering external IdP client ID..."
  key_status=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    "https://apigee.googleapis.com/v1/organizations/$PROJECT/developers/agent-developer@biscuit-coffee.com/apps/biscuit-coffee-agent-app/keys/biscuit-coffee-agent")
  if [ "$key_status" -ne 200 ]; then

    apigeecli apps keys create --org "$PROJECT" --token "$TOKEN" \
      --name "biscuit-coffee-agent-app" \
      --key "biscuit-coffee-agent" \
      --secret "YOUR_KEYCLOAK_CLIENT_SECRET" \
      --dev "agent-developer@biscuit-coffee.com" \
      --prods "biscuit-coffee-agent"
  else
    echo "App credential key biscuit-coffee-agent already exists. Skipping."
  fi

fi

echo "================================================="
echo "Apigee Deployment Complete!"
echo "================================================="
