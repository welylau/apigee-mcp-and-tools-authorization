import os

from dotenv import load_dotenv

load_dotenv()

# The customer app's Keycloak client id. It doubles as the Apigee API key
# (x-api-key): mcp-proxy-prod checks it against the access token's `azp`.
# No client secret and no OAuth scheme here: the web UI's BFF does the Keycloak
# login and hands the agent only the user's access token (session state
# `access_token`).
CLIENT_ID = os.getenv("KEYCLOAK_CLIENT_ID", "biscuit-coffee-agent")
