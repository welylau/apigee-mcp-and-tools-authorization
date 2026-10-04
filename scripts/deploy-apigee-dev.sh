#!/bin/bash
# =============================================================================
# deploy-apigee-dev.sh - deploy the Biscuit Coffee demo to the ISOLATED dev
# environment (default-dev / dev.apigee-demo.com) WITHOUT touching production.
#
# Phases (run one or more):
#   --identity   Create/update dev API products + dev app/key   (Option B)
#   --baseline   Biscuit-Coffee-Shop rev 11 -> default-dev, and mcp-proxy-dev
#                rebuilt from the mcp-proxy-prod source (prod parity)
#   --audit      Upload repo source (with audit logging) as new revisions of
#                mcp-proxy-dev and Biscuit-Coffee-Shop and deploy to default-dev
#
# Safety rails (all hard-coded on purpose):
#   * Target environment is ALWAYS default-dev; the script aborts if it is ever
#     anything containing "prod".
#   * Only the proxies mcp-proxy-dev and Biscuit-Coffee-Shop are deployed, and
#     only to default-dev. Uploading a new revision never changes what prod runs.
#   * Product / app writes are restricted to names ending in "-dev".
#   * Repo files are never edited in place - bundles are staged in a temp dir.
#   * Never touches scripts/deploy-apigee.sh, prod products, prod apps or keys.
# =============================================================================
set -euo pipefail

if [ -f .env ]; then set -a; source .env; set +a; fi

PROJECT="${GOOGLE_CLOUD_PROJECT:?GOOGLE_CLOUD_PROJECT must be set}"
DEV_ENV="default-dev"
DEV_HOST="dev.apigee-demo.com"
SA="sa-apigee-aiservices@${PROJECT}.iam.gserviceaccount.com"
DEV_CLIENT_ID="${KEYCLOAK_DEV_CLIENT_ID:-biscuit-coffee-agent-dev}"
DEV_CLIENT_SECRET="${KEYCLOAK_DEV_CLIENT_SECRET:?KEYCLOAK_DEV_CLIENT_SECRET must be set in .env}"
DEV_DEVELOPER="agent-developer@biscuit-coffee.com"
DEV_APP="biscuit-coffee-agent-dev-app"
BISCUIT_BASELINE_REV="11"
API="https://apigee.googleapis.com/v1/organizations/$PROJECT"

# ---- Safety rails ------------------------------------------------------------
case "$DEV_ENV" in *prod*) echo "REFUSING: target env '$DEV_ENV' looks like prod"; exit 1 ;; esac
assert_dev_name() { case "$1" in *-dev|*-dev-app) ;; *) echo "REFUSING to write non-dev object '$1'"; exit 1 ;; esac; }
assert_allowed_proxy() { case "$1" in mcp-proxy-dev|Biscuit-Coffee-Shop) ;; *) echo "REFUSING to deploy proxy '$1'"; exit 1 ;; esac; }

DO_IDENTITY=false; DO_BASELINE=false; DO_AUDIT=false
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --identity) DO_IDENTITY=true ;;
    --baseline) DO_BASELINE=true ;;
    --audit)    DO_AUDIT=true ;;
    *) echo "Unknown parameter: $1"; exit 1 ;;
  esac
  shift
done
$DO_IDENTITY || $DO_BASELINE || $DO_AUDIT || { echo "Usage: $0 [--identity] [--baseline] [--audit]"; exit 1; }

command -v apigeecli >/dev/null || export PATH=$PATH:$HOME/.apigeecli/bin
TOKEN=$(gcloud auth application-default print-access-token 2>/dev/null)
[ -n "$TOKEN" ] || { echo "ERROR: no ADC token (run gcloud auth application-default login)"; exit 1; }
AUTH=(-H "Authorization: Bearer $TOKEN")
JSON=(-H "Content-Type: application/json")

api() { # method path [body]  -> prints body, fails on non-2xx
  local m=$1 p=$2 b=${3:-} out code
  out=$(mktemp)
  if [ -n "$b" ]; then code=$(curl -s -o "$out" -w "%{http_code}" -X "$m" "${AUTH[@]}" "${JSON[@]}" "$API$p" -d "$b")
  else code=$(curl -s -o "$out" -w "%{http_code}" -X "$m" "${AUTH[@]}" "$API$p"); fi
  if [ "$code" -lt 200 ] || [ "$code" -ge 300 ]; then echo "ERROR: $m $p -> HTTP $code" >&2; cat "$out" >&2; rm -f "$out"; return 1; fi
  cat "$out"; rm -f "$out"
}
exists() { [ "$(curl -s -o /dev/null -w "%{http_code}" "${AUTH[@]}" "$API$1")" = "200" ]; }

deploy_rev() { # proxy rev
  assert_allowed_proxy "$1"
  echo ">> Deploying $1 rev $2 -> $DEV_ENV (SA $SA)"
  apigeecli apis deploy --name "$1" --rev "$2" --org "$PROJECT" --env "$DEV_ENV" \
    -s "$SA" --ovr --wait --token "$TOKEN" --disable-check
}
upload_bundle() { # proxy dir -> echoes new revision
  assert_allowed_proxy "$1"
  apigeecli apis create bundle -n "$1" -f "$2" --org "$PROJECT" --token "$TOKEN" --disable-check \
    | jq -r '.revision'
}

stage_mcp_dev() { # -> echoes staged apiproxy dir
  local d; d=$(mktemp -d)
  cp -r ./apiproxy/mcp-proxy-prod/apiproxy "$d/"
  mv "$d/apiproxy/mcp-proxy-prod.xml" "$d/apiproxy/mcp-proxy-dev.xml"
  sed -i '' -e 's|name="mcp-proxy-prod"|name="mcp-proxy-dev"|' \
            -e 's|<DisplayName>mcp-proxy-prod</DisplayName>|<DisplayName>mcp-proxy-dev</DisplayName>|' \
            -e 's|<Description>Production Apigee MCP Server</Description>|<Description>Dev Apigee MCP Server (default-dev)</Description>|' \
            "$d/apiproxy/mcp-proxy-dev.xml"
  find "$d" -type f -exec sed -i '' \
    -e "s|@APIGEE_PROD_HOSTNAME@|$DEV_HOST|g" \
    -e "s|@GCP_PROJECT_ID@|$PROJECT|g" {} +
  echo "$d/apiproxy"
}
stage_biscuit_dev() {
  local d; d=$(mktemp -d)
  cp -r ./apiproxy/prod-proxy/apiproxy "$d/"
  # OAS is documentation only; point it at the dev host for accuracy.
  sed -i '' "s|https://prod.apigee-demo.com|https://$DEV_HOST|g" "$d/apiproxy/resources/oas/openapi.yaml"
  echo "$d/apiproxy"
}

# =============================================================================
if $DO_IDENTITY; then
  echo "================ Phase: identity ================"
  upsert_dev_product() { # name displayName opsFile
    local name=$1 display=$2 ops=$3 payload
    assert_dev_name "$name"
    payload=$(jq --arg name "$name" --arg dn "$display" --arg env "$DEV_ENV" '
      (.payloadOperationGroup.operationConfigs[].apiSource) |= sub("^mcp-proxy-prod$"; "mcp-proxy-dev")
      | {name: $name, displayName: $dn, approvalType: "auto", environments: [$env]} + .' "$ops")
    if exists "/apiproducts/$name"; then
      echo ">> Updating dev product $name"; api PUT "/apiproducts/$name" "$payload" >/dev/null
    else
      echo ">> Creating dev product $name"; api POST "/apiproducts" "$payload" >/dev/null
    fi
  }
  upsert_dev_product biscuit-coffee-agent-dev "Biscuit Coffee AI Agent Product (DEV)" ./config/agent-product-ops.json
  upsert_dev_product biscuit-coffee-admin-dev "Biscuit Coffee Admin Product (DEV)"    ./config/admin-product-ops.json

  assert_dev_name "$DEV_APP"
  APP_PATH="/developers/$DEV_DEVELOPER/apps/$DEV_APP"
  if ! exists "$APP_PATH"; then
    echo ">> Creating dev app $DEV_APP"
    # Attributes copied from the prod app + Environment=dev (exercised by AccessEntity logging).
    APP_BODY=$(jq -n --arg n "$DEV_APP" '{name: $n, attributes: [
      {name: "DisplayName",    value: "Biscuit Coffee Agent (DEV)"},
      {name: "DetailDesc",      value: "Chat app used by the customers to order coffee and biscuits (dev)"},
      {name: "PublicHostedURL", value: "https://mcp-tool.apigee-demo.com/"},
      {name: "RiskLevel",       value: "Medium"},
      {name: "Environment",     value: "dev"}]}')
    api POST "/developers/$DEV_DEVELOPER/apps" "$APP_BODY" >/dev/null
    # Remove the auto-generated random credential of this NEW dev app only.
    for k in $(api GET "$APP_PATH" | jq -r --arg keep "$DEV_CLIENT_ID" '.credentials[]?.consumerKey | select(. != $keep)'); do
      echo ">> Removing auto-generated credential of $DEV_APP"
      api DELETE "$APP_PATH/keys/$k" >/dev/null
    done
  else
    echo ">> Dev app $DEV_APP already exists"
  fi
  if ! exists "$APP_PATH/keys/$DEV_CLIENT_ID"; then
    echo ">> Registering key $DEV_CLIENT_ID (Keycloak dev client id) on $DEV_APP"
    api POST "$APP_PATH/keys" "$(jq -n --arg k "$DEV_CLIENT_ID" --arg s "$DEV_CLIENT_SECRET" '{consumerKey: $k, consumerSecret: $s}')" >/dev/null
  fi
  echo ">> Associating dev products with key $DEV_CLIENT_ID"
  api POST "$APP_PATH/keys/$DEV_CLIENT_ID" '{"apiProducts":["biscuit-coffee-agent-dev","biscuit-coffee-admin-dev"]}' >/dev/null
  api GET "$APP_PATH" | jq -c '{app: .name, attributes: [.attributes[].name], keys: [.credentials[] | {key: .consumerKey, products: [.apiProducts[] | "\(.apiproduct):\(.status)"]}]}'
fi

# =============================================================================
if $DO_BASELINE; then
  echo "================ Phase: baseline ================"
  deploy_rev Biscuit-Coffee-Shop "$BISCUIT_BASELINE_REV"
  MCP_DIR=$(stage_mcp_dev)
  REV=$(upload_bundle mcp-proxy-dev "$MCP_DIR")
  echo ">> Uploaded mcp-proxy-dev rev $REV"
  deploy_rev mcp-proxy-dev "$REV"
  rm -rf "$(dirname "$MCP_DIR")"
fi

# =============================================================================
if $DO_AUDIT; then
  echo "================ Phase: audit ================"
  BIS_DIR=$(stage_biscuit_dev)
  BREV=$(upload_bundle Biscuit-Coffee-Shop "$BIS_DIR")
  echo ">> Uploaded Biscuit-Coffee-Shop rev $BREV (deployed to $DEV_ENV ONLY)"
  deploy_rev Biscuit-Coffee-Shop "$BREV"
  MCP_DIR=$(stage_mcp_dev)
  MREV=$(upload_bundle mcp-proxy-dev "$MCP_DIR")
  echo ">> Uploaded mcp-proxy-dev rev $MREV"
  deploy_rev mcp-proxy-dev "$MREV"
  rm -rf "$(dirname "$BIS_DIR")" "$(dirname "$MCP_DIR")"
fi

echo "================ Done ($DEV_ENV) ================"
