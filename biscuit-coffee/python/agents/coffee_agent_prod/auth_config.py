import os

from dotenv import load_dotenv
from fastapi.openapi.models import OAuth2, OAuthFlowAuthorizationCode, OAuthFlows
from google.adk.auth import AuthCredential, AuthCredentialTypes, OAuth2Auth

load_dotenv()

CLIENT_ID = os.getenv("KEYCLOAK_CLIENT_ID", "biscuit-coffee-agent")
# Never hardcode the client secret. It comes from the environment: Secret
# Manager on Cloud Run (see scripts/deploy-ui.sh), the gitignored root .env locally.
CLIENT_SECRET = os.getenv("KEYCLOAK_CLIENT_SECRET", "")

auth_scheme = OAuth2(
    flows=OAuthFlows(
        authorizationCode=OAuthFlowAuthorizationCode(
            authorizationUrl="https://keycloak.YOUR_KEYCLOAK_IP.nip.io/realms/apigee-demo/protocol/openid-connect/auth",
            tokenUrl="https://keycloak.YOUR_KEYCLOAK_IP.nip.io/realms/apigee-demo/protocol/openid-connect/token",
            scopes={
                "biscuit_coffee_customer": "Customer scope",
                "biscuit_coffee_manager": "Manager scope"
            },
        )
    )
)

auth_credential = AuthCredential(
    auth_type=AuthCredentialTypes.OAUTH2,
    oauth2=OAuth2Auth(
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET
    ),
)
