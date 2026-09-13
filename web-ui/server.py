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
KEYCLOAK_CLIENT_SECRET = os.environ.get("KEYCLOAK_CLIENT_SECRET", "YOUR_KEYCLOAK_CLIENT_SECRET")
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

    def do_GET(self):
        if self.path.startswith("/api/oauth/userinfo"):
            self.handle_oauth_userinfo()
            return
        if any(self.path.startswith(p) for p in PROXY_PREFIXES):
            self.proxy_to_adk("GET")
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/oauth/exchange"):
            self.handle_oauth_exchange()
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

if __name__ == '__main__':
    ADK_PROC = ensure_adk_server()
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), CoffeeShopHandler) as httpd:
        print(f"============================================================")
        print(f"☕ Biscuit Coffee Agent Web UI is LIVE!")
        print(f"👉 Local URL: http://localhost:{PORT}")
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
