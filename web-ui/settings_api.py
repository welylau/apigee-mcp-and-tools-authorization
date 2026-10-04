"""
Backend-for-frontend helpers for the Web UI "Settings" drawer.

Two read-only data sources, both fetched server-side with Application Default
Credentials so no Google token or Apigee secret ever reaches the browser:

  * hosting_info()  - where this UI runs and what it talks to (Apigee proxies,
                      deployments, products, developer apps, Cloud Run backend).
  * audit_logs()    - entries from the `apigee-consumer-audit` Cloud Logging
                      log, with aggregates for the dashboard widgets and
                      server-side paging.

PII handling: e-mail addresses are masked here, before they leave the server.
API keys are only ever shown as the SHA-256 fingerprint that the proxies log,
and consumer secrets are never read into a response.
"""

import hashlib
import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
APIGEE_ORG = os.environ.get("APIGEE_ORG", PROJECT)
AUDIT_LOG_ID = os.environ.get("AUDIT_LOG_ID", "apigee-consumer-audit")
RELATED_PROXIES = [p.strip() for p in os.environ.get(
    "SETTINGS_PROXIES", "mcp-proxy-prod,mcp-proxy-dev,Biscuit-Coffee-Shop").split(",") if p.strip()]
BACKEND_SERVICE = os.environ.get("BACKEND_SERVICE_NAME", "biscuit-coffee-backend")
BACKEND_REGION = os.environ.get("BACKEND_REGION", "asia-southeast1")

APIGEE_API = "https://apigee.googleapis.com/v1"
LOGGING_API = "https://logging.googleapis.com/v2"
RUN_API = "https://run.googleapis.com/v2"

# Allow-lists for every user-controlled query parameter.
RANGES = {
    "1h": (timedelta(hours=1), timedelta(minutes=5)),
    "3h": (timedelta(hours=3), timedelta(minutes=15)),
    "1d": (timedelta(days=1), timedelta(hours=1)),
    "3d": (timedelta(days=3), timedelta(hours=3)),
    "7d": (timedelta(days=7), timedelta(hours=6)),
    "30d": (timedelta(days=30), timedelta(days=1)),
}
EVENTS = ("quota_exceeded", "order_limit_exceeded", "jwt_access",
          # Human-in-the-loop order approval. approval_trigger_failed is a
          # legacy event name, kept so older log entries can still be filtered.
          "approval_required", "approval_trigger_failed")
# Pseudo-filter for the event dropdown: every entry whose HTTP status is an
# error (4xx/5xx), whatever its event name.
ERRORS_FILTER = "errors"
RECENT_ERRORS = 8
PAGE_SIZES = (10, 25, 50)
MAX_ENTRIES = 5000          # hard cap per range snapshot (5 x 1000 API pages)
LOG_CACHE_TTL = 30          # seconds
HOSTING_CACHE_TTL = 120     # seconds

_lock = threading.Lock()
_token = {"value": None, "exp": 0.0}
_log_cache = {}             # range -> (fetched_at, entries, truncated)
_hosting_cache = {"at": 0.0, "data": None}


class UpstreamError(Exception):
    """Raised when a Google API call fails. The message is safe to show."""


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
_EMAIL_RE = re.compile(r"^([^@\s]+)@([^@\s]+)$")


def mask_email(value):
    """customer@biscuit-coffee.com -> c******r@biscuit-coffee.com"""
    if not value or not isinstance(value, str):
        return value
    m = _EMAIL_RE.match(value.strip())
    if not m:
        return value
    local, domain = m.groups()
    if len(local) <= 2:
        masked = local[0] + "*"
    else:
        masked = local[0] + "*" * (len(local) - 2) + local[-1]
    return f"{masked}@{domain}"


def key_fingerprint(raw_key):
    """Same format the proxies log (sha256:<hex>) so the two can be correlated."""
    if not raw_key:
        return ""
    return "sha256:" + hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def _gcp_token():
    """ADC access token. google-auth first, gcloud ADC as a fallback.

    `gcloud auth print-access-token` is intentionally NOT used: on corp
    machines it yields a certificate-bound token that Apigee rejects.
    """
    with _lock:
        if _token["value"] and _token["exp"] - time.time() > 60:
            return _token["value"]
    value, exp = None, time.time() + 300
    try:
        import google.auth
        import google.auth.transport.requests
        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        creds.refresh(google.auth.transport.requests.Request())
        value = creds.token
        if getattr(creds, "expiry", None):
            exp = creds.expiry.replace(tzinfo=timezone.utc).timestamp()
    except Exception:
        # Fixed argv, no user input: safe subprocess call.
        out = subprocess.run(["gcloud", "auth", "application-default", "print-access-token"],
                             capture_output=True, text=True, timeout=20)
        if out.returncode == 0 and out.stdout.strip():
            value = out.stdout.strip()
    if not value:
        raise UpstreamError("Google Cloud credentials unavailable (run `gcloud auth application-default login`).")
    with _lock:
        _token.update(value=value, exp=exp)
    return value


def _call(url, body=None, timeout=20):
    headers = {"Authorization": f"Bearer {_gcp_token()}", "Accept": "application/json"}
    if PROJECT:
        headers["x-goog-user-project"] = PROJECT
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        # Log details server-side only; return a generic, non-leaky message.
        print(f"⚠️ Settings upstream HTTP {e.code} for {url.split('?')[0]}", flush=True)
        raise UpstreamError(f"Upstream API returned HTTP {e.code}")
    except Exception as e:
        print(f"⚠️ Settings upstream error for {url.split('?')[0]}: {type(e).__name__}", flush=True)
        raise UpstreamError("Upstream API unreachable")


def _safe(fn, errors, label):
    try:
        return fn()
    except UpstreamError as e:
        errors.append(f"{label}: {e}")
    except Exception as e:  # never let one section break the whole panel
        print(f"⚠️ Settings section '{label}' failed: {type(e).__name__}: {e}", flush=True)
        errors.append(f"{label}: unavailable")
    return None


def _ms_to_iso(ms):
    try:
        return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc).isoformat()
    except Exception:
        return None


def _attrs(items):
    return {a.get("name"): a.get("value") for a in (items or []) if a.get("name")}


# --------------------------------------------------------------------------
# Hosting info
# --------------------------------------------------------------------------
def hosting_info(runtime, refresh=False):
    """`runtime` carries the local, non-secret server settings from server.py."""
    with _lock:
        cached = _hosting_cache["data"]
        if cached and not refresh and time.time() - _hosting_cache["at"] < HOSTING_CACHE_TTL:
            return {**cached, "runtime": runtime, "cached": True}

    errors = []
    org = APIGEE_ORG
    base = f"{APIGEE_API}/organizations/{urllib.parse.quote(org)}"

    def envgroups():
        groups = _call(f"{base}/envgroups").get("environmentGroups", [])
        out = []
        for g in groups:
            att = _call(f"{base}/envgroups/{urllib.parse.quote(g['name'])}/attachments")
            out.append({
                "name": g.get("name"),
                "hostnames": g.get("hostnames", []),
                "environments": [a.get("environment") for a in att.get("environmentGroupAttachments", [])],
            })
        return out

    def deployments():
        deps = _call(f"{base}/deployments").get("deployments", [])
        rows = [{
            "proxy": d.get("apiProxy"),
            "environment": d.get("environment"),
            "revision": d.get("revision"),
            "deployedAt": _ms_to_iso(d.get("deployStartTime")),
            "serviceAccount": d.get("serviceAccount", ""),
            "state": d.get("state", ""),
        } for d in deps if d.get("apiProxy") in RELATED_PROXIES]
        rows.sort(key=lambda r: (r["proxy"] or "", r["environment"] or ""))
        return rows

    def products():
        items = _call(f"{base}/apiproducts?expand=true").get("apiProduct", [])
        out = []
        for p in items:
            # REST products use operationGroup; MCP products use payloadOperationGroup.
            configs = []
            for key in ("operationGroup", "payloadOperationGroup"):
                configs.extend((p.get(key) or {}).get("operationConfigs", []))
            sources = {c.get("apiSource") for c in configs if c.get("apiSource")}
            proxies = sorted(sources | set(p.get("proxies", [])))
            if not set(proxies) & set(RELATED_PROXIES):
                continue
            ops, controls = [], []
            for c in configs:
                names = [o.get("operation") or o.get("resource") for o in c.get("operations", [])]
                ops.extend(n for n in names if n)
                q = c.get("quota") or {}
                attrs = _attrs(c.get("attributes"))
                if q.get("limit") or attrs:
                    controls.append({
                        "operations": names,
                        "quota": f"{q['limit']} / {q.get('interval', '1')} {q.get('timeUnit', '')}".strip()
                                 if q.get("limit") else None,
                        "attributes": attrs,
                    })
            quota = None
            if p.get("quota"):
                quota = f"{p.get('quota')} / {p.get('quotaInterval', '1')} {p.get('quotaTimeUnit', '')}".strip()
            out.append({
                "name": p.get("name"),
                "displayName": p.get("displayName"),
                "environments": p.get("environments", []),
                "proxies": proxies,
                "operations": len(ops),
                "operationNames": ops,
                "controls": controls,
                "approval": p.get("approvalType"),
                "quota": quota,
                "attributes": _attrs(p.get("attributes")),
            })
        out.sort(key=lambda r: r["name"])
        return out

    def apps(product_names):
        devs = _call(f"{base}/developers?expand=true").get("developer", [])
        dev_email = {d.get("developerId"): d.get("email") for d in devs}
        items = _call(f"{base}/apps?expand=true&rows=1000").get("app", [])
        out = []
        for a in items:
            creds = []
            for c in a.get("credentials", []):
                prods = [x.get("apiproduct") for x in c.get("apiProducts", [])]
                if not set(prods) & product_names:
                    continue
                # consumerSecret is deliberately never read.
                creds.append({
                    "keyFingerprint": key_fingerprint(c.get("consumerKey", "")),
                    "status": c.get("status"),
                    "products": prods,
                    "expiresAt": None if str(c.get("expiresAt", "-1")) == "-1" else _ms_to_iso(c.get("expiresAt")),
                })
            if not creds:
                continue
            out.append({
                "name": a.get("name"),
                "developer": mask_email(dev_email.get(a.get("developerId"), "")),
                "status": a.get("status"),
                "createdAt": _ms_to_iso(a.get("createdAt")),
                "attributes": _attrs(a.get("attributes")),
                "credentials": creds,
            })
        out.sort(key=lambda r: r["name"])
        return out

    def backend():
        svc = _call(f"{RUN_API}/projects/{urllib.parse.quote(PROJECT)}/locations/"
                    f"{urllib.parse.quote(BACKEND_REGION)}/services/{urllib.parse.quote(BACKEND_SERVICE)}")
        return {
            "service": BACKEND_SERVICE,
            "region": BACKEND_REGION,
            "url": svc.get("uri"),
            "latestRevision": (svc.get("latestReadyRevision") or "").split("/")[-1],
            "updatedAt": svc.get("updateTime"),
            "ingress": svc.get("ingress"),
        }

    from concurrent.futures import ThreadPoolExecutor
    _gcp_token()  # warm once so the workers don't all refresh credentials
    with ThreadPoolExecutor(max_workers=4) as pool:
        f_groups = pool.submit(_safe, envgroups, errors, "Environment groups")
        f_deps = pool.submit(_safe, deployments, errors, "Proxy deployments")
        f_prods = pool.submit(_safe, products, errors, "API products")
        f_be = pool.submit(_safe, backend, errors, "Cloud Run backend")
        prods = f_prods.result() or []
        f_apps = pool.submit(_safe, lambda: apps({p["name"] for p in prods}), errors, "Developer apps") \
            if prods else None
        groups = f_groups.result() or []
        deps = f_deps.result() or []
        be = f_be.result()
        app_rows = (f_apps.result() if f_apps else None) or []

    data = {
        "project": PROJECT,
        "apigeeOrg": org,
        "environmentGroups": groups,
        "deployments": deps,
        "products": prods,
        "apps": app_rows,
        "backend": be,
        "observability": {
            "logName": f"projects/{PROJECT}/logs/{AUDIT_LOG_ID}",
            "consoleUrl": "https://console.cloud.google.com/logs/query;query=" + urllib.parse.quote(
                f'logName="projects/{PROJECT}/logs/{AUDIT_LOG_ID}"', safe="") + f"?project={urllib.parse.quote(PROJECT)}",
        },
        "errors": errors,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }
    with _lock:
        _hosting_cache.update(at=time.time(), data=data)
    return {**data, "runtime": runtime, "cached": False}


# --------------------------------------------------------------------------
# Audit logs
# --------------------------------------------------------------------------
def _normalize(entry):
    j = entry.get("jsonPayload") or {}
    consumer = j.get("consumer") or {}
    user = j.get("end_user") or {}
    req = j.get("request") or {}
    detail = j.get("detail") or {}
    status = str(req.get("status") or "")
    fp = consumer.get("api_key_fp") or ""
    role = user.get("role") or ""
    role_verified = bool(role)
    if not role and user:
        scopes = (user.get("scope") or "").split()
        role = ("manager" if "biscuit_coffee_manager" in scopes
                else "staff" if "biscuit_coffee_staff" in scopes
                else "customer" if scopes else "")
    if not user:
        role = "anonymous"
    return {
        "id": entry.get("insertId"),
        "ts": entry.get("timestamp"),
        "event": j.get("event") or (entry.get("labels") or {}).get("event") or "unknown",
        "environment": j.get("environment") or "",
        "proxy": j.get("proxy") or "",
        "revision": str(j.get("revision") or ""),
        "correlationId": j.get("correlation_id") or "",
        "status": status,
        "verb": req.get("verb") or "",
        "path": req.get("path") or "",
        "tool": req.get("mcp_tool") or "",
        "clientIp": req.get("client_ip") or "",
        "clientId": consumer.get("client_id") or "",
        "app": consumer.get("app") or "",
        "developer": mask_email(consumer.get("developer") or ""),
        "product": consumer.get("product") or "",
        "productsOnKey": consumer.get("products_on_key") or "",
        "keyFingerprint": fp,
        "attributes": consumer.get("attributes") or {},
        "user": mask_email(user.get("email") or user.get("username") or ""),
        "userSub": user.get("sub") or "",
        "role": role or "unknown",
        "roleVerified": role_verified,
        "scope": user.get("scope") or "",
        "jti": user.get("jti") or "",
        "detail": {k: v for k, v in detail.items() if v not in (None, "")} if isinstance(detail, dict) else {},
    }


def _fetch_range(range_key):
    span, _ = RANGES[range_key]
    with _lock:
        hit = _log_cache.get(range_key)
        if hit and time.time() - hit[0] < LOG_CACHE_TTL:
            return hit[1], hit[2], hit[0]
    if not PROJECT:
        raise UpstreamError("GOOGLE_CLOUD_PROJECT is not configured")
    since = (datetime.now(timezone.utc) - span).strftime("%Y-%m-%dT%H:%M:%SZ")
    body = {
        "resourceNames": [f"projects/{PROJECT}"],
        "filter": f'logName="projects/{PROJECT}/logs/{AUDIT_LOG_ID}" AND timestamp>="{since}"',
        "orderBy": "timestamp desc",
        "pageSize": 1000,
    }
    entries, truncated = [], False
    while True:
        resp = _call(f"{LOGGING_API}/entries:list", body=body, timeout=30)
        entries.extend(_normalize(e) for e in resp.get("entries", []))
        token = resp.get("nextPageToken")
        if not token:
            break
        if len(entries) >= MAX_ENTRIES:
            truncated = True
            break
        body["pageToken"] = token
    fetched_at = time.time()
    with _lock:
        _log_cache[range_key] = (fetched_at, entries, truncated)
    return entries, truncated, fetched_at


def _parse_ts(ts):
    # Cloud Logging emits nanoseconds (e.g. ...56.011197529Z); trim to micros.
    try:
        core = ts.rstrip("Z").split("+")[0]
        if "." in core:
            head, frac = core.split(".", 1)
            core = f"{head}.{frac[:6]}"
        return datetime.fromisoformat(core).replace(tzinfo=timezone.utc)
    except Exception:
        return None


def is_error(entry):
    """HTTP 4xx/5xx response recorded by the gateway."""
    s = entry.get("status") or ""
    return s.isdigit() and int(s) >= 400


def _timeline(entries, range_key):
    span, step = RANGES[range_key]
    now = datetime.now(timezone.utc)
    start = now - span
    n = int(span / step)
    buckets = [{"start": (start + step * i).isoformat(), "errors": 0, **{e: 0 for e in EVENTS}} for i in range(n)]
    for e in entries:
        t = _parse_ts(e["ts"] or "")
        if not t:
            continue
        idx = int((t - start) / step)
        if not 0 <= idx < n:
            continue
        if e["event"] in EVENTS:
            buckets[idx][e["event"]] += 1
        if is_error(e):
            buckets[idx]["errors"] += 1
    return {"stepSeconds": int(step.total_seconds()), "buckets": buckets}


def _aggregate(entries, range_key):
    total = len(entries)
    statuses = Counter(e["status"] or "n/a" for e in entries)
    errors = [e for e in entries if is_error(e)]  # newest first (entries are timestamp desc)
    denied = len(errors)
    violations = [e for e in entries if e["event"] in ("quota_exceeded", "order_limit_exceeded")]
    order_totals = []
    for e in entries:
        if e["event"] == "order_limit_exceeded":
            try:
                order_totals.append(float(e["detail"].get("order_total")))
            except (TypeError, ValueError):
                pass

    def top(key, n=6, src=entries):
        return [{"label": k, "count": c} for k, c in Counter(e[key] for e in src if e[key]).most_common(n)]

    def path_label(e):
        return (e["tool"] or f'{e["verb"]} {e["path"]}').strip()

    def status_is(e, *codes):
        return e["status"] in codes

    return {
        "kpis": {
            "total": total,
            "violations": len(violations),
            "quotaExceeded": sum(1 for e in entries if e["event"] == "quota_exceeded"),
            "largeOrders": sum(1 for e in entries if e["event"] == "order_limit_exceeded"),
            "deniedRate": round(100.0 * denied / total, 1) if total else 0.0,
            "errors": denied,
            "authErrors": sum(1 for e in errors if status_is(e, "401", "403")),
            "rateLimited": sum(1 for e in errors if status_is(e, "429")),
            "serverErrors": sum(1 for e in errors if int(e["status"]) >= 500),
            "lastErrorAt": errors[0]["ts"] if errors else None,
            "uniqueUsers": len({e["userSub"] or e["user"] for e in entries if e["userSub"] or e["user"]}),
            "uniqueApps": len({e["clientId"] or e["app"] for e in entries if e["clientId"] or e["app"]}),
            "maxRejectedOrder": max(order_totals) if order_totals else None,
        },
        "byEvent": [{"label": k, "count": c} for k, c in Counter(e["event"] for e in entries).most_common()],
        "byRole": [{"label": k, "count": c} for k, c in Counter(e["role"] or "unknown" for e in entries).most_common()],
        "byEnvironment": top("environment"),
        "byProxy": top("proxy"),
        "byStatus": [{"label": k, "count": c} for k, c in sorted(statuses.items())],
        "errorsByStatus": [{"label": k, "count": c} for k, c in sorted(Counter(e["status"] for e in errors).items())],
        "errorPaths": [{"label": k, "count": c} for k, c in Counter(
            path_label(e) for e in errors if e["tool"] or e["path"]).most_common(6)],
        "recentErrors": errors[:RECENT_ERRORS],
        "topUsers": top("user"),
        "topViolators": top("user", src=violations),
        "topClients": top("clientId"),
        "topPaths": [{"label": k, "count": c} for k, c in Counter(
            path_label(e) for e in entries if e["tool"] or e["path"]).most_common(6)],
        "timeline": _timeline(entries, range_key),
    }


def audit_logs(params):
    """params: parsed query dict (lists). Every value is allow-listed."""
    range_key = (params.get("range") or ["1d"])[0]
    if range_key not in RANGES:
        range_key = "1d"
    event = (params.get("event") or ["all"])[0]
    if event not in EVENTS and event != ERRORS_FILTER:
        event = "all"
    env = (params.get("env") or ["all"])[0]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", env or ""):
        env = "all"
    try:
        page_size = int((params.get("pageSize") or ["25"])[0])
    except ValueError:
        page_size = 25
    if page_size not in PAGE_SIZES:
        page_size = 25
    try:
        page = max(1, int((params.get("page") or ["1"])[0]))
    except ValueError:
        page = 1
    if (params.get("refresh") or ["0"])[0] == "1":
        with _lock:
            _log_cache.pop(range_key, None)

    def event_ok(e):
        if event == "all":
            return True
        if event == ERRORS_FILTER:
            return is_error(e)
        return e["event"] == event

    entries, truncated, fetched_at = _fetch_range(range_key)
    environments = sorted({e["environment"] for e in entries if e["environment"]})
    filtered = [e for e in entries if event_ok(e) and (env == "all" or e["environment"] == env)]
    pages = max(1, -(-len(filtered) // page_size))
    page = min(page, pages)
    rows = filtered[(page - 1) * page_size: page * page_size]

    return {
        "range": range_key,
        "filters": {"event": event, "env": env, "environments": environments,
                    "events": list(EVENTS) + [ERRORS_FILTER]},
        "logName": f"projects/{PROJECT}/logs/{AUDIT_LOG_ID}",
        "fetchedAt": datetime.fromtimestamp(fetched_at, tz=timezone.utc).isoformat(),
        "truncated": truncated,
        "aggregates": _aggregate(filtered, range_key),
        "page": {"number": page, "size": page_size, "pages": pages, "total": len(filtered)},
        "entries": rows,
    }
