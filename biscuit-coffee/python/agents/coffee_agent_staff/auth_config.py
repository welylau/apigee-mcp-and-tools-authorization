import os

from dotenv import load_dotenv

load_dotenv()

# The staff app's Keycloak client id. It doubles as the Apigee API key: the
# consumer key of key `biscuit-coffee-staff` on app `biscuit-coffee-admin-app`,
# linked only to the `biscuit-coffee-staff` API product. mcp-proxy-prod checks
# it against the token's `azp` claim.
CLIENT_ID = os.getenv("KEYCLOAK_STAFF_CLIENT_ID") or "biscuit-coffee-staff"

# No client secret here: the staff web UI's BFF does the Keycloak code
# exchange and hands the agent only the resulting access token (session state
# `access_token`).
