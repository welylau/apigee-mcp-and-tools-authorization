#!/usr/bin/env python3
"""
HTTP Server and API Proxy for Biscuit Coffee Agent Web UI.
Serves static assets and proxies ADK requests to avoid CORS issues.

Usage:
    python3 server.py [port] [adk_url]
Default port: 3000
Default ADK URL: http://localhost:8000
"""

import http.server
import socketserver
import urllib.request
import urllib.error
import urllib.parse
import sys
import os
import subprocess
import socket
import atexit
import time
import json
import ssl

DIRECTORY = os.path.dirname(os.path.abspath(__file__))

# Load .env file if present
for env_candidate in [os.path.join(DIRECTORY, ".env"), os.path.join(DIRECTORY, "..", ".env")]:
    if os.path.isfile(env_candidate):
        with open(env_candidate, "r") as ef:
            for line in ef:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    v = v.strip().strip('"').strip("'")
                    os.environ.setdefault(k.strip(), v)

# UI variant: one codebase served twice (see customer_staff_split_plan.md).
#   customer (default): guests + customers, Keycloak client biscuit-coffee-agent,
#                       ADK app coffee_agent_prod, port 3000.
#   staff:              store manager + staff only, Keycloak client
#                       biscuit-coffee-staff, ADK app coffee_agent_staff, port 3001.
UI_VARIANT = (os.environ.get("UI_VARIANT") or "customer").strip().lower()
if UI_VARIANT not in ("customer", "staff"):
    print(f"WARNING: unknown UI_VARIANT={UI_VARIANT!r}; using 'customer'.", file=sys.stderr)
    UI_VARIANT = "customer"
IS_STAFF_UI = UI_VARIANT == "staff"
DEFAULT_PORT = 3001 if IS_STAFF_UI else 3000

PORT = int(os.environ.get("PORT", sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PORT))
ADK_BACKEND = os.environ.get("ADK_BACKEND", sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8000")
ADK_APP_NAME = os.environ.get("ADK_APP_NAME") or ("coffee_agent_staff" if IS_STAFF_UI else "coffee_agent_prod")

KEYCLOAK_BASE = os.environ.get("KEYCLOAK_BASE", "https://keycloak.YOUR_KEYCLOAK_IP.nip.io/realms/apigee-demo")
# Never hardcode client secrets. On Cloud Run they are injected from Secret
# Manager (keycloak-client-secret / keycloak-staff-client-secret, see
# scripts/deploy-ui.sh); locally they come from the gitignored repo-root .env.
if IS_STAFF_UI:
    KEYCLOAK_CLIENT_ID = os.environ.get("KEYCLOAK_STAFF_CLIENT_ID") or "biscuit-coffee-staff"
    KEYCLOAK_CLIENT_SECRET = os.environ.get("KEYCLOAK_STAFF_CLIENT_SECRET", "")
    _SECRET_VAR = "KEYCLOAK_STAFF_CLIENT_SECRET"
else:
    KEYCLOAK_CLIENT_ID = os.environ.get("KEYCLOAK_CLIENT_ID", "biscuit-coffee-agent")
    KEYCLOAK_CLIENT_SECRET = os.environ.get("KEYCLOAK_CLIENT_SECRET", "")
    _SECRET_VAR = "KEYCLOAK_CLIENT_SECRET"
if not KEYCLOAK_CLIENT_SECRET:
    print(f"WARNING: {_SECRET_VAR} is not set; Keycloak login/token "
          "exchange will fail until it is provided.", file=sys.stderr)

# Scopes requested by the login pop-up. Role-gated in Keycloak, so asking for
# the manager scope only yields it for users that hold the manager role.
LOGIN_SCOPE = ("openid biscuit_coffee_staff biscuit_coffee_manager" if IS_STAFF_UI
               else "openid biscuit_coffee_customer")

# Cross-links shown when the role gate refuses a user ("please use the other app").
_LOCAL = not os.environ.get("K_SERVICE")
CUSTOMER_APP_URL = os.environ.get("CUSTOMER_APP_URL", "http://localhost:3000" if _LOCAL else "")
STAFF_APP_URL = os.environ.get("STAFF_APP_URL", "http://localhost:3001" if _LOCAL else "")

# Surfaced to the UI via /api/agent-info so the model label is never hardcoded.
MODEL_NAME = os.environ.get("MODEL_NAME", "")
APIGEE_PROD_HOSTNAME = os.environ.get("APIGEE_PROD_HOSTNAME", "")

# Bind to loopback by default so the BFF (which acts with the developer's ADC
# credentials) is not reachable from the LAN. The container image sets
# HOST=0.0.0.0 explicitly because Cloud Run needs it.
BIND_HOST = os.environ.get("HOST", "127.0.0.1")

# Imported after .env is loaded: the module reads its config from os.environ.
import hashlib
import re
import threading
import settings_api

SETTINGS_LOCK = threading.Lock()
SETTINGS_RATE_LIMIT = int(os.environ.get("SETTINGS_RATE_LIMIT", "60"))  # requests / minute / IP
RATE_WINDOWS = {}
PRINCIPAL_CACHE = {}

SSL_CTX = ssl._create_unverified_context()

# Order approval watcher (GET /api/orders/<id>/status). The browser polls this
# every 10 s while an order is PENDING_APPROVAL; the BFF asks Apigee's getOrder
# tool with the caller's own token, so scope and order-ownership policies apply
# exactly as they do for the agent. Unlike Keycloak (nip.io), the Apigee host has
# a real certificate, so TLS is verified here.
ORDER_ID_PATH_RE = re.compile(r"^/api/orders/([A-Za-z0-9_-]{1,64})/status$")
ORDER_STATUS_RATE_LIMIT = int(os.environ.get("ORDER_STATUS_RATE_LIMIT", "60"))  # requests / minute / IP
ORDER_RATE_WINDOWS = {}
APIGEE_SSL_CTX = ssl.create_default_context()
ADK_PROC = None

# ---------------------------------------------------------------------------
# Role gate (server-side). The staff app only admits staff / store managers;
# the customer app refuses them ("please use the Staff app"). Applied on
# oauth exchange / refresh / userinfo, settings, every staff API call and the
# ADK run proxy. Apigee still enforces scopes per operation regardless.
# ---------------------------------------------------------------------------
STAFF_ROLES = ("staff", "manager")


def jwt_claims_unverified(token):
    """Decode a JWT payload WITHOUT verifying it.

    Only used on tokens that either came straight from Keycloak's token
    endpoint or were confirmed active by Keycloak's userinfo endpoint; Apigee
    verifies the signature on every tool call.
    """
    try:
        import base64
        part = (token or "").split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)).decode("utf-8"))
        return claims if isinstance(claims, dict) else {}
    except Exception:
        return {}


def role_flags(claims):
    roles = set((claims.get("realm_access") or {}).get("roles") or [])
    scopes = set((claims.get("scope") or "").split())
    manager = "manager" in roles or "biscuit_coffee_manager" in scopes or "biscuit_coffee_manager" in roles
    staff = manager or "staff" in roles or "biscuit_coffee_staff" in scopes
    return {"staff": staff, "manager": manager}


def variant_gate(claims):
    """True when this user may use this UI variant."""
    flags = role_flags(claims)
    return flags["staff"] if IS_STAFF_UI else not flags["staff"]


def gate_denied_payload():
    if IS_STAFF_UI:
        msg = ("This is the Biscuit Coffee Staff app. Your account does not have the staff or "
               "store manager role. Customers, please use the customer app.")
        other = CUSTOMER_APP_URL
    else:
        msg = ("Staff and store manager accounts can't sign in to the customer app. "
               "Please use the Biscuit Coffee Staff app.")
        other = STAFF_APP_URL
    return {"error": "role_not_allowed", "error_description": msg, "message": msg,
            "variant": UI_VARIANT, "otherAppUrl": other, "active": False}


def revoke_tokens(token_data):
    """Best effort: end the Keycloak session of tokens the gate just refused."""
    refresh = token_data.get("refresh_token") if isinstance(token_data, dict) else None
    access = token_data.get("access_token") if isinstance(token_data, dict) else None
    calls = []
    if refresh:
        calls.append(("logout", {"refresh_token": refresh}))
        calls.append(("revoke", {"token": refresh, "token_type_hint": "refresh_token"}))
    if access:
        calls.append(("revoke", {"token": access, "token_type_hint": "access_token"}))
    for endpoint, fields in calls:
        data = urllib.parse.urlencode(dict(fields, client_id=KEYCLOAK_CLIENT_ID,
                                           client_secret=KEYCLOAK_CLIENT_SECRET)).encode("utf-8")
        try:
            req = urllib.request.Request(f"{KEYCLOAK_BASE}/protocol/openid-connect/{endpoint}", data=data)
            with urllib.request.urlopen(req, context=SSL_CTX, timeout=10):
                pass
        except Exception as e:
            print(f"⚠️ Keycloak {endpoint} after role-gate refusal failed: {type(e).__name__}", flush=True)


# ---------------------------------------------------------------------------
# Staff API (UI_VARIANT=staff only). Each endpoint validates its input and runs
# one MCP tools/call on Apigee with the caller's own token + the staff API key,
# so Apigee (product + scope checks) decides what the caller may do.
# ---------------------------------------------------------------------------
STAFF_RATE_LIMIT = int(os.environ.get("STAFF_RATE_LIMIT", "120"))  # requests / minute / IP
STAFF_RATE_WINDOWS = {}
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
HHMM_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
EMAIL_FILTER_RE = re.compile(r"^[A-Za-z0-9._%+@-]{1,254}$")
DAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
ORDER_STATUS_FILTERS = ("PENDING_APPROVAL", "IN_PROGRESS", "READY", "COMPLETED", "COMPLETE", "REJECTED", "CANCELLED")
ORDER_PROGRESS_STATUSES = ("IN_PROGRESS", "READY", "COMPLETED", "CANCELLED")
MENU_PRICE_MIN, MENU_PRICE_MAX = 0.5, 100.0
TOOLS_CACHE = {"at": 0.0, "schemas": None}
TOOLS_CACHE_TTL = 60

_I = r"([A-Za-z0-9_-]{1,64})"
STAFF_ROUTES = [
    ("GET", re.compile(r"^/api/staff/orders$"), "list_orders"),
    ("GET", re.compile(rf"^/api/staff/orders/{_I}$"), "get_order"),
    ("POST", re.compile(rf"^/api/staff/orders/{_I}/status$"), "order_status"),
    ("POST", re.compile(rf"^/api/staff/orders/{_I}/decision$"), "order_decision"),
    ("GET", re.compile(r"^/api/staff/employees$"), "employees"),
    ("GET", re.compile(rf"^/api/staff/employees/{_I}$"), "employee"),
    ("GET", re.compile(r"^/api/staff/store/hours$"), "hours"),
    ("PUT", re.compile(r"^/api/staff/store/hours$"), "hours_update"),
    ("GET", re.compile(r"^/api/staff/menu$"), "menu"),
    ("PATCH", re.compile(rf"^/api/staff/menu/{_I}$"), "menu_update"),
    ("GET", re.compile(r"^/api/staff/stats$"), "stats"),
]


class InputError(ValueError):
    pass


def _q1(params, name):
    vals = params.get(name) or []
    return vals[0].strip() if vals and isinstance(vals[0], str) else ""


def _clean_text(value, max_len):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise InputError("Text fields must be strings.")
    text = re.sub(r"[\x00-\x1f\x7f]", " ", value).strip()
    if len(text) > max_len:
        raise InputError(f"Text must be at most {max_len} characters.")
    return text


def build_staff_call(action, groups, params, body):
    """Validate input -> (tool, path_params, query, body).

    path_params: list of (value, [candidate argument names]).
    """
    if action == "list_orders":
        query = {}
        status = _q1(params, "status").upper()
        if status:
            if status not in ORDER_STATUS_FILTERS:
                raise InputError("Unknown order status filter.")
            query["status"] = status
        customer = _q1(params, "customer")
        if customer:
            if not EMAIL_FILTER_RE.match(customer):
                raise InputError("Customer filter must be an email address.")
            query["customer"] = customer
        limit = _q1(params, "limit")
        if limit:
            if not limit.isdigit() or not 1 <= int(limit) <= 200:
                raise InputError("limit must be between 1 and 200.")
            query["limit"] = int(limit)
        return "listAllOrders", [], query, None
    if action == "get_order":
        return "getAnyOrder", [(groups[0], ["order_id", "id", "orderId"])], {}, None
    if action == "order_status":
        status = str(body.get("status") or "").upper()
        if status not in ORDER_PROGRESS_STATUSES:
            raise InputError(f"status must be one of {', '.join(ORDER_PROGRESS_STATUSES)}.")
        return "updateOrderStatus", [(groups[0], ["order_id", "id", "orderId"])], {}, {"status": status}
    if action == "order_decision":
        decision = str(body.get("decision") or "").upper()
        if decision not in ("APPROVE", "REJECT"):
            raise InputError("decision must be APPROVE or REJECT.")
        reason = _clean_text(body.get("reason"), 200)
        payload = {"decision": decision}
        if reason:
            payload["reason"] = reason
        return "decideOrder", [(groups[0], ["order_id", "id", "orderId"])], {}, payload
    if action == "employees":
        return "listEmployees", [], {}, None
    if action == "employee":
        return "getEmployee", [(groups[0], ["employee_id", "id", "employeeId"])], {}, None
    if action == "hours":
        return "getHoursOfOperation", [], {}, None
    if action == "hours_update":
        day = str(body.get("day") or "").strip().capitalize()
        if day not in DAYS:
            raise InputError("day must be a weekday name, e.g. Monday.")
        if body.get("closed") is True:
            return "updateStoreHours", [], {}, {"day": day, "closed": True}
        opening, closing = str(body.get("open") or ""), str(body.get("close") or "")
        if not HHMM_RE.match(opening) or not HHMM_RE.match(closing):
            raise InputError("open and close must be HH:MM (24 h).")
        if opening >= closing:
            raise InputError("close must be later than open.")
        return "updateStoreHours", [], {}, {"day": day, "open": opening, "close": closing}
    if action == "menu":
        return "getMenu", [], {}, None
    if action == "menu_update":
        patch = {}
        if "price" in body:
            price = body.get("price")
            if isinstance(price, bool) or not isinstance(price, (int, float)):
                raise InputError("price must be a number.")
            if not MENU_PRICE_MIN <= float(price) <= MENU_PRICE_MAX:
                raise InputError(f"price must be between {MENU_PRICE_MIN:.2f} and {MENU_PRICE_MAX:.2f}.")
            patch["price"] = round(float(price), 2)
        if "available" in body:
            if not isinstance(body.get("available"), bool):
                raise InputError("available must be true or false.")
            patch["available"] = body["available"]
        if "name" in body:
            name = _clean_text(body.get("name"), 60)
            if not name:
                raise InputError("name must not be empty.")
            patch["name"] = name
        if not patch:
            raise InputError("Nothing to update (price, available or name).")
        return "updateMenuItem", [(groups[0], ["item_id", "id", "itemId"])], {}, patch
    if action == "stats":
        days = _q1(params, "days") or "7"
        if not days.isdigit() or not 1 <= int(days) <= 90:
            raise InputError("days must be between 1 and 90.")
        return "getSalesStats", [], {"days": int(days)}, None
    raise InputError("Unknown action.")


def build_tool_args(tool, schema, path_params, query, body):
    """Map logical inputs onto the tool's MCP input schema.

    Apigee's managed MCP server derives tool arguments from the OpenAPI spec:
    path/query params keep their names and a JSON request body is wrapped as
    '<operationId>Body'. The schema from tools/list is consulted when known so
    small naming differences don't break the call.
    """
    props = ((schema or {}).get("properties") or {}) if isinstance(schema, dict) else {}
    args = {}
    for value, candidates in path_params:
        key = next((c for c in candidates if c in props), candidates[0])
        args[key] = value
    args.update(query)
    if body is not None:
        body_key = next((k for k in props if k.lower().endswith("body")), None)
        if body_key:
            args[body_key] = body
        elif props and all(k in props for k in body):
            args.update(body)
        else:
            args[f"{tool}Body"] = body
    return args


def parse_mcp_response(raw):
    """Streamable HTTP may answer as SSE ("data: {...}") or plain JSON."""
    payload = None
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if line.startswith("{"):
            try:
                payload = json.loads(line)
            except ValueError:
                pass
    if payload is None:
        try:
            payload = json.loads(raw)
        except ValueError:
            return None
    return payload if isinstance(payload, dict) else None


def _short(text, limit=300):
    return re.sub(r"\s+", " ", str(text or "")).strip()[:limit]


def classify_tool_error(tool, text, body):
    """-> (http_status, error_code, message) for a failed tools/call."""
    blob = (text or "")[:4000]
    lower = blob.lower()
    msg = ""
    if isinstance(body, dict):
        for k in ("message", "error_description", "detail", "error"):
            if isinstance(body.get(k), str) and body.get(k).strip():
                msg = body[k]
                break
    msg = _short(msg or blob) or "The gateway refused the request."
    if "insufficient_scope" in lower or "required permissions" in lower or "forbidden" in lower \
            or re.search(r"\b403\b", blob):
        return 403, "forbidden", msg
    if "order_not_found" in lower or re.search(r"\b404\b", blob):
        return 404, "not_found", msg
    if re.search(r"\b409\b", blob) or "conflict" in lower or "not pending" in lower:
        return 409, "conflict", msg
    if re.search(r"\b429\b", blob) or "quota" in lower or "rate limit" in lower:
        return 429, "rate_limited", msg
    if re.search(r"\b401\b", blob) or "invalid_token" in lower or "unauthorized" in lower:
        return 401, "unauthorized", msg
    if re.search(r"\b400\b", blob) or re.search(r"\b422\b", blob):
        return 400, "rejected", msg
    return 502, "upstream_error", msg


def tool_unavailable(tool):
    return 501, {"error": "tool_unavailable", "tool": tool,
                 "message": (f"The {tool} tool is not available on the Apigee MCP gateway yet "
                             "(it may still be deploying), or the staff API product does not include it.")}


def mcp_rpc(method, params, auth, timeout=20):
    """-> (payload | None, (status, body) error | None)."""
    rpc = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode("utf-8")
    req = urllib.request.Request(f"https://{APIGEE_PROD_HOSTNAME}/mcp", data=rpc, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json, text/event-stream")
    req.add_header("x-api-key", KEYCLOAK_CLIENT_ID)
    req.add_header("Authorization", auth)
    try:
        with urllib.request.urlopen(req, context=APIGEE_SSL_CTX, timeout=timeout) as resp:
            raw = resp.read(1024 * 1024).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        detail = _short(e.read(4096).decode("utf-8", "replace"), 200)
        status = {401: 401, 403: 403, 404: 404, 429: 429}.get(e.code, 502)
        msgs = {401: "Your session has expired. Please sign in again.",
                403: "Apigee refused this request for your role or API product.",
                429: "Too many requests. Please slow down."}
        return None, (status, {"error": "upstream", "status": e.code,
                               "message": msgs.get(status) or detail or "Gateway error."})
    except Exception:
        return None, (502, {"error": "upstream_unreachable", "message": "The Apigee gateway is unreachable."})
    payload = parse_mcp_response(raw)
    if payload is None:
        return None, (502, {"error": "bad_upstream_body", "message": "Unexpected response from the gateway."})
    return payload, None


def tool_schemas(auth, force=False):
    """name -> inputSchema from tools/list (cached), or None if unknown."""
    now = time.time()
    if not force and TOOLS_CACHE["schemas"] is not None and now - TOOLS_CACHE["at"] < TOOLS_CACHE_TTL:
        return TOOLS_CACHE["schemas"]
    payload, err = mcp_rpc("tools/list", {}, auth)
    if err or "error" in payload:
        return TOOLS_CACHE["schemas"]
    tools = (payload.get("result") or {}).get("tools") or []
    schemas = {t.get("name"): (t.get("inputSchema") or {}) for t in tools if isinstance(t, dict) and t.get("name")}
    TOOLS_CACHE.update(at=now, schemas=schemas)
    return schemas


def call_staff_tool(tool, path_params, query, body, auth):
    """-> (http_status, json_body)."""
    schemas = tool_schemas(auth)
    if schemas is not None and tool not in schemas and time.time() - TOOLS_CACHE["at"] > 10:
        schemas = tool_schemas(auth, force=True)   # newly deployed tools show up quickly
    if schemas is not None and tool not in schemas:
        return tool_unavailable(tool)
    args = build_tool_args(tool, (schemas or {}).get(tool), path_params, query, body)
    payload, err = mcp_rpc("tools/call", {"name": tool, "arguments": args}, auth)
    if err:
        return err
    if "error" in payload:
        e = payload.get("error") or {}
        emsg = str(e.get("message") if isinstance(e, dict) else e)
        code = e.get("code") if isinstance(e, dict) else None
        if code == -32601 or re.search(r"not found|unknown tool|no such tool", emsg, re.I):
            return tool_unavailable(tool)
        status, kind, msg = classify_tool_error(tool, emsg, None)
        return status, {"error": kind, "tool": tool, "message": msg}
    result = payload.get("result") or {}
    text = "\n".join(p["text"] for p in (result.get("content") or [])
                     if isinstance(p, dict) and isinstance(p.get("text"), str))
    try:
        data = json.loads(text) if text else {}
    except ValueError:
        data = None
    if result.get("isError") or (isinstance(data, dict) and isinstance(data.get("error"), str)
                                 and not data.get("status") and not data.get("order_id")):
        if re.search(r"tool .*not found|unknown tool", text or "", re.I):
            return tool_unavailable(tool)
        status, kind, msg = classify_tool_error(tool, text, data)
        return status, {"error": kind, "tool": tool, "message": msg}
    if data is None:
        data = {"text": _short(text, 4000)}
    return 200, {"tool": tool, "data": data}

def is_adk_running(host="127.0.0.1", port=8000):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            return s.connect_ex((host, port)) == 0
    except Exception:
        return False

def ensure_adk_server():
    """Auto-start local ADK web server on port 8000 if not already running."""
    if is_adk_running():
        print("🤖 Local ADK Web server already running on port 8000.")
        return None

    # If ADK_BACKEND is configured to an external endpoint, skip local server start
    if ADK_BACKEND and not ADK_BACKEND.startswith("http://localhost") and not ADK_BACKEND.startswith("http://127.0.0.1"):
        print(f"🔗 Using external ADK Backend at {ADK_BACKEND}")
        return None

    candidates = [
        os.path.abspath(os.path.join(DIRECTORY, "..", "biscuit-coffee", "python", "agents")),
        os.path.abspath(os.path.join(DIRECTORY, "biscuit-coffee", "python", "agents")),
        "/app/biscuit-coffee/python/agents",
        "/app/agents",
        os.path.abspath(os.path.join(DIRECTORY, "agents"))
    ]
    agents_dir = None
    for c in candidates:
        if os.path.isdir(c):
            agents_dir = c
            break

    if not agents_dir:
        print(f"⚠️ Agents directory not found in candidate paths: {candidates}")
        return None

    print(f"🚀 Auto-starting local ADK Web on port 8000 from {agents_dir}...")
    try:
        # Determine executable: prefer project .venv adk or uv run adk, fallback to system adk
        import shutil
        venv_adk = os.path.abspath(os.path.join(DIRECTORY, "..", ".venv", "bin", "adk"))
        if os.path.isfile(venv_adk):
            cmd = [venv_adk, "web", "--host=127.0.0.1", "--port=8000", "--allow_origins=*", "--session_service_uri=memory://", "--artifact_service_uri=memory://", "."]
        elif shutil.which("uv"):
            cmd = ["uv", "run", "adk", "web", "--host=127.0.0.1", "--port=8000", "--allow_origins=*", "--session_service_uri=memory://", "--artifact_service_uri=memory://", "."]
        elif shutil.which("adk"):
            cmd = ["adk", "web", "--host=127.0.0.1", "--port=8000", "--allow_origins=*", "--session_service_uri=memory://", "--artifact_service_uri=memory://", "."]
        else:
            cmd = ["python3", "-m", "google.adk.cli", "web", "--host=127.0.0.1", "--port=8000", "--allow_origins=*", "--session_service_uri=memory://", "--artifact_service_uri=memory://", "."]

        proc = subprocess.Popen(cmd, cwd=agents_dir)
        atexit.register(lambda: proc.terminate())
        for _ in range(16):
            time.sleep(0.5)
            if is_adk_running():
                print("✅ Local ADK Web server is online on port 8000!")
                break
        return proc
    except Exception as e:
        print(f"⚠️ Could not auto-start ADK web: {e}")
        return None

PROXY_PREFIXES = ("/api/", "/list-apps", "/apps/", "/run", "/run_sse", "/health")

class CoffeeShopHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key')
        self.end_headers()

    def do_HEAD(self):
        if any(self.path.startswith(p) for p in PROXY_PREFIXES):
            self.proxy_to_adk("HEAD")
        else:
            super().do_HEAD()

    def end_headers(self):
        # Baseline hardening headers on every response we emit.
        # TODO(security): add a page-wide strict CSP. index.html still carries an
        # inline OAuth-callback <script> and inline styles, so a strict policy
        # needs those moved to files (or hashed) first.
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
        super().end_headers()

    def do_GET(self):
        # Must be checked before PROXY_PREFIXES, otherwise "/api/" forwards it to ADK.
        if self.path.startswith("/api/agent-info"):
            self.handle_agent_info()
            return
        if self.path.startswith("/api/ui-config"):
            self.handle_ui_config()
            return
        if self.path.startswith("/api/oauth/userinfo"):
            self.handle_oauth_userinfo()
            return
        if self.path.startswith("/api/settings/"):
            self.handle_settings()
            return
        if self.path.startswith("/api/staff/"):
            self.handle_staff_api("GET")
            return
        if self.path.startswith("/api/orders/"):
            self.handle_order_status()
            return
        if any(self.path.startswith(p) for p in PROXY_PREFIXES):
            self.proxy_to_adk("GET")
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/oauth/exchange"):
            self.handle_oauth_exchange()
            return
        if self.path.startswith("/api/oauth/refresh"):
            self.handle_oauth_refresh()
            return
        if self.path.startswith("/api/oauth/logout"):
            self.handle_oauth_logout()
            return
        if self.path.startswith("/api/staff/"):
            self.handle_staff_api("POST")
            return
        if any(self.path.startswith(p) for p in PROXY_PREFIXES):
            self.proxy_to_adk("POST")
        else:
            self.send_error(404, "Not Found")

    def do_PUT(self):
        if self.path.startswith("/api/staff/"):
            self.handle_staff_api("PUT")
        else:
            self.send_error(405, "Method Not Allowed")

    def do_PATCH(self):
        if self.path.startswith("/api/staff/"):
            self.handle_staff_api("PATCH")
        else:
            self.send_error(405, "Method Not Allowed")

    def do_DELETE(self):
        if any(self.path.startswith(p) for p in PROXY_PREFIXES):
            self.proxy_to_adk("DELETE")
        else:
            self.send_error(404, "Not Found")

    def handle_ui_config(self):
        """Public, non-secret UI configuration (variant, ADK app, Keycloak client id)."""
        self._send_json(200, {
            "variant": UI_VARIANT,
            "appName": ADK_APP_NAME,
            "guestAllowed": not IS_STAFF_UI,
            "keycloakAuthEndpoint": f"{KEYCLOAK_BASE}/protocol/openid-connect/auth",
            "keycloakClientId": KEYCLOAK_CLIENT_ID,   # client id only, never the secret
            "loginScope": LOGIN_SCOPE,
            "customerAppUrl": CUSTOMER_APP_URL,
            "staffAppUrl": STAFF_APP_URL,
            "gatewayHostname": APIGEE_PROD_HOSTNAME,
        })

    def handle_agent_info(self):
        """Report the live agent runtime configuration so the UI never hardcodes it."""
        model = MODEL_NAME

        # Fallback: read MODEL_NAME straight out of the repo .env if it wasn't exported.
        if not model:
            env_path = os.path.abspath(os.path.join(DIRECTORY, "..", ".env"))
            if os.path.isfile(env_path):
                with open(env_path, "r") as ef:
                    for line in ef:
                        line = line.strip()
                        if line.startswith("MODEL_NAME") and "=" in line:
                            model = line.split("=", 1)[1].strip().strip('"').strip("'")
                            break

        info = {
            "agentName": "biscuit_coffee_staff_agent" if IS_STAFF_UI else "biscuit_coffee_agent",
            "framework": "Google ADK",
            "model": model or "unknown",
            "gatewayEnabled": True,
            "gatewayHostname": APIGEE_PROD_HOSTNAME,
            "adkLive": is_adk_running(),
            "variant": UI_VARIANT,
            "appName": ADK_APP_NAME,
        }

        payload = json.dumps(info).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    # ------------------------------------------------------------------
    # Staff API (staff variant only). Same-origin (no CORS headers).
    # ------------------------------------------------------------------
    def _staff_rate_limited(self):
        ip = self.client_address[0]
        now = time.time()
        with SETTINGS_LOCK:
            window = [t for t in STAFF_RATE_WINDOWS.get(ip, []) if now - t < 60]
            limited = len(window) >= STAFF_RATE_LIMIT
            if not limited:
                window.append(now)
            STAFF_RATE_WINDOWS[ip] = window
        return limited

    def _read_json_body(self, limit=4096):
        try:
            length = int(self.headers.get('Content-Length', 0) or 0)
        except ValueError:
            raise InputError("Bad Content-Length.")
        if length > limit:
            raise InputError("Request body too large.")
        if length <= 0:
            return {}
        try:
            body = json.loads(self.rfile.read(length).decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            raise InputError("Body must be JSON.")
        if not isinstance(body, dict):
            raise InputError("Body must be a JSON object.")
        return body

    def handle_staff_api(self, method):
        if not IS_STAFF_UI:
            self._send_json(404, {'error': 'not_found'})
            return
        parsed = urllib.parse.urlparse(self.path)
        route, groups, path_known = None, (), False
        for m, rx, action in STAFF_ROUTES:
            match = rx.match(parsed.path)
            if match:
                path_known = True
                if m == method:
                    route, groups = action, match.groups()
                    break
        if not route:
            self._send_json(405 if path_known else 404,
                            {'error': 'method_not_allowed' if path_known else 'not_found'})
            return
        if self._staff_rate_limited():
            self._send_json(429, {'error': 'rate_limited', 'message': 'Too many requests, slow down.'})
            return
        principal, err = self._settings_principal()
        if err:
            msg = 'Sign in with a staff account.' if err == 401 else 'Identity provider unavailable.'
            self._send_json(err, {'error': 'unauthorized' if err == 401 else 'idp_unavailable', 'message': msg})
            return
        if not principal['allowed']:
            self._send_json(403, gate_denied_payload())
            return
        if not APIGEE_PROD_HOSTNAME:
            self._send_json(503, {'error': 'gateway_not_configured', 'message': 'APIGEE_PROD_HOSTNAME is not set.'})
            return
        try:
            body = self._read_json_body() if method in ('POST', 'PUT', 'PATCH') else {}
            tool, path_params, query, tool_body = build_staff_call(
                route, groups, urllib.parse.parse_qs(parsed.query), body)
        except InputError as e:
            self._send_json(400, {'error': 'invalid_input', 'message': str(e)})
            return
        try:
            status, out = call_staff_tool(tool, path_params, query, tool_body, self.headers.get('Authorization', ''))
        except Exception as e:
            print(f"🚨 Staff API error on {tool}: {type(e).__name__}: {e}", flush=True)
            status, out = 500, {'error': 'internal', 'message': 'Unexpected error.'}
        if status >= 400:
            print(f"🧾 staff {method} {parsed.path} -> {tool}: {status} {out.get('error')}", flush=True)
        self._send_json(status, out)
    # ------------------------------------------------------------------
    # Settings drawer (BFF). Read-only, same-origin only (no CORS headers).
    # ------------------------------------------------------------------
    def _send_json(self, status, obj):
        payload = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _settings_principal(self):
        """Validate the caller's Keycloak access token server-side.

        Returns (principal, error_status). Fails closed: unlike the legacy
        /api/oauth/userinfo handler there is no "decode the JWT locally"
        fallback when Keycloak is unreachable.
        """
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer ') or len(auth) > 8192:
            return None, 401
        token = auth[7:].strip()
        cache_key = hashlib.sha256(token.encode('utf-8')).hexdigest()
        now = time.time()
        with SETTINGS_LOCK:
            hit = PRINCIPAL_CACHE.get(cache_key)
            if hit and hit['exp'] > now:
                return hit['principal'], None

        req = urllib.request.Request(f"{KEYCLOAK_BASE}/protocol/openid-connect/userinfo")
        req.add_header('Authorization', f'Bearer {token}')
        try:
            # TODO(security): SSL_CTX skips certificate verification (inherited
            # from the existing OAuth handlers, Keycloak runs on a nip.io host).
            # Pin the Keycloak CA before using this outside a demo.
            with urllib.request.urlopen(req, context=SSL_CTX, timeout=10) as resp:
                userinfo = json.loads(resp.read().decode('utf-8') or '{}')
        except urllib.error.HTTPError as e:
            return None, 401 if e.code in (401, 403) else 503
        except Exception:
            return None, 503

        # Token is confirmed active by Keycloak; now read its claims for roles.
        claims = jwt_claims_unverified(token)
        flags = role_flags(claims)
        principal = {
            'sub': userinfo.get('sub'),
            'email': userinfo.get('email') or userinfo.get('preferred_username'),
            'manager': flags['manager'],
            'staff': flags['staff'],
            'allowed': variant_gate(claims),
        }
        with SETTINGS_LOCK:
            if len(PRINCIPAL_CACHE) > 256:
                PRINCIPAL_CACHE.clear()
            PRINCIPAL_CACHE[cache_key] = {'principal': principal, 'exp': min(now + 60, claims.get('exp', now + 60))}
        return principal, None

    def _rate_limited(self):
        """Simple per-IP sliding window: SETTINGS_RATE_LIMIT requests / minute."""
        ip = self.client_address[0]
        now = time.time()
        with SETTINGS_LOCK:
            window = [t for t in RATE_WINDOWS.get(ip, []) if now - t < 60]
            if len(window) >= SETTINGS_RATE_LIMIT:
                RATE_WINDOWS[ip] = window
                return True
            window.append(now)
            RATE_WINDOWS[ip] = window
        return False

    def _order_rate_limited(self):
        """Per-IP sliding window for the order-status poller (own budget)."""
        ip = self.client_address[0]
        now = time.time()
        with SETTINGS_LOCK:
            window = [t for t in ORDER_RATE_WINDOWS.get(ip, []) if now - t < 60]
            limited = len(window) >= ORDER_STATUS_RATE_LIMIT
            if not limited:
                window.append(now)
            ORDER_RATE_WINDOWS[ip] = window
        return limited

    def handle_order_status(self):
        """GET /api/orders/<id>/status -> {order_id, status, decision, total_amount}.

        Asks Apigee's getOrder MCP tool with the caller's own Keycloak token, so
        the gateway's scope, ownership (order_not_found) and audit policies apply.
        Only a few fields are returned; the upstream body is never forwarded.
        """
        match = ORDER_ID_PATH_RE.match(urllib.parse.urlparse(self.path).path)
        if not match:
            self._send_json(404, {'error': 'not_found'})
            return
        order_id = match.group(1)
        if self._order_rate_limited():
            self._send_json(429, {'error': 'rate_limited'})
            return
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer ') or len(auth) > 8192:
            self._send_json(401, {'error': 'unauthorized'})
            return
        if not APIGEE_PROD_HOSTNAME:
            self._send_json(503, {'error': 'gateway_not_configured'})
            return

        rpc = json.dumps({
            'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
            'params': {'name': 'getOrder', 'arguments': {'id': order_id}},
        }).encode('utf-8')
        req = urllib.request.Request(f"https://{APIGEE_PROD_HOSTNAME}/mcp", data=rpc, method='POST')
        req.add_header('Content-Type', 'application/json')
        req.add_header('Accept', 'application/json, text/event-stream')
        req.add_header('x-api-key', KEYCLOAK_CLIENT_ID)
        req.add_header('Authorization', auth)
        try:
            with urllib.request.urlopen(req, context=APIGEE_SSL_CTX, timeout=15) as resp:
                raw = resp.read(256 * 1024).decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            code = {401: 401, 403: 401, 429: 429}.get(e.code, 502)
            self._send_json(code, {'error': 'upstream', 'status': e.code})
            return
        except Exception:
            self._send_json(502, {'error': 'upstream_unreachable'})
            return

        # Streamable HTTP may answer as SSE ("data: {...}") or plain JSON.
        payload = None
        for line in raw.splitlines():
            line = line.strip()
            if line.startswith('data:'):
                line = line[5:].strip()
            if line.startswith('{'):
                try:
                    payload = json.loads(line)
                except ValueError:
                    pass
        if payload is None:
            try:
                payload = json.loads(raw)
            except ValueError:
                self._send_json(502, {'error': 'bad_upstream_body'})
                return

        result = payload.get('result') or {}
        text = ''
        for part in result.get('content') or []:
            if isinstance(part, dict) and isinstance(part.get('text'), str):
                text = part['text']
                break
        try:
            body = json.loads(text) if text else {}
        except ValueError:
            body = {}
        if not isinstance(body, dict):
            body = {}

        if body.get('error') == 'order_not_found':
            self._send_json(404, {'error': 'order_not_found'})
            return
        if 'error' in payload or result.get('isError') or not body.get('status'):
            blob = (text or json.dumps(payload))[:2000]
            forbidden = 'insufficient_scope' in blob or 'required permissions' in blob
            self._send_json(403 if forbidden else 502, {'error': 'forbidden' if forbidden else 'upstream_error'})
            return

        approval = body.get('approval') if isinstance(body.get('approval'), dict) else {}
        total = body.get('total_amount')
        status = str(body.get('status'))[:32]
        # The staff's rejection reason is shown to the customer. It is free text
        # typed in the Staff app, so only plain characters are passed on: control
        # and markdown/HTML characters are removed and the length is capped.
        reason = None
        if status == 'REJECTED' and isinstance(approval.get('reason'), str):
            reason = re.sub(r"[\x00-\x1f\x7f<>\[\]()*_`\\]", " ", approval['reason'])
            reason = re.sub(r"\s+", " ", reason).strip()[:200] or None
        self._send_json(200, {
            'order_id': order_id,
            'status': status,
            'decision': str(approval.get('decision'))[:16] if approval.get('decision') else None,
            'total_amount': total if isinstance(total, (int, float)) else None,
            'reason': reason,
        })

    def handle_settings(self):
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        if route not in ('/api/settings/hosting', '/api/settings/logs'):
            self._send_json(404, {'error': 'not_found'})
            return
        if self._rate_limited():
            self._send_json(429, {'error': 'rate_limited', 'message': 'Too many requests, slow down.'})
            return
        principal, err = self._settings_principal()
        if err:
            msg = 'Sign in to view settings.' if err == 401 else 'Identity provider unavailable.'
            self._send_json(err, {'error': 'unauthorized' if err == 401 else 'idp_unavailable', 'message': msg})
            return
        if not principal['allowed']:
            self._send_json(403, gate_denied_payload())
            return
        params = urllib.parse.parse_qs(parsed.query)

        try:
            if route == '/api/settings/hosting':
                host_hdr = self.headers.get('Host', '')
                proto = 'https' if (self.headers.get('X-Forwarded-Proto', '').lower() == 'https'
                                    or os.environ.get('K_SERVICE')) else 'http'
                # Only echo the Host header back if it looks like host[:port].
                local_url = f"{proto}://{host_hdr}" if re.fullmatch(r'[A-Za-z0-9.\-]+(:\d{1,5})?', host_hdr or '') \
                    else f"http://localhost:{PORT}"
                runtime = {
                    'localUrl': local_url,
                    'bindHost': BIND_HOST,
                    'port': PORT,
                    'adkBackend': ADK_BACKEND,
                    'adkLive': is_adk_running(),
                    'adkDevUi': f"{ADK_BACKEND.rstrip('/')}/dev-ui",
                    'model': MODEL_NAME or 'unknown',
                    'gatewayHostname': APIGEE_PROD_HOSTNAME,
                    'keycloakBase': KEYCLOAK_BASE,
                    'keycloakClientId': KEYCLOAK_CLIENT_ID,   # client id only, never the secret
                    'pythonVersion': sys.version.split()[0],
                    'container': os.path.exists('/.dockerenv') or bool(os.environ.get('K_SERVICE')),
                    'cloudRunService': os.environ.get('K_SERVICE', ''),
                    'cloudRunRevision': os.environ.get('K_REVISION', ''),
                }
                refresh = (params.get('refresh') or ['0'])[0] == '1'
                data = settings_api.hosting_info(runtime, refresh=refresh)
                data['viewer'] = {'manager': principal['manager']}
                self._send_json(200, data)
            else:
                if not principal['manager']:
                    self._send_json(403, {'error': 'forbidden',
                                          'message': 'Audit logs are restricted to the store manager role.'})
                    return
                self._send_json(200, settings_api.audit_logs(params))
        except settings_api.UpstreamError as e:
            self._send_json(502, {'error': 'upstream', 'message': str(e)})
        except Exception as e:
            print(f"🚨 Settings handler error: {type(e).__name__}: {e}", flush=True)
            self._send_json(500, {'error': 'internal', 'message': 'Unexpected error.'})

    def handle_oauth_exchange(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(content_length).decode('utf-8')) if content_length > 0 else {}
        code = body.get('code')
        redirect_uri = body.get('redirect_uri', f'http://localhost:{PORT}/')

        data = urllib.parse.urlencode({
            'grant_type': 'authorization_code',
            'client_id': KEYCLOAK_CLIENT_ID,
            'client_secret': KEYCLOAK_CLIENT_SECRET,
            'code': code,
            'redirect_uri': redirect_uri
        }).encode('utf-8')

        req = urllib.request.Request(f"{KEYCLOAK_BASE}/protocol/openid-connect/token", data=data)
        try:
            with urllib.request.urlopen(req, context=SSL_CTX, timeout=10) as resp:
                token_data = resp.read()
            self._send_gated_tokens(token_data, 'sign-in')
        except urllib.error.HTTPError as e:
            err = e.read()
            # Log upstream response: a non-4xx here (e.g. 403 from an egress
            # proxy) means the request never reached Keycloak at all.
            print(f"🚨 Keycloak token exchange failed: HTTP {e.code} from "
                  f"{KEYCLOAK_BASE}/protocol/openid-connect/token -> "
                  f"{err.decode('utf-8', errors='replace')}", flush=True)
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(err)
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))

    def handle_oauth_refresh(self):
        """Exchange a refresh token for a new access token.

        Keycloak issues 5 minute access tokens (realm default), so without this
        the UI silently drops to logged-out mid-demo. Kept server-side because
        the grant needs the confidential client secret, which must never be
        handed to the browser.
        """
        content_length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(content_length).decode('utf-8')) if content_length > 0 else {}
        refresh_token = body.get('refresh_token')

        if not refresh_token:
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'missing refresh_token'}).encode('utf-8'))
            return

        data = urllib.parse.urlencode({
            'grant_type': 'refresh_token',
            'client_id': KEYCLOAK_CLIENT_ID,
            'client_secret': KEYCLOAK_CLIENT_SECRET,
            'refresh_token': refresh_token
        }).encode('utf-8')

        req = urllib.request.Request(f"{KEYCLOAK_BASE}/protocol/openid-connect/token", data=data)
        try:
            with urllib.request.urlopen(req, context=SSL_CTX, timeout=10) as resp:
                token_data = resp.read()
            self._send_gated_tokens(token_data, 'refresh')
        except urllib.error.HTTPError as e:
            err = e.read()
            # A 400 invalid_grant here is normal and expected: the refresh token
            # itself has expired (30 min idle) or the session was revoked. The
            # client treats that as a genuine logout.
            print(f"🔄 Keycloak token refresh rejected: HTTP {e.code} -> "
                  f"{err.decode('utf-8', errors='replace')}", flush=True)
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(err)
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))

    def _send_gated_tokens(self, token_data, kind):
        """Forward a Keycloak token response only if the user passes the role gate.

        Refused tokens are revoked right away so they cannot be reused.
        """
        try:
            tokens = json.loads(token_data.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            tokens = {}
        if not isinstance(tokens, dict):
            tokens = {}
        claims = jwt_claims_unverified(tokens.get('access_token', ''))
        if not claims or not variant_gate(claims):
            who = str(claims.get('preferred_username') or claims.get('email') or 'unknown')[:80]
            print(f"🚫 Role gate ({UI_VARIANT} UI) refused {kind} for {who}", flush=True)
            revoke_tokens(tokens)
            self._send_json(403, gate_denied_payload())
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(token_data)

    def _send_userinfo(self, info_obj, auth_header):
        """200 with userinfo, or 403 role_not_allowed when the gate refuses."""
        claims = jwt_claims_unverified(auth_header.replace('Bearer ', '').strip())
        if not variant_gate(claims):
            self._send_json(403, gate_denied_payload())
            return
        payload = json.dumps(info_obj).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def handle_oauth_userinfo(self):
        auth_header = self.headers.get('Authorization', '')
        if not auth_header:
            self.send_response(401)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(b'{"active": false, "error": "missing_authorization_header"}')
            return

        def parse_jwt_userinfo(raw_header):
            try:
                import base64
                token = raw_header.replace('Bearer ', '').strip()
                parts = token.split('.')
                if len(parts) >= 2:
                    b64 = parts[1] + '=' * (-len(parts[1]) % 4)
                    payload = json.loads(base64.urlsafe_b64decode(b64.encode('utf-8')).decode('utf-8'))
                    email = payload.get('email') or payload.get('preferred_username') or 'customer@biscuit-coffee.com'
                    name = payload.get('name') or payload.get('preferred_username') or email
                    if 'manager' in email and name == email:
                        name = 'Alice (Manager)'
                    elif 'customer' in email and name == email:
                        name = 'John Smith'
                    return {
                        'sub': payload.get('sub'),
                        'email': email,
                        'preferred_username': payload.get('preferred_username', email),
                        'name': name,
                        'scope': payload.get('scope', ''),
                        'realm_access': payload.get('realm_access', {}),
                        'active': True
                    }
            except Exception:
                pass
            return None

        req = urllib.request.Request(f"{KEYCLOAK_BASE}/protocol/openid-connect/userinfo")
        req.add_header('Authorization', auth_header)
        try:
            with urllib.request.urlopen(req, context=SSL_CTX, timeout=10) as resp:
                userinfo = json.loads(resp.read().decode('utf-8') or '{}')
            self._send_userinfo(userinfo, auth_header)
            return
        except urllib.error.HTTPError as e:
            if e.code != 401:
                jwt_info = parse_jwt_userinfo(auth_header)
                if jwt_info:
                    self._send_userinfo(jwt_info, auth_header)
                    return
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(b'{"active": false, "error": "invalid_or_expired_token"}')
        except Exception as e:
            jwt_info = parse_jwt_userinfo(auth_header)
            if jwt_info:
                self._send_userinfo(jwt_info, auth_header)
                return
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))

    def handle_oauth_logout(self):
        global ADK_PROC
        content_length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(content_length).decode('utf-8')) if content_length > 0 else {}
        refresh_token = body.get('refresh_token')

        if refresh_token:
            data = urllib.parse.urlencode({
                'client_id': KEYCLOAK_CLIENT_ID,
                'client_secret': KEYCLOAK_CLIENT_SECRET,
                'refresh_token': refresh_token
            }).encode('utf-8')
            req = urllib.request.Request(f"{KEYCLOAK_BASE}/protocol/openid-connect/logout", data=data)
            try:
                with urllib.request.urlopen(req, context=SSL_CTX, timeout=10) as resp:
                    pass
            except Exception as e:
                print("Keycloak logout warning:", e)

        # Flush in-memory sessions & credentials by restarting local ADK server if active
        if ADK_PROC:
            try:
                print("🧹 Flushing ADK server in-memory session/credential cache...")
                ADK_PROC.terminate()
                ADK_PROC.wait(timeout=2)
            except Exception:
                try:
                    ADK_PROC.kill()
                except Exception:
                    pass
            ADK_PROC = ensure_adk_server()

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(b'{"success": true}')

    def _adk_refusal(self, target_path, method, body):
        """-> (status, json) when an ADK request must not be forwarded, else None.

        Each UI variant may only talk to its own agent, and tokens handed to the
        agent in a run payload must pass the same role gate as a sign-in.
        """
        m = re.match(r"^/apps/([^/?]+)", target_path)
        if m and urllib.parse.unquote(m.group(1)) != ADK_APP_NAME:
            return 403, {'error': 'wrong_agent', 'message': f'This UI only serves {ADK_APP_NAME}.'}
        if method == 'POST' and re.match(r"^/run(_sse)?(\?|$)", target_path):
            try:
                payload = json.loads(body.decode('utf-8')) if body else {}
            except (ValueError, UnicodeDecodeError):
                return 400, {'error': 'bad_request', 'message': 'Run payload must be JSON.'}
            if not isinstance(payload, dict):
                return 400, {'error': 'bad_request', 'message': 'Run payload must be a JSON object.'}
            if payload.get('appName') != ADK_APP_NAME:
                return 403, {'error': 'wrong_agent', 'message': f'This UI only serves {ADK_APP_NAME}.'}
            delta = payload.get('state_delta') or payload.get('stateDelta')
            if isinstance(delta, dict):
                token = delta.get('access_token') or ''
                if token and not variant_gate(jwt_claims_unverified(token)):
                    return 403, gate_denied_payload()
                if IS_STAFF_UI and not token:
                    return 401, {'error': 'unauthorized', 'message': 'Sign in with a staff account to chat.'}
        return None

    def proxy_to_adk(self, method):
        target_path = self.path
        if target_path.startswith("/api/"):
            target_path = "/" + target_path[5:]

        target_url = f"{ADK_BACKEND.rstrip('/')}{target_path}"

        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length > 0 else None

        refusal = self._adk_refusal(target_path, method, body)
        if refusal:
            self._send_json(*refusal)
            return

        req = urllib.request.Request(target_url, data=body, method=method)
        for key, val in self.headers.items():
            if key.lower() not in ('host', 'content-length'):
                req.add_header(key, val)

        if target_path.startswith("/run_sse") and method == "POST":
            return self._stream_from_adk(req, target_path)

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                self.send_response(resp.status)
                for header, val in resp.getheaders():
                    if header.lower() not in ('transfer-encoding', 'content-length', 'access-control-allow-origin'):
                        self.send_header(header, val)
                self.send_header('Access-Control-Allow-Origin', '*')
                content = resp.read()
                self.send_header('Content-Length', str(len(content)))
                self.end_headers()
                self.wfile.write(content)
        except urllib.error.HTTPError as e:
            content = e.read()
            print(f"🚨 ADK Proxy HTTPError {e.code} on {method} {target_path}: {content.decode('utf-8', errors='replace')}", flush=True)
            self.send_response(e.code)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            self.send_response(502)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Type', 'application/json')
            err_msg = f'{{"error": "ADK backend unreachable at {ADK_BACKEND}", "details": "{str(e)}"}}'.encode('utf-8')
            self.send_header('Content-Length', str(len(err_msg)))
            self.end_headers()
            self.wfile.write(err_msg)

    def _stream_from_adk(self, req, target_path):
        """Relay ADK's Server-Sent Events as they arrive (no buffering), so the
        browser can render the reply while Gemini is still generating it."""
        try:
            resp = urllib.request.urlopen(req, timeout=120)
        except urllib.error.HTTPError as e:
            content = e.read()
            print(f"🚨 ADK Proxy HTTPError {e.code} on POST {target_path}: {content.decode('utf-8', errors='replace')}", flush=True)
            self.send_response(e.code)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return
        except Exception as e:
            err_msg = json.dumps({"error": f"ADK backend unreachable at {ADK_BACKEND}", "details": str(e)}).encode('utf-8')
            self.send_response(502)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(err_msg)))
            self.end_headers()
            self.wfile.write(err_msg)
            return

        with resp:
            self.send_response(resp.status)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('X-Accel-Buffering', 'no')
            self.send_header('Access-Control-Allow-Origin', '*')
            # No Content-Length: the body ends when the connection closes.
            self.send_header('Connection', 'close')
            self.end_headers()
            self.close_connection = True
            try:
                while True:
                    chunk = resp.read1(8192)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass  # browser went away mid-stream

if __name__ == '__main__':
    ADK_PROC = ensure_adk_server()
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.daemon_threads = True
    with socketserver.ThreadingTCPServer((BIND_HOST, PORT), CoffeeShopHandler) as httpd:
        print(f"============================================================")
        print(f"☕ Biscuit Coffee Agent Web UI is LIVE! (variant: {UI_VARIANT})")
        print(f"👉 Local URL: http://localhost:{PORT}  (bound to {BIND_HOST})")
        print(f"👉 Reverse Proxy Target: {ADK_BACKEND}  (agent: {ADK_APP_NAME}, Keycloak client: {KEYCLOAK_CLIENT_ID})")
        print(f"============================================================")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping server...")
            if ADK_PROC:
                try:
                    ADK_PROC.terminate()
                except Exception:
                    pass
            httpd.shutdown()
