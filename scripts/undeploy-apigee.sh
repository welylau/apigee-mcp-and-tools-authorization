#!/bin/bash
# Removes everything scripts/deploy-apigee.sh created in the PROD environment:
# the two proxies, the developer apps (and their keys, incl. the staff key),
# the developers and the three API Products. Dev assets (scripts/deploy-apigee-dev.sh)
# are not touched.
#
# Idempotent: a 404 (already gone) is fine; any other failure stops the script.
set -euo pipefail

if [ -f .env ]; then
  echo "Sourcing .env..."
  set -a; source .env; set +a
fi

PROJECT="${GOOGLE_CLOUD_PROJECT:-${PROJECT_ID:-}}"
if [ -z "$PROJECT" ]; then
  echo "ERROR: GOOGLE_CLOUD_PROJECT or PROJECT_ID must be set" >&2
  exit 1
fi
PROD_ENV="${APIGEE_PROD_ENV:-${APIGEE_ENV:-prod-env}}"
STAFF_KEY="${KEYCLOAK_STAFF_CLIENT_ID:-biscuit-coffee-staff}"

TOKEN=$(gcloud auth application-default print-access-token 2>/dev/null || gcloud auth print-access-token 2>/dev/null || true)
if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to get GCP access token." >&2
  exit 1
fi

API="https://apigee.googleapis.com/v1/organizations/$PROJECT"

# DELETE helper: 2xx = deleted, 404 = already gone, anything else = abort.
delete() { # path description
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE -H "Authorization: Bearer $TOKEN" "$API$1")
  case "$code" in
    2??) echo "  deleted   $2" ;;
    404) echo "  not found $2" ;;
    *)   echo "ERROR: DELETE $1 -> HTTP $code" >&2; exit 1 ;;
  esac
}

# Prints the revision of $1 deployed in $PROD_ENV, or nothing.
deployed_revision() {
  curl -s -H "Authorization: Bearer $TOKEN" "$API/environments/$PROD_ENV/apis/$1/deployments" \
    | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin).get("deployments", [])
    print(d[0]["revision"] if d else "")
except Exception:
    print("")'
}

undeploy_and_delete_proxy() { # name
  local rev
  rev=$(deployed_revision "$1")
  if [ -n "$rev" ]; then
    echo "  undeploying $1 rev $rev from $PROD_ENV"
    delete "/environments/$PROD_ENV/apis/$1/revisions/$rev/deployments" "$1 deployment"
  fi
  delete "/apis/$1" "proxy $1"
}

echo "================================================="
echo "Cleaning up Apigee assets in $PROJECT / $PROD_ENV"
echo "================================================="

echo "Proxies..."
undeploy_and_delete_proxy "mcp-proxy-prod"
undeploy_and_delete_proxy "Biscuit-Coffee-Shop"

echo "Developer apps and keys..."
delete "/developers/admin-developer@biscuit-coffee.com/apps/biscuit-coffee-admin-app/keys/$STAFF_KEY" "staff key $STAFF_KEY"
delete "/developers/admin-developer@biscuit-coffee.com/apps/biscuit-coffee-admin-app" "app biscuit-coffee-admin-app"
delete "/developers/agent-developer@biscuit-coffee.com/apps/biscuit-coffee-agent-app" "app biscuit-coffee-agent-app"

echo "Developers..."
delete "/developers/admin-developer@biscuit-coffee.com" "developer admin-developer@biscuit-coffee.com"
delete "/developers/agent-developer@biscuit-coffee.com" "developer agent-developer@biscuit-coffee.com"

echo "API Products..."
delete "/apiproducts/biscuit-coffee-agent" "product biscuit-coffee-agent"
delete "/apiproducts/biscuit-coffee-staff" "product biscuit-coffee-staff"
delete "/apiproducts/biscuit-coffee-admin" "product biscuit-coffee-admin"

echo "================================================="
echo "Apigee cleanup complete."
echo "================================================="
