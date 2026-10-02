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

PORT = int(os.environ.get("PORT", sys.argv[1] if len(sys.argv) > 1 else 3000))
ADK_BACKEND = os.environ.get("ADK_BACKEND", sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8000")

KEYCLOAK_BASE = os.environ.get("KEYCLOAK_BASE", "https://keycloak.YOUR_KEYCLOAK_IP.nip.io/realms/apigee-demo")
KEYCLOAK_CLIENT_ID = os.environ.get("KEYCLOAK_CLIENT_ID", "biscuit-coffee-agent")
# Never hardcode the client secret. On Cloud Run it is injected from Secret
# Manager (secret "keycloak-client-secret", see scripts/deploy-ui.sh); locally
# it comes from the gitignored repo-root .env.
KEYCLOAK_CLIENT_SECRET = os.environ.get("KEYCLOAK_CLIENT_SECRET", "")
if not KEYCLOAK_CLIENT_SECRET:
    print("WARNING: KEYCLOAK_CLIENT_SECRET is not set; Keycloak login/token "
          "exchange will fail until it is provided.", file=sys.stderr)

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
ADK_PROC = None

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
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
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
        if self.path.startswith("/api/oauth/userinfo"):
            self.handle_oauth_userinfo()
            return
        if self.path.startswith("/api/settings/"):
            self.handle_settings()
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
        if any(self.path.startswith(p) for p in PROXY_PREFIXES):
            self.proxy_to_adk("POST")
        else:
            self.send_error(404, "Not Found")

    def do_DELETE(self):
        if any(self.path.startswith(p) for p in PROXY_PREFIXES):
            self.proxy_to_adk("DELETE")
        else:
            self.send_error(404, "Not Found")

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
            "agentName": "biscuit_coffee_agent",
            "framework": "Google ADK",
            "model": model or "unknown",
            "gatewayEnabled": True,
            "gatewayHostname": APIGEE_PROD_HOSTNAME,
            "adkLive": is_adk_running()
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
        claims = {}
        try:
            import base64
            part = token.split('.')[1]
            claims = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)).decode('utf-8'))
        except Exception:
            pass
        scopes = (claims.get('scope') or '').split()
        roles = (claims.get('realm_access') or {}).get('roles', [])
        principal = {
            'sub': userinfo.get('sub'),
            'email': userinfo.get('email') or userinfo.get('preferred_username'),
            'manager': 'biscuit_coffee_manager' in scopes or 'biscuit_coffee_manager' in roles,
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
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(token_data)
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
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(token_data)
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
                userinfo = resp.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(userinfo)
                return
        except urllib.error.HTTPError as e:
            if e.code != 401:
                jwt_info = parse_jwt_userinfo(auth_header)
                if jwt_info:
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(json.dumps(jwt_info).encode('utf-8'))
                    return
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(b'{"active": false, "error": "invalid_or_expired_token"}')
        except Exception as e:
            jwt_info = parse_jwt_userinfo(auth_header)
            if jwt_info:
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps(jwt_info).encode('utf-8'))
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

    def proxy_to_adk(self, method):
        target_path = self.path
        if target_path.startswith("/api/"):
            target_path = "/" + target_path[5:]

        target_url = f"{ADK_BACKEND.rstrip('/')}{target_path}"

        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length > 0 else None

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
        print(f"☕ Biscuit Coffee Agent Web UI is LIVE!")
        print(f"👉 Local URL: http://localhost:{PORT}  (bound to {BIND_HOST})")
        print(f"👉 Reverse Proxy Target: {ADK_BACKEND}")
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
