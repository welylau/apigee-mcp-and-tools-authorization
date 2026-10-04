#!/usr/bin/env bash
# Deploys the Biscuit Coffee web UI (BFF + static app) to Cloud Run.
#
# Usage:
#   scripts/deploy-ui.sh            # customer app  -> apigee-coffee-shop-ui
#   scripts/deploy-ui.sh customer   # same as above
#   scripts/deploy-ui.sh staff      # staff app     -> apigee-coffee-shop-staff-ui
#
# Both variants are the same code (web-ui/); UI_VARIANT selects the Keycloak
# client, the ADK app and the role gate at runtime (see web-ui/server.py). Each
# image only contains the ADK agent of its own variant.
#
# Settings come from the caller's environment first, then from the repo-root
# .env. The .env file is parsed for a fixed list of keys only; it is never
# sourced/executed.
set -euo pipefail

VARIANT="${1:-customer}"
case "$VARIANT" in
  customer|staff) ;;
  *)
    echo "ERROR: unknown variant '$VARIANT' (expected: customer | staff)" >&2
    exit 2
    ;;
esac

# Keys this script reads from .env (anything else in .env is ignored).
DOTENV_KEYS=(
  GOOGLE_CLOUD_PROJECT GOOGLE_CLOUD_REGION
  CUSTOMER_UI_SERVICE STAFF_UI_SERVICE
  KEYCLOAK_SECRET_NAME KEYCLOAK_STAFF_SECRET_NAME KEYCLOAK_STAFF_CLIENT_ID
  CUSTOMER_APP_URL STAFF_APP_URL
  ENABLE_IAP STAFF_ENABLE_IAP
)

# dotenv_get KEY -> value of KEY in .env (last assignment wins), or empty.
# Plain text parsing: no shell expansion, no command substitution.
dotenv_get() {
  [ -f .env ] || return 0
  python3 -c '
import sys
key, val = sys.argv[1], ""
for line in open(".env", encoding="utf-8"):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    k = k.strip()
    if k.startswith("export "):
        k = k[len("export "):].strip()
    if k == key:
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"\x27":
            v = v[1:-1]
        val = v
print(val)
' "$1"
}

for key in "${DOTENV_KEYS[@]}"; do
  if [ -z "${!key:-}" ]; then
    value="$(dotenv_get "$key")"
    if [ -n "$value" ]; then
      printf -v "$key" '%s' "$value"
    fi
  fi
done

PROJECT="${GOOGLE_CLOUD_PROJECT:-YOUR_GCP_PROJECT_ID}"
REGION="${GOOGLE_CLOUD_REGION:-asia-southeast1}"
UI_ENV_FILE="web-ui/.env"

if [ "$VARIANT" = "staff" ]; then
  SERVICE="${STAFF_UI_SERVICE:-apigee-coffee-shop-staff-ui}"
  SECRET_ENV="KEYCLOAK_STAFF_CLIENT_SECRET"
  SECRET_NAME="${KEYCLOAK_STAFF_SECRET_NAME:-keycloak-staff-client-secret}"
  AGENT_DIR="coffee_agent_staff"
else
  SERVICE="${CUSTOMER_UI_SERVICE:-apigee-coffee-shop-ui}"
  SECRET_ENV="KEYCLOAK_CLIENT_SECRET"
  SECRET_NAME="${KEYCLOAK_SECRET_NAME:-keycloak-client-secret}"
  AGENT_DIR="coffee_agent_prod"
fi

if [ ! -f "$UI_ENV_FILE" ]; then
  echo "ERROR: $UI_ENV_FILE not found. It is the source of the UI's Cloud Run env vars." >&2
  exit 1
fi

AGENTS_SRC="biscuit-coffee/python/agents"
echo "================================================="
echo "Syncing $AGENT_DIR + biscuit_common.py to web-ui/agents..."
echo "================================================="
# Only this variant's agent and the shared module go into the image.
rm -rf web-ui/agents
mkdir -p web-ui/agents
cp "$AGENTS_SRC/biscuit_common.py" web-ui/agents/
cp -r "$AGENTS_SRC/$AGENT_DIR" "web-ui/agents/$AGENT_DIR"
# Local caches / session stores / env files never ship (also in .dockerignore).
rm -rf "web-ui/agents/$AGENT_DIR/__pycache__" "web-ui/agents/$AGENT_DIR/.adk"
rm -f "web-ui/agents/$AGENT_DIR/.env"

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
import json, re, sys
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
# Anything that looks like a credential must come from Secret Manager instead.
SECRET_LIKE = re.compile(r"SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE|CREDENTIAL|_KEY$", re.I)
for k in env:
    if SECRET_LIKE.search(k):
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
# --session-affinity: ADK sessions live in the instance's memory, so a user's
# requests should keep reaching the same instance.
gcloud run deploy "$SERVICE" \
  --source=./web-ui \
  --project="$PROJECT" \
  --region="$REGION" \
  --env-vars-file="$ENV_VARS_FILE" \
  --update-secrets="${SECRET_ENV}=${SECRET_NAME}:latest" \
  --session-affinity \
  --quiet

# Both apps sit behind IAP; enforce it on every deploy instead of relying on
# whatever state the service had. ENABLE_IAP=0 (or legacy STAFF_ENABLE_IAP=0
# for the staff app) skips this step.
IAP_FLAG="${ENABLE_IAP:-1}"
if [ "$VARIANT" = "staff" ] && [ -n "${STAFF_ENABLE_IAP:-}" ] && [ -z "${ENABLE_IAP:-}" ]; then
  IAP_FLAG="$STAFF_ENABLE_IAP"
fi
if [ "$IAP_FLAG" = "1" ]; then
  echo "Enforcing IAP on $SERVICE ..."
  gcloud beta run services update "$SERVICE" \
    --project="$PROJECT" \
    --region="$REGION" \
    --iap \
    --quiet
  echo "NOTE: IAP access is granted separately (roles/iap.httpsResourceAccessor on"
  echo "      $SERVICE). The service URL (https://<url>/*) must be a redirect URI of"
  echo "      its Keycloak client."
else
  echo "WARNING: IAP enforcement skipped for $SERVICE (ENABLE_IAP=$IAP_FLAG)." >&2
fi

echo "Deployment complete."
