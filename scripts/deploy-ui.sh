#!/usr/bin/env bash
# Deploys the Biscuit Coffee web UI (BFF + static app) to Cloud Run.
#
# Usage:
#   scripts/deploy-ui.sh            # customer app  -> apigee-coffee-shop-ui
#   scripts/deploy-ui.sh customer   # same as above
#   scripts/deploy-ui.sh staff      # staff app     -> apigee-coffee-shop-staff-ui
#
# Both variants are the same image (web-ui/); UI_VARIANT selects the Keycloak
# client, the ADK app and the role gate at runtime (see web-ui/server.py).
set -euo pipefail

VARIANT="${1:-customer}"
case "$VARIANT" in
  customer|staff) ;;
  *)
    echo "ERROR: unknown variant '$VARIANT' (expected: customer | staff)" >&2
    exit 2
    ;;
esac

# Sourced environment variables
if [ -f .env ]; then
  source .env
fi

PROJECT="${GOOGLE_CLOUD_PROJECT:-YOUR_GCP_PROJECT_ID}"
REGION="${GOOGLE_CLOUD_REGION:-asia-southeast1}"
UI_ENV_FILE="web-ui/.env"

if [ "$VARIANT" = "staff" ]; then
  SERVICE="${STAFF_UI_SERVICE:-apigee-coffee-shop-staff-ui}"
  SECRET_ENV="KEYCLOAK_STAFF_CLIENT_SECRET"
  SECRET_NAME="${KEYCLOAK_STAFF_SECRET_NAME:-keycloak-staff-client-secret}"
else
  SERVICE="${CUSTOMER_UI_SERVICE:-apigee-coffee-shop-ui}"
  SECRET_ENV="KEYCLOAK_CLIENT_SECRET"
  SECRET_NAME="${KEYCLOAK_SECRET_NAME:-keycloak-client-secret}"
fi

if [ ! -f "$UI_ENV_FILE" ]; then
  echo "ERROR: $UI_ENV_FILE not found. It is the source of the UI's Cloud Run env vars." >&2
  exit 1
fi

echo "================================================="
echo "Syncing canonical agent files to web-ui/agents..."
echo "================================================="
rm -rf web-ui/agents
cp -r biscuit-coffee/python/agents web-ui/agents

# Variant-specific plain env vars. They override any same-named key in
# web-ui/.env. Cross-links between the two apps are optional (the UI hides the
# "open the other app" link when they are empty).
OVERRIDES=("UI_VARIANT=$VARIANT")
if [ "$VARIANT" = "staff" ]; then
  OVERRIDES+=("KEYCLOAK_STAFF_CLIENT_ID=${KEYCLOAK_STAFF_CLIENT_ID:-biscuit-coffee-staff}")
fi
[ -n "${CUSTOMER_APP_URL:-}" ] && OVERRIDES+=("CUSTOMER_APP_URL=$CUSTOMER_APP_URL")
[ -n "${STAFF_APP_URL:-}" ] && OVERRIDES+=("STAFF_APP_URL=$STAFF_APP_URL")

# web-ui/.env is excluded from the image (.dockerignore); its values are applied
# as Cloud Run env vars instead. Secrets must NOT be placed in web-ui/.env.
ENV_VARS_FILE="$(mktemp)"
trap 'rm -f "$ENV_VARS_FILE"' EXIT
python3 - "$UI_ENV_FILE" "$ENV_VARS_FILE" "${OVERRIDES[@]}" <<'PYEOF'
import json, sys
src, dst, overrides = sys.argv[1], sys.argv[2], sys.argv[3:]
env = {}
for line in open(src, encoding="utf-8"):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    k = k.strip()
    if k.startswith("export "):
        k = k[len("export "):].strip()
    env[k] = v.strip().strip(chr(34)).strip(chr(39))
for item in overrides:
    k, v = item.split("=", 1)
    env[k] = v
for k in env:
    if "SECRET" in k.upper() or "PASSWORD" in k.upper():
        sys.exit(f"ERROR: {k} looks like a secret; keep it out of web-ui/.env and use Secret Manager.")
open(dst, "w", encoding="utf-8").write("".join(f"{k}: {json.dumps(v)}\n" for k, v in env.items()))
PYEOF

echo "================================================="
echo "Deploying $SERVICE (UI_VARIANT=$VARIANT) to Cloud Run..."
echo "================================================="
# --env-vars-file makes web-ui/.env (+ the variant overrides above) the single
# source of truth for plain env vars (it replaces them on each deploy). The
# Keycloak client secret of this variant is mounted from Secret Manager; the
# service account needs roles/secretmanager.secretAccessor on that secret.
gcloud run deploy "$SERVICE" \
  --source=./web-ui \
  --project="$PROJECT" \
  --region="$REGION" \
  --env-vars-file="$ENV_VARS_FILE" \
  --update-secrets="${SECRET_ENV}=${SECRET_NAME}:latest" \
  --quiet

if [ "$VARIANT" = "staff" ] && [ "${STAFF_ENABLE_IAP:-1}" = "1" ]; then
  # Keep the staff app behind IAP like the customer app. Access is granted
  # separately (roles/iap.httpsResourceAccessor on this service); copy the
  # principals used for apigee-coffee-shop-ui.
  echo "Enabling IAP on $SERVICE ..."
  gcloud beta run services update "$SERVICE" \
    --project="$PROJECT" \
    --region="$REGION" \
    --iap \
    --quiet
  echo "NOTE: grant IAP access (roles/iap.httpsResourceAccessor) on $SERVICE to the same"
  echo "      principals as apigee-coffee-shop-ui, and add the service URL"
  echo "      (https://<url>/*) to the Keycloak client biscuit-coffee-staff redirect URIs."
fi

echo "Deployment complete."
