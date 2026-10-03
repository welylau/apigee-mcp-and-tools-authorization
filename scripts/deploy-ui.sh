#!/usr/bin/env bash
set -euo pipefail

# Sourced environment variables
if [ -f .env ]; then
  source .env
fi

PROJECT="${GOOGLE_CLOUD_PROJECT:-YOUR_GCP_PROJECT_ID}"
REGION="${GOOGLE_CLOUD_REGION:-asia-southeast1}"
UI_ENV_FILE="web-ui/.env"
KEYCLOAK_SECRET_NAME="${KEYCLOAK_SECRET_NAME:-keycloak-client-secret}"

if [ ! -f "$UI_ENV_FILE" ]; then
  echo "ERROR: $UI_ENV_FILE not found. It is the source of the UI's Cloud Run env vars." >&2
  exit 1
fi

echo "================================================="
echo "Syncing canonical agent files to web-ui/agents..."
echo "================================================="
rm -rf web-ui/agents
cp -r biscuit-coffee/python/agents web-ui/agents

# web-ui/.env is excluded from the image (.dockerignore); its values are applied
# as Cloud Run env vars instead. Secrets must NOT be placed in web-ui/.env.
ENV_VARS_FILE="$(mktemp)"
trap 'rm -f "$ENV_VARS_FILE"' EXIT
python3 - "$UI_ENV_FILE" "$ENV_VARS_FILE" <<'PYEOF'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
out = []
for line in open(src, encoding="utf-8"):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    k = k.strip()
    if k.startswith("export "):
        k = k[len("export "):].strip()
    if "SECRET" in k.upper() or "PASSWORD" in k.upper():
        sys.exit(f"ERROR: {k} looks like a secret; keep it out of web-ui/.env and use Secret Manager.")
    out.append(f"{k}: {json.dumps(v.strip().strip(chr(34)).strip(chr(39)))}")
open(dst, "w", encoding="utf-8").write("\n".join(out) + "\n")
PYEOF

echo "================================================="
echo "Deploying apigee-coffee-shop-ui to Cloud Run..."
echo "================================================="
# --env-vars-file makes web-ui/.env the single source of truth for plain env
# vars (it replaces them on each deploy). The Keycloak client secret is mounted
# from Secret Manager; the service account needs roles/secretmanager.secretAccessor.
gcloud run deploy apigee-coffee-shop-ui \
  --source=./web-ui \
  --project="$PROJECT" \
  --region="$REGION" \
  --env-vars-file="$ENV_VARS_FILE" \
  --update-secrets="KEYCLOAK_CLIENT_SECRET=${KEYCLOAK_SECRET_NAME}:latest" \
  --quiet

echo "Deployment complete."
