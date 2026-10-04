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
SETTINGS_RATE_LIMIT = int(os.environ.get("SETTINGS_RATE_LIMIT", "60"))  # requests / minute / user
PRINCIPAL_CACHE = {}

SSL_CTX = ssl._create_unverified_context()

# Order approval watcher (GET /api/orders/<id>/status). The browser polls this
# every 10 s while an order is PENDING_APPROVAL; the BFF asks Apigee's getOrder
# tool with the caller's own token, so scope and order-ownership policies apply
# exactly as they do for the agent. Unlike Keycloak (nip.io), the Apigee host has
# a real certificate, so TLS is verified here.
ORDER_ID_PATH_RE = re.compile(r"^/api/orders/([A-Za-z0-9_-]{1,64})/status$")
ORDER_STATUS_RATE_LIMIT = int(os.environ.get("ORDER_STATUS_RATE_LIMIT", "60"))  # requests / minute / user
APIGEE_SSL_CTX = ssl.create_default_context()
ADK_PROC = None

# ---------------------------------------------------------------------------
# Rate limiting. Buckets are keyed on the verified Keycloak subject once the
# caller is authenticated ("sub:<id>"); anonymous traffic (guests, failed
# auth) is keyed on the left-most X-Forwarded-For entry (the client as seen by
# Cloud Run's front end) or the socket address locally. Stale keys are pruned.
# ---------------------------------------------------------------------------
ADK_RATE_LIMIT = int(os.environ.get("ADK_RATE_LIMIT", "120"))            # ADK calls / minute / caller
AUTH_FAIL_RATE_LIMIT = int(os.environ.get("AUTH_FAIL_RATE_LIMIT", "30"))  # failed auths / minute / client
OAUTH_RATE_LIMIT = int(os.environ.get("OAUTH_RATE_LIMIT", "30"))          # oauth calls / minute / client
RATE_BUCKETS = {}
_RATE_PRUNED_AT = [0.0]


def rate_limited(bucket, key, limit, window=60, count=True):
    """Sliding window limiter. True when `key` has used up `limit` in `window` s.

    count=False only checks the budget without recording a hit.
    """
    now = time.time()
    with SETTINGS_LOCK:
        if now - _RATE_PRUNED_AT[0] > window:
            for keys in RATE_BUCKETS.values():
                for k in [k for k, hits in keys.items() if not hits or now - hits[-1] >= window]:
                    del keys[k]
            _RATE_PRUNED_AT[0] = now
        keys = RATE_BUCKETS.setdefault(bucket, {})
        hits = [t for t in keys.get(key, ()) if now - t < window]
        limited = len(hits) >= limit
        if not limited and count:
            hits.append(now)
        keys[key] = hits
    return limited


# ---------------------------------------------------------------------------
# Request path handling. Every request path is decoded and normalised once,
# before routing, so encoded variants (/run%5Fsse, /apps/%2e%2e/...) can't slip
# past the route checks and reach ADK in a form the checks never saw.
# ---------------------------------------------------------------------------
_BAD_ENCODED_RE = re.compile(r"%(2[fF]|5[cC]|00|25)")
# The UI only ever percent-encodes '@' and '+' (encodeURIComponent on email
# user ids). Any other escape (e.g. /run%5Fsse) is refused, not decoded.
_PCT_RE = re.compile(r"%(?!40|2[bB])")


def normalize_request_path(raw):
    """-> (decoded_path, query) or None when the path must be refused."""
    if not raw or len(raw) > 4096 or not raw.startswith("/"):
        return None
    path, _, query = raw.split("#", 1)[0].partition("?")
    if _BAD_ENCODED_RE.search(path) or _PCT_RE.search(path):
        return None   # encoded slash, backslash, NUL, double-encoding, other escapes
    try:
        decoded = urllib.parse.unquote(path, errors="strict")
    except UnicodeDecodeError:
        return None
    if re.search(r"[\x00-\x1f\x7f\\?#]", decoded):
        return None
    segs = [s for s in decoded.split("/") if s]
    if any(s in (".", "..") for s in segs):
        return None
    norm = "/" + "/".join(segs)
    if decoded.endswith("/") and segs:
        norm += "/"
    return norm, query


# Exact ADK routes the UI needs. Everything else (session GET/list/PATCH,
# artifacts, eval, debug/trace, builder, ...) is refused with 404.
SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
GUEST_ID_RE = re.compile(r"^guest-[A-Za-z0-9]{16,64}$")


def match_adk_route(method, path):
    """-> (kind, params) for an allowed ADK call, else None. `path` is normalised."""
    if path.startswith("/api/"):
        path = path[4:]
    if path.endswith("/"):
        return None
    segs = path.strip("/").split("/")
    if segs == ["list-apps"]:
        return ("list_apps", {}) if method == "GET" else None
    if segs == ["run"] or segs == ["run_sse"]:
        return (segs[0], {}) if method == "POST" else None
    if len(segs) in (5, 6) and segs[0] == "apps" and segs[2] == "users" and segs[4] == "sessions":
        params = {"app": segs[1], "uid": segs[3]}
        if len(segs) == 5 and method == "POST":
            return "create_session", params
        if len(segs) == 6 and method == "DELETE":
            params["sid"] = segs[5]
            return "delete_session", params
    return None


# Static files. Only the UI's own assets are served; source files, .env,
# agents/ etc. under the web-ui directory are never exposed.
STATIC_RE = re.compile(
    r"^/(index\.html)?$"
    r"|^/css/[A-Za-z0-9_.-]+\.css$"
    r"|^/js/([A-Za-z0-9_-]+/)?[A-Za-z0-9_.-]+\.js$"
    r"|^/assets/[A-Za-z0-9_.-]+\.(png|svg|jpg|jpeg|webp|ico)$")

_kc = urllib.parse.urlsplit(KEYCLOAK_BASE)
KEYCLOAK_ORIGIN = f"{_kc.scheme}://{_kc.netloc}" if _kc.scheme in ("http", "https") and _kc.netloc else ""
# Inline style attributes are still used by index.html and some JS templates,
# hence style-src 'unsafe-inline'; scripts are strictly same-origin files.
PAGE_CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://www.gstatic.com",
    f"connect-src 'self' {KEYCLOAK_ORIGIN}".strip(),
    "object-src 'none'",
    "base-uri 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    f"form-action 'self' {KEYCLOAK_ORIGIN}".strip(),
])

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
STAFF_RATE_LIMIT = int(os.environ.get("STAFF_RATE_LIMIT", "120"))  # requests / minute / user
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


def _expected_status(body):
    """Optional optimistic-concurrency hint: the status the UI saw ('from')."""
    raw = body.get("expected_status")
    if raw in (None, ""):
        return ""
    expected = str(raw).upper()
    if expected not in ORDER_STATUS_FILTERS:
        raise InputError("expected_status is not a known order status.")
    return expected


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
        payload = {"status": status}
        expected = _expected_status(body)
        if expected:
            payload["expected_status"] = expected
        return "updateOrderStatus", [(groups[0], ["order_id", "id", "orderId"])], {}, payload
    if action == "order_decision":
        decision = str(body.get("decision") or "").upper()
        if decision not in ("APPROVE", "REJECT"):
            raise InputError("decision must be APPROVE or REJECT.")
        reason = _clean_text(body.get("reason"), 200)
        payload = {"decision": decision}
        if reason:
            payload["reason"] = reason
        expected = _expected_status(body)
        if expected:
            payload["expected_status"] = expected
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
        if "expected_status" in body:
            # Optimistic-concurrency hint. Only sent when the gateway's tool
            # schema declares it; a strict MCP input schema would otherwise
            # reject the whole call.
            body_props = ((props.get(body_key) or {}).get("properties") or {}) if body_key else props
            if "expected_status" not in body_props:
                body = {k: v for k, v in body.items() if k != "expected_status"}
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

def _adk_command():
    """ADK launch command: the headless API server only (no Dev UI / builder)."""
    import shutil
    args = ["api_server", "--host=127.0.0.1", "--port=8000", "--no-reload",
            "--session_service_uri=memory://", "--artifact_service_uri=memory://", "."]
    venv_adk = os.path.abspath(os.path.join(DIRECTORY, "..", ".venv", "bin", "adk"))
    if os.path.isfile(venv_adk):
        return [venv_adk] + args
    if shutil.which("uv"):
        return ["uv", "run", "adk"] + args
    if shutil.which("adk"):
        return ["adk"] + args
    return ["python3", "-m", "google.adk.cli"] + args


def ensure_adk_server():
    """Auto-start the local ADK API server on 127.0.0.1:8000 if not already running."""
    if is_adk_running():
        print("🤖 Local ADK server already running on port 8000.")
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

    print(f"🚀 Auto-starting local ADK API server on 127.0.0.1:8000 from {agents_dir}...")
    try:
        proc = subprocess.Popen(_adk_command(), cwd=agents_dir)
        atexit.register(lambda: proc.terminate())
        for _ in range(30):
            time.sleep(0.5)
            if is_adk_running():
                print("✅ Local ADK API server is online on port 8000!")
                break
        return proc
    except Exception as e:
        print(f"⚠️ Could not auto-start ADK api_server: {e}")
        return None


PKCE_VERIFIER_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")
ADK_RUN_BODY_LIMIT = 256 * 1024


def _q(segment):
    return urllib.parse.quote(segment, safe="")


def _pick(d, *names):
    for n in names:
        if n in d:
            return d[n]
    return None


class CoffeeShopHandler(http.server.SimpleHTTPRequestHandler):
    server_version = "BiscuitCoffeeBFF"
    sys_version = ""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    # ------------------------------------------------------------------
    # Response headers. Every response gets the baseline hardening headers;
    # anything that did not set its own CSP gets the page CSP.
    # ------------------------------------------------------------------
    def send_response(self, code, message=None):
        self._csp_set = False
        super().send_response(code, message)

    def send_header(self, keyword, value):
        if keyword.lower() == 'content-security-policy':
            self._csp_set = True
        super().send_header(keyword, value)

    def end_headers(self):
        if not getattr(self, '_csp_set', False):
            self.send_header('Content-Security-Policy', PAGE_CSP)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
        self._csp_set = False
        super().end_headers()

    # ------------------------------------------------------------------
    # Routing. The path is decoded + normalised once, then matched exactly.
    # ------------------------------------------------------------------
    def do_GET(self):
        self._dispatch('GET')

    def do_HEAD(self):
        self._dispatch('HEAD')

    def do_POST(self):
        self._dispatch('POST')

    def do_PUT(self):
        self._dispatch('PUT')

    def do_PATCH(self):
        self._dispatch('PATCH')

    def do_DELETE(self):
        self._dispatch('DELETE')

    def do_OPTIONS(self):
        # Same-origin app: no CORS preflight is ever needed.
        self._dispatch('OPTIONS')

    def _dispatch(self, method):
        norm = normalize_request_path(self.path)
        if norm is None:
            self._send_json(400, {'error': 'bad_path', 'message': 'Malformed request path.'})
            return
        path, query = norm
        self.path = path + ('?' + query if query else '')
        self.route_path, self.route_query = path, query

        if path.startswith('/api/staff/'):
            self.handle_staff_api(method)
            return
        if method == 'GET':
            simple = {
                '/api/agent-info': self.handle_agent_info,
                '/api/ui-config': self.handle_ui_config,
                '/api/oauth/userinfo': self.handle_oauth_userinfo,
            }.get(path)
            if simple:
                simple()
                return
            if path.startswith('/api/settings/'):
                self.handle_settings()
                return
            if path.startswith('/api/orders/'):
                self.handle_order_status()
                return
        if method == 'POST':
            oauth = {
                '/api/oauth/exchange': self.handle_oauth_exchange,
                '/api/oauth/refresh': self.handle_oauth_refresh,
                '/api/oauth/logout': self.handle_oauth_logout,
            }.get(path)
            if oauth:
                oauth()
                return
        route = match_adk_route(method, path)
        if route:
            self.proxy_to_adk(*route)
            return
        if method in ('GET', 'HEAD') and STATIC_RE.match(path):
            super().do_GET() if method == 'GET' else super().do_HEAD()
            return
        self._send_json(404, {'error': 'not_found'})

    def _client_key(self):
        """Anonymous rate-limit key: left-most X-Forwarded-For, else socket IP."""
        xff = (self.headers.get('X-Forwarded-For') or '').split(',')[0].strip()
        if xff and re.fullmatch(r'[0-9A-Fa-f:.]{2,45}', xff):
            return 'ip:' + xff
        return 'ip:' + self.client_address[0]

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

        self._send_json(200, {
            "agentName": "biscuit_coffee_staff_agent" if IS_STAFF_UI else "biscuit_coffee_agent",
            "framework": "Google ADK",
            "model": model or "unknown",
            "gatewayEnabled": True,
            "gatewayHostname": APIGEE_PROD_HOSTNAME,
            "adkLive": is_adk_running(),
            "variant": UI_VARIANT,
            "appName": ADK_APP_NAME,
        })

    # ------------------------------------------------------------------
    # Authentication + per-identity rate limiting for BFF APIs.
    # ------------------------------------------------------------------
    def _require_principal(self, bucket, limit, unauth_msg):
        """Authenticate, apply the role gate, then rate-limit on the verified
        subject. Returns the principal, or None after sending the error."""
        client = self._client_key()
        if rate_limited('auth_fail', client, AUTH_FAIL_RATE_LIMIT, count=False):
            self._send_json(429, {'error': 'rate_limited', 'message': 'Too many failed sign-ins, slow down.'})
            return None
        principal, err = self._settings_principal()
        if err:
            if err == 401:
                rate_limited('auth_fail', client, AUTH_FAIL_RATE_LIMIT)
            msg = unauth_msg if err == 401 else 'Identity provider unavailable.'
            self._send_json(err, {'error': 'unauthorized' if err == 401 else 'idp_unavailable', 'message': msg})
            return None
        if not principal['allowed']:
            self._send_json(403, gate_denied_payload())
            return None
        subject = principal.get('sub') or principal.get('email') or 'unknown'
        if rate_limited(bucket, f'sub:{subject}', limit):
            self._send_json(429, {'error': 'rate_limited', 'message': 'Too many requests, slow down.'})
            return None
        return principal

    # ------------------------------------------------------------------
    # Staff API (staff variant only). Same-origin (no CORS headers).
    # ------------------------------------------------------------------
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
        path = self.route_path
        route, groups, path_known = None, (), False
        for m, rx, action in STAFF_ROUTES:
            match = rx.match(path)
            if match:
                path_known = True
                if m == method:
                    route, groups = action, match.groups()
                    break
        if not route:
            self._send_json(405 if path_known else 404,
                            {'error': 'method_not_allowed' if path_known else 'not_found'})
            return
        principal = self._require_principal('staff', STAFF_RATE_LIMIT, 'Sign in with a staff account.')
        if not principal:
            return
        if not APIGEE_PROD_HOSTNAME:
            self._send_json(503, {'error': 'gateway_not_configured', 'message': 'APIGEE_PROD_HOSTNAME is not set.'})
            return
        try:
            body = self._read_json_body() if method in ('POST', 'PUT', 'PATCH') else {}
            tool, path_params, query, tool_body = build_staff_call(
                route, groups, urllib.parse.parse_qs(self.route_query), body)
        except InputError as e:
            self._send_json(400, {'error': 'invalid_input', 'message': str(e)})
            return
        try:
            status, out = call_staff_tool(tool, path_params, query, tool_body, self.headers.get('Authorization', ''))
        except Exception as e:
            print(f"🚨 Staff API error on {tool}: {type(e).__name__}: {e}", flush=True)
            status, out = 500, {'error': 'internal', 'message': 'Unexpected error.'}
        if status >= 400:
            print(f"🧾 staff {method} {path} -> {tool}: {status} {out.get('error')}", flush=True)
        self._send_json(status, out)

    # ------------------------------------------------------------------
    # JSON helpers
    # ------------------------------------------------------------------
    def _send_json(self, status, obj):
        payload = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(payload)

    def _send_raw(self, status, content, content_type='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', content_type or 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _settings_principal(self):
        """Validate the caller's Keycloak access token server-side.

        Returns (principal, error_status). Fails closed: there is no "decode
        the JWT locally" fallback when Keycloak is unreachable.
        """
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer ') or len(auth) > 8192:
            return None, 401
        token = auth[7:].strip()
        if not token:
            return None, 401
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
        if not isinstance(userinfo, dict):
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
            'scope': str(claims.get('scope') or ''),
            'userinfo': userinfo,
        }
        with SETTINGS_LOCK:
            if len(PRINCIPAL_CACHE) > 256:
                PRINCIPAL_CACHE.clear()
            PRINCIPAL_CACHE[cache_key] = {'principal': principal, 'exp': min(now + 60, claims.get('exp', now + 60))}
        return principal, None

    # ------------------------------------------------------------------
    # Order approval watcher
    # ------------------------------------------------------------------
    def handle_order_status(self):
        """GET /api/orders/<id>/status -> {order_id, status, decision, total_amount, reason}.

        Asks Apigee's getOrder MCP tool with the caller's own Keycloak token, so
        the gateway's scope, ownership (order_not_found) and audit policies apply.
        Only a few fields are returned; the upstream body is never forwarded.
        """
        match = ORDER_ID_PATH_RE.match(self.route_path)
        if not match:
            self._send_json(404, {'error': 'not_found'})
            return
        order_id = match.group(1)
        principal = self._require_principal('order_status', ORDER_STATUS_RATE_LIMIT, 'Sign in to track your order.')
        if not principal:
            return
        if not APIGEE_PROD_HOSTNAME:
            self._send_json(503, {'error': 'gateway_not_configured'})
            return

        payload, err = mcp_rpc('tools/call', {'name': 'getOrder', 'arguments': {'id': order_id}},
                               self.headers.get('Authorization', ''), timeout=15)
        if err:
            upstream = err[1].get('status') if isinstance(err[1], dict) else None
            code = {401: 401, 403: 401, 429: 429}.get(err[0], 502)
            self._send_json(code, {'error': 'upstream', 'status': upstream or err[0]})
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

    # ------------------------------------------------------------------
    # Settings drawer (BFF). Read-only, same-origin only (no CORS headers).
    # ------------------------------------------------------------------
    def handle_settings(self):
        route = self.route_path
        if route not in ('/api/settings/hosting', '/api/settings/logs'):
            self._send_json(404, {'error': 'not_found'})
            return
        principal = self._require_principal('settings', SETTINGS_RATE_LIMIT, 'Sign in to view settings.')
        if not principal:
            return
        params = urllib.parse.parse_qs(self.route_query)

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

    # ------------------------------------------------------------------
    # OAuth (Keycloak authorization code + PKCE, refresh, logout). Same-origin
    # only: no CORS headers. The client secret never leaves the server.
    # ------------------------------------------------------------------
    def _oauth_body(self):
        """Rate-limit + parse an OAuth request body; None after sending an error."""
        if rate_limited('oauth', self._client_key(), OAUTH_RATE_LIMIT):
            self._send_json(429, {'error': 'rate_limited', 'message': 'Too many sign-in requests, slow down.'})
            return None
        try:
            return self._read_json_body(16384)
        except InputError as e:
            self._send_json(400, {'error': 'invalid_request', 'message': str(e)})
            return None

    def _redirect_uri_ok(self, redirect_uri):
        """The redirect URI must point back at this very app (same host)."""
        if not isinstance(redirect_uri, str) or len(redirect_uri) > 2048:
            return False
        parts = urllib.parse.urlsplit(redirect_uri)
        return (parts.scheme in ('http', 'https') and parts.netloc == self.headers.get('Host', '')
                and parts.path in ('/', '/index.html') and not parts.query and not parts.fragment)

    def _keycloak_token_call(self, fields, kind):
        data = urllib.parse.urlencode(dict(fields, client_id=KEYCLOAK_CLIENT_ID,
                                           client_secret=KEYCLOAK_CLIENT_SECRET)).encode('utf-8')
        req = urllib.request.Request(f"{KEYCLOAK_BASE}/protocol/openid-connect/token", data=data)
        try:
            with urllib.request.urlopen(req, context=SSL_CTX, timeout=10) as resp:
                token_data = resp.read(256 * 1024)
            self._send_gated_tokens(token_data, kind)
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read(8192).decode('utf-8', 'replace'))
            except ValueError:
                err = {}
            err = err if isinstance(err, dict) else {}
            code = str(err.get('error') or 'token_request_failed')[:64]
            desc = _short(err.get('error_description') or '', 200)
            # A 400 invalid_grant on refresh is normal: the refresh token expired
            # (30 min idle) or the session was revoked.
            print(f"🔑 Keycloak {kind} rejected: HTTP {e.code} {code} {desc}", flush=True)
            self._send_json(e.code if e.code in (400, 401) else 502,
                            {'error': code, 'error_description': desc, 'message': desc or code})
        except Exception as e:
            print(f"🚨 Keycloak {kind} failed: {type(e).__name__}", flush=True)
            self._send_json(502, {'error': 'idp_unreachable', 'message': 'Identity provider unreachable.'})

    def handle_oauth_exchange(self):
        body = self._oauth_body()
        if body is None:
            return
        code = body.get('code')
        verifier = body.get('code_verifier')
        redirect_uri = body.get('redirect_uri')
        if not isinstance(code, str) or not 1 <= len(code) <= 4096:
            self._send_json(400, {'error': 'invalid_request', 'message': 'Missing authorization code.'})
            return
        if not isinstance(verifier, str) or not PKCE_VERIFIER_RE.match(verifier):
            self._send_json(400, {'error': 'invalid_request', 'message': 'Missing or malformed PKCE code_verifier.'})
            return
        if not self._redirect_uri_ok(redirect_uri):
            self._send_json(400, {'error': 'invalid_request', 'message': 'redirect_uri must point back to this app.'})
            return
        self._keycloak_token_call({'grant_type': 'authorization_code', 'code': code,
                                   'redirect_uri': redirect_uri, 'code_verifier': verifier}, 'sign-in')

    def handle_oauth_refresh(self):
        """Exchange a refresh token for a new access token.

        Keycloak issues 5 minute access tokens (realm default), so without this
        the UI silently drops to logged-out mid-demo. Kept server-side because
        the grant needs the confidential client secret, which must never be
        handed to the browser.
        """
        body = self._oauth_body()
        if body is None:
            return
        refresh_token = body.get('refresh_token')
        if not isinstance(refresh_token, str) or not 1 <= len(refresh_token) <= 8192:
            self._send_json(400, {'error': 'invalid_request', 'message': 'missing refresh_token'})
            return
        self._keycloak_token_call({'grant_type': 'refresh_token', 'refresh_token': refresh_token}, 'refresh')

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
        self._send_json(200, tokens)

    def handle_oauth_userinfo(self):
        """Validated userinfo for the caller's token (fails closed)."""
        if not self.headers.get('Authorization'):
            self._send_json(401, {'active': False, 'error': 'missing_authorization_header'})
            return
        principal, err = self._settings_principal()
        if err:
            self._send_json(err, {'active': False,
                                  'error': 'invalid_or_expired_token' if err == 401 else 'idp_unavailable'})
            return
        if not principal['allowed']:
            self._send_json(403, gate_denied_payload())
            return
        info = dict(principal.get('userinfo') or {})
        info['active'] = True
        self._send_json(200, info)

    def handle_oauth_logout(self):
        """Sign out: delete the caller's own ADK sessions (uid from the verified
        token) and revoke their Keycloak tokens. ADK is never restarted."""
        body = self._oauth_body()
        if body is None:
            return
        refresh = body.get('refresh_token')
        refresh = refresh if isinstance(refresh, str) and 1 <= len(refresh) <= 8192 else None
        access, deleted = None, 0
        auth = self.headers.get('Authorization', '')
        if auth.startswith('Bearer ') and len(auth) <= 8192:
            principal, err = self._settings_principal()
            if not err:
                access = auth[7:].strip()
                email = str(principal.get('email') or '').strip().lower()
                if email:
                    deleted = self._delete_user_sessions(email)
            with SETTINGS_LOCK:
                PRINCIPAL_CACHE.pop(hashlib.sha256(auth[7:].strip().encode('utf-8')).hexdigest(), None)
        if refresh or access:
            revoke_tokens({'refresh_token': refresh, 'access_token': access})
        self._send_json(200, {'success': True, 'sessionsDeleted': deleted})

    def _delete_user_sessions(self, uid):
        base = f"/apps/{_q(ADK_APP_NAME)}/users/{_q(uid)}/sessions"
        status, raw, _ = self._adk_call('GET', base, None, timeout=10)
        if status != 200:
            return 0
        try:
            sessions = json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            return 0
        if isinstance(sessions, dict):
            sessions = sessions.get('sessions') or []
        deleted = 0
        for s in sessions[:500] if isinstance(sessions, list) else []:
            sid = s.get('id') if isinstance(s, dict) else None
            if isinstance(sid, str) and SID_RE.match(sid):
                st, _, _ = self._adk_call('DELETE', f"{base}/{_q(sid)}", None, timeout=10)
                deleted += 1 if st in (200, 204) else 0
        return deleted

    # ------------------------------------------------------------------
    # ADK proxy: exact route allow-list, caller identity bound to the uid.
    # ------------------------------------------------------------------
    def _adk_caller(self):
        """-> (identity, None) or (None, (status, body)).

        With a bearer token the token is validated with Keycloak (fail closed)
        and the uid is the verified email. Without one, only guests on the
        customer UI are allowed.
        """
        if self.headers.get('Authorization'):
            client = self._client_key()
            if rate_limited('auth_fail', client, AUTH_FAIL_RATE_LIMIT, count=False):
                return None, (429, {'error': 'rate_limited', 'message': 'Too many failed sign-ins, slow down.'})
            principal, err = self._settings_principal()
            if err:
                if err == 401:
                    rate_limited('auth_fail', client, AUTH_FAIL_RATE_LIMIT)
                return None, (err, {'error': 'unauthorized' if err == 401 else 'idp_unavailable',
                                    'message': 'Your session has expired. Please sign in again.'
                                    if err == 401 else 'Identity provider unavailable.'})
            if not principal['allowed']:
                return None, (403, gate_denied_payload())
            email = str(principal.get('email') or '').strip().lower()
            if not email:
                return None, (403, {'error': 'no_identity', 'message': 'Your token carries no email.'})
            return {'uid': email, 'token': self.headers['Authorization'][7:].strip(),
                    'principal': principal, 'rate_key': f"sub:{principal.get('sub') or email}"}, None
        if IS_STAFF_UI:
            return None, (401, {'error': 'unauthorized', 'message': 'Sign in with a staff account to chat.'})
        return {'uid': None, 'token': '', 'principal': None, 'rate_key': self._client_key()}, None

    @staticmethod
    def _uid_refusal(ident, uid):
        if not isinstance(uid, str):
            return 400, {'error': 'bad_request', 'message': 'userId is required.'}
        if ident['uid']:
            if uid != ident['uid']:
                return 403, {'error': 'user_mismatch', 'message': 'userId must be your signed-in account.'}
            return None
        if not GUEST_ID_RE.match(uid):
            return 401, {'error': 'unauthorized', 'message': 'Sign in to use this account.'}
        return None

    def _adk_call(self, method, path, data, timeout=30, accept='application/json'):
        """-> (status, body bytes, content type). Only safe headers are sent."""
        req = urllib.request.Request(f"{ADK_BACKEND.rstrip('/')}{path}", data=data, method=method)
        if data is not None:
            req.add_header('Content-Type', 'application/json')
        req.add_header('Accept', accept)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, resp.read(16 * 1024 * 1024), resp.headers.get('Content-Type', 'application/json')
        except urllib.error.HTTPError as e:
            content = e.read(64 * 1024)
            print(f"🚨 ADK HTTP {e.code} on {method} {path}: {_short(content.decode('utf-8', 'replace'), 300)}", flush=True)
            return e.code, content, 'application/json'
        except Exception as e:
            print(f"🚨 ADK unreachable on {method} {path}: {type(e).__name__}", flush=True)
            return 502, json.dumps({'error': 'adk_unreachable',
                                    'message': 'The agent runtime is unreachable.'}).encode('utf-8'), 'application/json'

    def _build_run_payload(self, body, ident, streaming):
        """-> (payload, None) or (None, (status, body)). Rebuilds the run request
        from allowed fields; identity and token state are set server-side."""
        app = _pick(body, 'appName', 'app_name')
        if app != ADK_APP_NAME:
            return None, (403, {'error': 'wrong_agent', 'message': f'This UI only serves {ADK_APP_NAME}.'})
        uid = _pick(body, 'userId', 'user_id')
        refusal = self._uid_refusal(ident, uid)
        if refusal:
            return None, refusal
        sid = _pick(body, 'sessionId', 'session_id')
        if not isinstance(sid, str) or not SID_RE.match(sid):
            return None, (400, {'error': 'bad_request', 'message': 'sessionId is missing or malformed.'})
        new_message = _pick(body, 'newMessage', 'new_message')
        if new_message is not None and not isinstance(new_message, dict):
            return None, (400, {'error': 'bad_request', 'message': 'newMessage must be an object.'})
        delta_in = _pick(body, 'stateDelta', 'state_delta')
        delta_in = delta_in if isinstance(delta_in, dict) else {}
        if ident['uid']:
            name = delta_in.get('user_name')
            name = re.sub(r"[\x00-\x1f\x7f]", " ", name).strip()[:80] if isinstance(name, str) else ''
            state = {'access_token': ident['token'], 'is_authenticated': True, 'user_email': ident['uid'],
                     'user_name': name, 'active_scope': ident['principal'].get('scope', '')}
        else:
            # Guests: any token a client tries to smuggle in is dropped.
            state = {'access_token': '', 'is_authenticated': False, 'user_email': uid,
                     'user_name': '', 'active_scope': ''}
        payload = {'appName': app, 'userId': uid, 'sessionId': sid, 'stateDelta': state, 'streaming': streaming}
        if new_message is not None:
            payload['newMessage'] = new_message
        for camel, snake in (('functionCallEventId', 'function_call_event_id'), ('invocationId', 'invocation_id')):
            val = _pick(body, camel, snake)
            if val is not None:
                if not isinstance(val, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', val):
                    return None, (400, {'error': 'bad_request', 'message': f'{camel} is malformed.'})
                payload[camel] = val
        return payload, None

    def proxy_to_adk(self, kind, params):
        if kind == 'list_apps':
            # Health probe; only reveals this UI's own app name.
            if rate_limited('adk', self._client_key(), ADK_RATE_LIMIT):
                self._send_json(429, {'error': 'rate_limited', 'message': 'Too many requests, slow down.'})
                return
            status, raw, _ = self._adk_call('GET', '/list-apps', None, timeout=5)
            if status != 200:
                self._send_raw(status, raw)
                return
            try:
                apps = json.loads(raw.decode('utf-8'))
            except (ValueError, UnicodeDecodeError):
                apps = []
            self._send_json(200, [a for a in apps if a == ADK_APP_NAME] if isinstance(apps, list) else [])
            return

        ident, err = self._adk_caller()
        if err:
            self._send_json(*err)
            return
        if rate_limited('adk', ident['rate_key'], ADK_RATE_LIMIT):
            self._send_json(429, {'error': 'rate_limited', 'message': 'Too many requests, slow down.'})
            return

        if kind in ('create_session', 'delete_session'):
            if params['app'] != ADK_APP_NAME:
                self._send_json(403, {'error': 'wrong_agent', 'message': f'This UI only serves {ADK_APP_NAME}.'})
                return
            refusal = self._uid_refusal(ident, params['uid'])
            if refusal:
                self._send_json(*refusal)
                return
            path = f"/apps/{_q(ADK_APP_NAME)}/users/{_q(params['uid'])}/sessions"
            if kind == 'create_session':
                try:
                    self._read_json_body(4096)   # drained; never forwarded (no client-chosen state)
                except InputError as e:
                    self._send_json(400, {'error': 'bad_request', 'message': str(e)})
                    return
                status, raw, ctype = self._adk_call('POST', path, b'{}')
            else:
                if not SID_RE.match(params['sid']):
                    self._send_json(400, {'error': 'bad_request', 'message': 'Malformed session id.'})
                    return
                status, raw, ctype = self._adk_call('DELETE', f"{path}/{_q(params['sid'])}", None)
            self._send_raw(status, raw, ctype)
            return

        # run / run_sse
        try:
            body = self._read_json_body(ADK_RUN_BODY_LIMIT)
        except InputError as e:
            self._send_json(400, {'error': 'bad_request', 'message': str(e)})
            return
        payload, err = self._build_run_payload(body, ident, streaming=(kind == 'run_sse'))
        if err:
            self._send_json(*err)
            return
        data = json.dumps(payload).encode('utf-8')
        if kind == 'run_sse':
            req = urllib.request.Request(f"{ADK_BACKEND.rstrip('/')}/run_sse", data=data, method='POST')
            req.add_header('Content-Type', 'application/json')
            req.add_header('Accept', 'text/event-stream')
            self._stream_from_adk(req, '/run_sse')
            return
        status, raw, ctype = self._adk_call('POST', '/run', data, timeout=180)
        self._send_raw(status, raw, ctype)

    def _stream_from_adk(self, req, target_path):
        """Relay ADK's Server-Sent Events as they arrive (no buffering), so the
        browser can render the reply while Gemini is still generating it."""
        try:
            resp = urllib.request.urlopen(req, timeout=180)
        except urllib.error.HTTPError as e:
            content = e.read(64 * 1024)
            print(f"🚨 ADK HTTP {e.code} on POST {target_path}: {_short(content.decode('utf-8', 'replace'), 300)}", flush=True)
            self._send_raw(e.code, content)
            return
        except Exception as e:
            print(f"🚨 ADK unreachable on POST {target_path}: {type(e).__name__}", flush=True)
            self._send_json(502, {'error': 'adk_unreachable', 'message': 'The agent runtime is unreachable.'})
            return

        with resp:
            self.send_response(resp.status)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('X-Accel-Buffering', 'no')
            self.send_header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
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
