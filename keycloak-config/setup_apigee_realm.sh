#!/usr/bin/env bash
set -euo pipefail

KEYCLOAK_CONTAINER="keycloak"
ADMIN_USER="admin"
ADMIN_PASS="YOUR_KEYCLOAK_ADMIN_PASSWORD"
REALM_NAME="apigee-demo"
CLIENT_ID="biscuit-coffee-agent"
CLIENT_SECRET="YOUR_KEYCLOAK_CLIENT_SECRET"
DEMO_USER="customer@biscuit-coffee.com"
DEMO_PASS="ilovecoffee"

echo "=== 1. Authenticating kcadm in container ==="
sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080 \
  --realm master \
  --user "$ADMIN_USER" \
  --password "$ADMIN_PASS"

echo "=== 2. Creating '$REALM_NAME' Realm ==="
if sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh get realms/"$REALM_NAME" >/dev/null 2>&1; then
  echo "Realm '$REALM_NAME' already exists."
else
  sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh create realms \
    -s realm="$REALM_NAME" \
    -s displayName="Apigee Demo" \
    -s enabled=true
fi

echo "=== 3. Creating Custom Scopes ==="
for scope in biscuit_coffee_customer biscuit_coffee_manager; do
  if ! sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh get client-scopes -r "$REALM_NAME" -q name="$scope" | grep -q "\"name\" : \"$scope\""; then
    sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh create client-scopes -r "$REALM_NAME" \
      -s name="$scope" -s protocol=openid-connect \
      -s 'attributes={"include.in.token.scope":"true","display.on.consent.screen":"true"}'
  else
    echo "Scope '$scope' already exists."
  fi
done

echo "=== 4. Creating '$CLIENT_ID' Client ==="
if ! sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh get clients -r "$REALM_NAME" -q clientId="$CLIENT_ID" | grep -q "\"clientId\" : \"$CLIENT_ID\""; then
  sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh create clients -r "$REALM_NAME" \
    -s clientId="$CLIENT_ID" \
    -s name="Biscuit Coffee Agent" \
    -s enabled=true \
    -s clientAuthenticatorType=client-secret \
    -s secret="$CLIENT_SECRET" \
    -s publicClient=false \
    -s standardFlowEnabled=true \
    -s directAccessGrantsEnabled=true \
    -s serviceAccountsEnabled=true \
    -s 'redirectUris=["*"]' \
    -s 'webOrigins=["*"]'
else
  echo "Client '$CLIENT_ID' already exists."
fi

INTERNAL_CLIENT_ID=$(sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh get clients -r "$REALM_NAME" -q clientId="$CLIENT_ID" --fields id --format csv | tail -n 1 | tr -d '"\r\n')
echo "Internal Client ID: $INTERNAL_CLIENT_ID"

echo "=== 5. Adding Audience Mapper ('biscuit-coffee') ==="
if ! sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh get clients/"$INTERNAL_CLIENT_ID"/protocol-mappers/models -r "$REALM_NAME" 2>/dev/null | grep -q "biscuit-coffee-audience"; then
  sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh create clients/"$INTERNAL_CLIENT_ID"/protocol-mappers/models -r "$REALM_NAME" \
    -s name="biscuit-coffee-audience" \
    -s protocol="openid-connect" \
    -s protocolMapper="oidc-audience-mapper" \
    -s 'config={"included.custom.audience":"biscuit-coffee","id.token.claim":"true","access.token.claim":"true"}'
else
  echo "Audience mapper already exists."
fi

echo "=== 6. Attaching Client Scopes ==="
CUSTOMER_SCOPE_ID=$(sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh get client-scopes -r "$REALM_NAME" -q name="biscuit_coffee_customer" --fields id --format csv | tail -n 1 | tr -d '"\r\n')
MANAGER_SCOPE_ID=$(sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh get client-scopes -r "$REALM_NAME" -q name="biscuit_coffee_manager" --fields id --format csv | tail -n 1 | tr -d '"\r\n')

# Attach biscuit_coffee_customer as default client scope
sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh update clients/"$INTERNAL_CLIENT_ID"/default-client-scopes/"$CUSTOMER_SCOPE_ID" -r "$REALM_NAME" 2>/dev/null || true

# Attach biscuit_coffee_manager as optional client scope
sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh delete clients/"$INTERNAL_CLIENT_ID"/default-client-scopes/"$MANAGER_SCOPE_ID" -r "$REALM_NAME" 2>/dev/null || true
sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh update clients/"$INTERNAL_CLIENT_ID"/optional-client-scopes/"$MANAGER_SCOPE_ID" -r "$REALM_NAME" 2>/dev/null || true

echo "=== 7. Creating Realm Roles ==="
for role in customer manager; do
  if ! sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh get roles/"$role" -r "$REALM_NAME" >/dev/null 2>&1; then
    sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh create roles -r "$REALM_NAME" -s name="$role"
  else
    echo "Role '$role' already exists."
  fi
done

echo "=== 8. Mapping 'manager' Role to 'biscuit_coffee_manager' Scope ==="
MANAGER_ROLE_JSON=$(sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh get roles/manager -r "$REALM_NAME")
echo "[$MANAGER_ROLE_JSON]" | sudo docker exec -i "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh create client-scopes/"$MANAGER_SCOPE_ID"/scope-mappings/realm -r "$REALM_NAME" -f - 2>/dev/null || true

echo "=== 9. Creating Users ==="
# 9a. Customer user
if ! sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh get users -r "$REALM_NAME" -q username="$DEMO_USER" | grep -q "\"username\" : \"$DEMO_USER\""; then
  sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh create users -r "$REALM_NAME" \
    -s username="$DEMO_USER" \
    -s email="$DEMO_USER" \
    -s firstName="John" \
    -s lastName="Smith" \
    -s enabled=true \
    -s emailVerified=true

  sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh set-password -r "$REALM_NAME" \
    --username "$DEMO_USER" \
    --new-password "$DEMO_PASS"
else
  echo "User '$DEMO_USER' already exists."
fi
sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh add-roles -r "$REALM_NAME" --uusername "$DEMO_USER" --rolename customer 2>/dev/null || true

# 9b. Manager user
MANAGER_USER="manager@biscuit-coffee.com"
MANAGER_PASS="ilovecoffee"
if ! sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh get users -r "$REALM_NAME" -q username="$MANAGER_USER" | grep -q "\"username\" : \"$MANAGER_USER\""; then
  sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh create users -r "$REALM_NAME" \
    -s username="$MANAGER_USER" \
    -s email="$MANAGER_USER" \
    -s firstName="Manager" \
    -s lastName="Alice" \
    -s enabled=true \
    -s emailVerified=true

  sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh set-password -r "$REALM_NAME" \
    --username "$MANAGER_USER" \
    --new-password "$MANAGER_PASS"
else
  echo "User '$MANAGER_USER' already exists."
fi
sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh add-roles -r "$REALM_NAME" --uusername "$MANAGER_USER" --rolename manager --rolename customer 2>/dev/null || true

# 9c. Additional customer user
CUSTOMER3_USER="customer3@biscuit-coffee.com"
CUSTOMER3_PASS="ilovecoffee"
if ! sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh get users -r "$REALM_NAME" -q username="$CUSTOMER3_USER" | grep -q "\"username\" : \"$CUSTOMER3_USER\""; then
  sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh create users -r "$REALM_NAME" \
    -s username="$CUSTOMER3_USER" \
    -s email="$CUSTOMER3_USER" \
    -s firstName="Customer" \
    -s lastName="Three" \
    -s enabled=true \
    -s emailVerified=true

  sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh set-password -r "$REALM_NAME" \
    --username "$CUSTOMER3_USER" \
    --new-password "$CUSTOMER3_PASS"
else
  echo "User '$CUSTOMER3_USER' already exists."
fi
sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh add-roles -r "$REALM_NAME" --uusername "$CUSTOMER3_USER" --rolename customer 2>/dev/null || true

# 9d. Michael Bosh customer user
CUSTOMER2_USER="customer2@biscuit-coffee.com"
CUSTOMER2_PASS="ilovecoffee"
if ! sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh get users -r "$REALM_NAME" -q username="$CUSTOMER2_USER" | grep -q "\"username\" : \"$CUSTOMER2_USER\""; then
  sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh create users -r "$REALM_NAME" \
    -s username="$CUSTOMER2_USER" \
    -s email="$CUSTOMER2_USER" \
    -s firstName="Michael" \
    -s lastName="Bosh" \
    -s enabled=true \
    -s emailVerified=true

  sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh set-password -r "$REALM_NAME" \
    --username "$CUSTOMER2_USER" \
    --new-password "$CUSTOMER2_PASS"
else
  echo "User '$CUSTOMER2_USER' already exists."
fi
sudo docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh add-roles -r "$REALM_NAME" --uusername "$CUSTOMER2_USER" --rolename customer 2>/dev/null || true

echo "=== Keycloak Setup Completed Successfully ==="
