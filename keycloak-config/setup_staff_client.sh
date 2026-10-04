#!/usr/bin/env bash
# =============================================================================
# setup_staff_client.sh - Staff app identity setup (Customer / Staff split).
#
# Creates (idempotently, ADDITIVE ONLY):
#   * realm role   'staff'
#   * client scope 'biscuit_coffee_staff'  (role scope mapping -> realm role staff,
#                                           so the scope only lands in tokens of
#                                           users that hold the staff role)
#   * confidential client 'biscuit-coffee-staff'
#       - audience mapper 'biscuit-coffee' (required by JWT-VerifyToken in Apigee)
#       - default scopes: biscuit_coffee_staff, biscuit_coffee_manager
#         (manager is role-gated too, so only managers receive it)
#       - redirect URIs limited to the staff UI origins
#   * demo user 'staff@biscuit-coffee.com' (role: staff)
#   * grants role 'staff' to 'manager@biscuit-coffee.com' (store manager =
#     staff + manager)
#
# Never modifies the customer client 'biscuit-coffee-agent' or its scopes.
# Uses the Keycloak Admin REST API over HTTPS, so no SSH to the VM is needed.
#
# Usage:
#   KC_ADMIN_PASS='...' STAFF_CLIENT_SECRET='...' \
#   [STAFF_UI_URL='https://apigee-coffee-shop-staff-ui-xxxx.run.app'] \
#   ./setup_staff_client.sh
# =============================================================================
set -euo pipefail

KC_BASE="${KC_BASE:-https://keycloak.YOUR_KEYCLOAK_IP.nip.io}"
REALM="${REALM:-apigee-demo}"
KC_ADMIN_USER="${KC_ADMIN_USER:-admin}"
: "YOUR_KEYCLOAK_ADMIN_PASSWORD"
STAFF_CLIENT_ID="${STAFF_CLIENT_ID:-biscuit-coffee-staff}"
: "${STAFF_CLIENT_SECRET:?STAFF_CLIENT_SECRET must be set}"
STAFF_UI_URL="${STAFF_UI_URL:-}"
STAFF_USER="${STAFF_USER:-staff@biscuit-coffee.com}"
: "${STAFF_USER_PASS:=ilovecoffee}"
MANAGER_USER="${MANAGER_USER:-manager@biscuit-coffee.com}"

TOKEN=$(curl -sf -X POST "$KC_BASE/realms/master/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=admin-cli \
  -d username="$KC_ADMIN_USER" --data-urlencode "password=$KC_ADMIN_PASS" | jq -r .access_token)
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || { echo "ERROR: admin login failed"; exit 1; }

API="$KC_BASE/admin/realms/$REALM"
H=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

echo "=== 1. Realm role 'staff' ==="
if curl -sf "${H[@]}" "$API/roles/staff" >/dev/null 2>&1; then
  echo "Role 'staff' already exists."
else
  curl -sf -X POST "${H[@]}" "$API/roles" \
    -d '{"name":"staff","description":"Biscuit Coffee store staff (orders)"}'
fi
STAFF_ROLE_JSON=$(curl -sf "${H[@]}" "$API/roles/staff")

echo "=== 2. Client scope 'biscuit_coffee_staff' ==="
scope_id() { curl -sf "${H[@]}" "$API/client-scopes" | jq -r --arg n "$1" '.[] | select(.name==$n) | .id'; }
STAFF_SCOPE_ID=$(scope_id biscuit_coffee_staff)
if [ -z "$STAFF_SCOPE_ID" ]; then
  curl -sf -X POST "${H[@]}" "$API/client-scopes" -d '{
    "name":"biscuit_coffee_staff","protocol":"openid-connect",
    "attributes":{"include.in.token.scope":"true","display.on.consent.screen":"true"}}'
  STAFF_SCOPE_ID=$(scope_id biscuit_coffee_staff)
else
  echo "Scope already exists."
fi
MANAGER_SCOPE_ID=$(scope_id biscuit_coffee_manager)
[ -n "$STAFF_SCOPE_ID" ] && [ -n "$MANAGER_SCOPE_ID" ] || { echo "ERROR: scopes not found"; exit 1; }
# Role-gate the scope: only users holding realm role 'staff' receive it.
curl -sf -X POST "${H[@]}" "$API/client-scopes/$STAFF_SCOPE_ID/scope-mappings/realm" \
  -d "[$STAFF_ROLE_JSON]"

echo "=== 3. Client '$STAFF_CLIENT_ID' ==="
REDIRECTS=$(jq -cn --arg u "$STAFF_UI_URL" \
  '["http://localhost:3001/*","http://127.0.0.1:3001/*"] + (if $u == "" then [] else [($u|rtrimstr("/")) + "/*"] end)')
ORIGINS=$(jq -cn --arg u "$STAFF_UI_URL" \
  '["http://localhost:3001","http://127.0.0.1:3001"] + (if $u == "" then [] else [($u|rtrimstr("/"))] end)')
CID=$(curl -sf "${H[@]}" "$API/clients?clientId=$STAFF_CLIENT_ID" | jq -r '.[0].id // empty')
if [ -z "$CID" ]; then
  PAYLOAD=$(jq -n --arg id "$STAFF_CLIENT_ID" --arg secret "$STAFF_CLIENT_SECRET" \
    --argjson r "$REDIRECTS" --argjson o "$ORIGINS" '{
    clientId: $id,
    name: "Biscuit Coffee Staff",
    description: "Staff / store-manager web app (Apigee app biscuit-coffee-admin-app)",
    enabled: true, protocol: "openid-connect", publicClient: false,
    clientAuthenticatorType: "client-secret", secret: $secret,
    standardFlowEnabled: true, directAccessGrantsEnabled: true,
    serviceAccountsEnabled: false,
    redirectUris: $r, webOrigins: $o,
    attributes: {"post.logout.redirect.uris": "+"},
    protocolMappers: [{
      name: "biscuit-coffee-audience", protocol: "openid-connect",
      protocolMapper: "oidc-audience-mapper",
      config: {"included.custom.audience": "biscuit-coffee",
               "id.token.claim": "true", "access.token.claim": "true"}
    }]
  }')
  curl -sf -X POST "${H[@]}" "$API/clients" -d "$PAYLOAD"
  CID=$(curl -sf "${H[@]}" "$API/clients?clientId=$STAFF_CLIENT_ID" | jq -r '.[0].id')
  echo "Created internal id: $CID"
else
  echo "Client exists ($CID) - refreshing redirect URIs / web origins only."
  curl -sf "${H[@]}" "$API/clients/$CID" \
    | jq --argjson r "$REDIRECTS" --argjson o "$ORIGINS" '.redirectUris=$r | .webOrigins=$o' \
    | curl -sf -X PUT "${H[@]}" "$API/clients/$CID" -d @-
fi

echo "=== 4. Client scopes on '$STAFF_CLIENT_ID' ==="
CUSTOMER_SCOPE_ID=$(scope_id biscuit_coffee_customer)
if [ -n "$CUSTOMER_SCOPE_ID" ]; then
  curl -s -X DELETE "${H[@]}" "$API/clients/$CID/default-client-scopes/$CUSTOMER_SCOPE_ID" >/dev/null || true
  curl -s -X DELETE "${H[@]}" "$API/clients/$CID/optional-client-scopes/$CUSTOMER_SCOPE_ID" >/dev/null || true
fi
curl -sf -X PUT "${H[@]}" "$API/clients/$CID/default-client-scopes/$STAFF_SCOPE_ID"
curl -sf -X PUT "${H[@]}" "$API/clients/$CID/default-client-scopes/$MANAGER_SCOPE_ID"

echo "=== 5. Demo users ==="
uid() { curl -sf "${H[@]}" "$API/users?exact=true&username=$1" | jq -r '.[0].id // empty'; }
STAFF_UID=$(uid "$STAFF_USER")
if [ -z "$STAFF_UID" ]; then
  curl -sf -X POST "${H[@]}" "$API/users" -d "$(jq -n --arg u "$STAFF_USER" '{
    username:$u, email:$u, firstName:"Sam", lastName:"Barista",
    enabled:true, emailVerified:true}')"
  STAFF_UID=$(uid "$STAFF_USER")
  curl -sf -X PUT "${H[@]}" "$API/users/$STAFF_UID/reset-password" \
    -d "$(jq -n --arg p "$STAFF_USER_PASS" '{type:"password",value:$p,temporary:false}')"
else
  echo "User '$STAFF_USER' already exists."
fi
curl -sf -X POST "${H[@]}" "$API/users/$STAFF_UID/role-mappings/realm" -d "[$STAFF_ROLE_JSON]"

MANAGER_UID=$(uid "$MANAGER_USER")
[ -n "$MANAGER_UID" ] || { echo "ERROR: $MANAGER_USER not found"; exit 1; }
curl -sf -X POST "${H[@]}" "$API/users/$MANAGER_UID/role-mappings/realm" -d "[$STAFF_ROLE_JSON]"

echo "=== 6. Result ==="
curl -sf "${H[@]}" "$API/clients/$CID" | jq -c '{clientId, enabled, redirectUris, mappers: [.protocolMappers[].name]}'
curl -sf "${H[@]}" "$API/clients/$CID/default-client-scopes" | jq -c '[.[].name]'
echo "=== Staff client setup complete ==="
