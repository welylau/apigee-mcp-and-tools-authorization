#!/usr/bin/env bash
# =============================================================================
# setup_dev_client.sh - create the ISOLATED dev Keycloak client
#                       'biscuit-coffee-agent-dev' (Option B).
#
# CREATE-ONLY. This script deliberately does NOT re-run setup_apigee_realm.sh,
# because that script also writes to SHARED realm objects prod depends on
# (biscuit_coffee_manager scope mappings, demo-user role grants).
#
# Guarantees:
#   * Aborts if the dev client already exists (never updates anything).
#   * Never modifies the realm, client scopes, roles, users or the prod client
#     'biscuit-coffee-agent'. Existing scope IDs are only READ and then attached
#     to the NEW client.
#
# Uses the Keycloak Admin REST API over HTTPS, so no SSH to the VM is needed.
#
# Usage:
#   KC_ADMIN_PASS='...' DEV_CLIENT_SECRET='...' ./setup_dev_client.sh
# =============================================================================
set -euo pipefail

KC_BASE="${KC_BASE:-https://keycloak.YOUR_KEYCLOAK_IP.nip.io}"
REALM="${REALM:-apigee-demo}"
KC_ADMIN_USER="${KC_ADMIN_USER:-admin}"
: "YOUR_KEYCLOAK_ADMIN_PASSWORD"
DEV_CLIENT_ID="${DEV_CLIENT_ID:-biscuit-coffee-agent-dev}"
: "${DEV_CLIENT_SECRET:?DEV_CLIENT_SECRET must be set}"

case "$DEV_CLIENT_ID" in
  *-dev) ;;
  *) echo "REFUSING: DEV_CLIENT_ID must end with '-dev' (got '$DEV_CLIENT_ID')"; exit 1 ;;
esac

TOKEN=$(curl -sf -X POST "$KC_BASE/realms/master/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=admin-cli \
  -d username="$KC_ADMIN_USER" --data-urlencode "password=$KC_ADMIN_PASS" | jq -r .access_token)
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || { echo "ERROR: admin login failed"; exit 1; }

API="$KC_BASE/admin/realms/$REALM"
H=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

echo "=== 1. Checking that '$DEV_CLIENT_ID' does not exist yet ==="
EXISTING=$(curl -sf "${H[@]}" "$API/clients?clientId=$DEV_CLIENT_ID" | jq 'length')
if [ "$EXISTING" != "0" ]; then
  echo "Client '$DEV_CLIENT_ID' already exists - aborting without changes."
  exit 2
fi

echo "=== 2. Creating client '$DEV_CLIENT_ID' ==="
# Dev parity with the prod client, plus direct access grants for the test harness.
PAYLOAD=$(jq -n --arg id "$DEV_CLIENT_ID" --arg secret "$DEV_CLIENT_SECRET" '{
  clientId: $id,
  name: "Biscuit Coffee Agent (DEV)",
  description: "Isolated dev client for default-dev / dev.apigee-demo.com",
  enabled: true,
  protocol: "openid-connect",
  publicClient: false,
  clientAuthenticatorType: "client-secret",
  secret: $secret,
  standardFlowEnabled: true,
  directAccessGrantsEnabled: true,
  serviceAccountsEnabled: false,
  redirectUris: ["http://localhost:3000/*", "http://127.0.0.1:3000/*"],
  webOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
  protocolMappers: [{
    name: "biscuit-coffee-audience",
    protocol: "openid-connect",
    protocolMapper: "oidc-audience-mapper",
    config: {
      "included.custom.audience": "biscuit-coffee",
      "id.token.claim": "true",
      "access.token.claim": "true"
    }
  }]
}')
curl -sf -X POST "${H[@]}" "$API/clients" -d "$PAYLOAD"
CID=$(curl -sf "${H[@]}" "$API/clients?clientId=$DEV_CLIENT_ID" | jq -r '.[0].id')
echo "Created internal id: $CID"

echo "=== 3. Attaching EXISTING scopes to the NEW client only ==="
scope_id() { curl -sf "${H[@]}" "$API/client-scopes" | jq -r --arg n "$1" '.[] | select(.name==$n) | .id'; }
CUSTOMER_SCOPE_ID=$(scope_id biscuit_coffee_customer)
MANAGER_SCOPE_ID=$(scope_id biscuit_coffee_manager)
[ -n "$CUSTOMER_SCOPE_ID" ] && [ -n "$MANAGER_SCOPE_ID" ] || { echo "ERROR: shared scopes not found"; exit 1; }
curl -sf -X PUT "${H[@]}" "$API/clients/$CID/default-client-scopes/$CUSTOMER_SCOPE_ID"
curl -sf -X PUT "${H[@]}" "$API/clients/$CID/optional-client-scopes/$MANAGER_SCOPE_ID"

echo "=== 4. Result ==="
curl -sf "${H[@]}" "$API/clients/$CID" | jq -c '{clientId, enabled, standardFlowEnabled, directAccessGrantsEnabled, mappers: [.protocolMappers[].name]}'
curl -sf "${H[@]}" "$API/clients/$CID/default-client-scopes"  | jq -c '[.[].name]'
curl -sf "${H[@]}" "$API/clients/$CID/optional-client-scopes" | jq -c '[.[].name]'
echo "=== Dev client setup complete ==="
