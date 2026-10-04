#!/usr/bin/env python3
"""
test-dev-audit.py - standalone test harness for the ISOLATED dev environment
(default-dev / dev.apigee-demo.com). It never calls the prod hostname.

It obtains real Keycloak tokens for the demo users through the DEV client
(biscuit-coffee-agent-dev, password grant), then drives the MCP endpoint the
same way the ADK agent does (x-api-key + Bearer JWT, JSON-RPC over HTTP).

Usage:
  python3 scripts/test-dev-audit.py tools                  # list tools + schemas
  python3 scripts/test-dev-audit.py smoke                  # baseline parity checks
  python3 scripts/test-dev-audit.py quota                  # 4x placeOrder < 60 s
  python3 scripts/test-dev-audit.py largeorder             # $100.00 and over are refused
  python3 scripts/test-dev-audit.py roles                  # manager + customer calls
  python3 scripts/test-dev-audit.py approval               # $50 up to $100 needs approval (3 orders)
  python3 scripts/test-dev-audit.py status <order_id>...   # order status after a Staff app decision
  python3 scripts/test-dev-audit.py logs [minutes]         # read audit log entries

placeOrder is limited to 3 per minute per user, so wait 60 s between
approval / largeorder / quota runs.

Reads KEYCLOAK_DEV_CLIENT_ID / KEYCLOAK_DEV_CLIENT_SECRET / APIGEE_DEV_HOSTNAME
from .env. Standard library only.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

KC_TOKEN_URL = "https://keycloak.YOUR_KEYCLOAK_IP.nip.io/realms/apigee-demo/protocol/openid-connect/token"
USERS = {
    "customer": ("customer@biscuit-coffee.com", "ilovecoffee", "openid"),
    "manager": ("manager@biscuit-coffee.com", "ilovecoffee", "openid biscuit_coffee_manager"),
}


def load_env(path=".env"):
    if not os.path.exists(path):
        return
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"'))


load_env()
HOST = os.environ.get("APIGEE_DEV_HOSTNAME", "dev.apigee-demo.com")
if "prod" in HOST:
    sys.exit(f"REFUSING: hostname {HOST} looks like prod")
CLIENT_ID = os.environ["KEYCLOAK_DEV_CLIENT_ID"]
CLIENT_SECRET = os.environ["KEYCLOAK_DEV_CLIENT_SECRET"]
MCP_URL = f"https://{HOST}/mcp"
_tokens = {}
_rpc_id = [100]


def token(role):
    if role not in _tokens:
        user, pw, scope = USERS[role]
        data = urllib.parse.urlencode({
            "grant_type": "password", "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
            "username": user, "password": pw, "scope": scope}).encode()
        with urllib.request.urlopen(urllib.request.Request(KC_TOKEN_URL, data=data), timeout=20) as r:
            _tokens[role] = json.load(r)["access_token"]
    return _tokens[role]


def mcp(method, params=None, role="customer"):
    _rpc_id[0] += 1
    body = json.dumps({"jsonrpc": "2.0", "id": _rpc_id[0], "method": method, "params": params or {}}).encode()
    req = urllib.request.Request(MCP_URL, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "x-api-key": CLIENT_ID,
        "Authorization": f"Bearer {token(role)}",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            status, raw = r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read().decode()
    payload = None
    for line in raw.splitlines():  # SSE or plain JSON
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
            payload = {"raw": raw[:500]}
    return status, payload


def tool(name, args, role="customer"):
    return mcp("tools/call", {"name": name, "arguments": args}, role)


def summarize(status, payload):
    if "error" in payload:
        return f"HTTP {status} JSON-RPC error: {payload['error'].get('message', '')[:160]}"
    res = payload.get("result", {})
    text = ""
    for c in res.get("content", []) or []:
        if c.get("type") == "text":
            text = c.get("text", "")
            break
    return f"HTTP {status} isError={res.get('isError', False)} {text[:200]}"


def order_args(items):
    # The managed MCP server exposes the REST request body as `placeOrderBody`.
    return {"placeOrderBody": {"items": items, "email": USERS["customer"][0]}}


def cmd_tools():
    s, p = mcp("tools/list")
    for t in p.get("result", {}).get("tools", []):
        print(f"- {t['name']}: {json.dumps(t.get('inputSchema', {}))[:300]}")


def cmd_smoke():
    s, p = mcp("tools/list")
    names = [t["name"] for t in p.get("result", {}).get("tools", [])]
    print(f"tools/list -> HTTP {s}, {len(names)} tools")
    print("getMenu (customer)        ->", summarize(*tool("getMenu", {})))
    print("listEmployees (customer)  ->", summarize(*tool("listEmployees", {}, "customer")))
    print("listEmployees (manager)   ->", summarize(*tool("listEmployees", {}, "manager")))


def cmd_quota():
    print("Placing 4 small orders within 60 s (limit is 3/min)...")
    for i in range(1, 5):
        print(f"  placeOrder #{i} ->", summarize(*tool("placeOrder", order_args([{"item_id": "item-10-single", "quantity": 1}]))))


def cmd_largeorder():
    """Online orders must be UNDER maxOrderAmount ($100): exactly $100 is refused too."""
    cases = [
        ("exact  $100.00 (expect rejected)", [{"item_id": "item-10-single", "quantity": 40}]),
        ("large  $157.50 (expect rejected)", [{"item_id": "item-4-l", "quantity": 30}]),
    ]
    failures = 0
    for label, items in cases:
        status, payload = tool("placeOrder", order_args(items))
        body = _result_json(payload) or {}
        text = summarize(status, payload)
        # Rejected = no order created, and the limit message (or a 422) comes back.
        ok = not body.get("order_id") and ("must be under" in text or "422" in text or "limit" in text.lower())
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} placeOrder {label} -> {text}")
    print(f"\n{'ALL PASSED' if failures == 0 else f'{failures} FAILED'}")


def cmd_roles():
    print("listEmployees (manager) ->", summarize(*tool("listEmployees", {}, "manager")))
    print("listOrders (customer)   ->", summarize(*tool("listOrders", {}, "customer")))
    print("getMenu (customer)      ->", summarize(*tool("getMenu", {}, "customer")))


def cmd_logs(minutes="15"):
    project = os.environ.get("GOOGLE_CLOUD_PROJECT", "YOUR_GCP_PROJECT_ID")
    flt = (f'logName="projects/{project}/logs/apigee-consumer-audit" '
           f'AND timestamp>="{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - int(minutes) * 60))}"')
    out = subprocess.run(["gcloud", "logging", "read", flt, "--project", project,
                          "--format=json", "--limit=50"], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(out.stderr)
    entries = json.loads(out.stdout or "[]")
    print(f"{len(entries)} audit entries in the last {minutes} min")
    for e in reversed(entries):
        j = e.get("jsonPayload", {})
        print(json.dumps({
            "ts": e.get("timestamp"), "labels": e.get("labels"), "event": j.get("event"),
            "env": j.get("environment"), "proxy": j.get("proxy"), "rev": j.get("revision"),
            "correlation_id": j.get("correlation_id"), "consumer": j.get("consumer"),
            "end_user": j.get("end_user"), "request": j.get("request"), "detail": j.get("detail"),
        }, indent=1))


def _result_json(payload):
    for c in (payload.get("result", {}) or {}).get("content", []) or []:
        if c.get("type") == "text":
            try:
                return json.loads(c.get("text", ""))
            except ValueError:
                return None
    return None


def cmd_approval():
    """Human-in-the-loop tiers: < $50 confirmed, $50..$100 pending approval."""
    cases = [
        ("small  $3.25  (expect confirmed)", [{"item_id": "item-1-s", "quantity": 1}], False),
        ("edge   $50.00 (expect pending)  ", [{"item_id": "item-10-single", "quantity": 20}], True),
        ("mid    $63.00 (expect pending)  ", [{"item_id": "item-4-l", "quantity": 12}], True),
    ]
    pending_ids, failures = [], 0
    for label, items, expect_pending in cases:  # 3 orders = the 3/min quota
        status, payload = tool("placeOrder", order_args(items))
        body = _result_json(payload) or {}
        msg = str(body.get("message", ""))
        # Key on the machine-readable status; fall back to wording for older proxies.
        is_pending = body.get("status") == "PENDING_APPROVAL" or "pending approval" in msg or "waiting for approval" in msg
        ok = bool(body.get("order_id")) and is_pending == expect_pending
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} placeOrder {label} -> {summarize(status, payload)}")
        if is_pending and body.get("order_id"):
            pending_ids.append(str(body["order_id"]))
    for oid in pending_ids:
        s, p = tool("getOrder", {"id": oid})
        st = (_result_json(p) or {}).get("status")
        ok = st == "PENDING_APPROVAL"
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} getOrder {oid} -> status {st}")
    if pending_ids:
        print("\nApprove or reject in the Staff app (decideOrder as staff@/manager@), then check with:")
        print(f"  python3 scripts/test-dev-audit.py status {' '.join(pending_ids)}")
    print(f"\n{'ALL PASSED' if failures == 0 else f'{failures} FAILED'}"
          " (orders of $100 or more are covered by: largeorder)")


def cmd_status(*order_ids):
    for oid in order_ids:
        s, p = tool("getOrder", {"id": oid})
        body = _result_json(p) or {}
        print(f"{oid}: status={body.get('status')} approval={json.dumps(body.get('approval'))}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "smoke"
    fn = {"tools": cmd_tools, "smoke": cmd_smoke, "quota": cmd_quota, "largeorder": cmd_largeorder,
          "roles": cmd_roles, "logs": cmd_logs, "approval": cmd_approval, "status": cmd_status}.get(cmd)
    if not fn:
        sys.exit(__doc__)
    fn(*sys.argv[2:])
