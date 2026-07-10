from fastapi.openapi.models import OAuth2, OAuthFlowAuthorizationCode, OAuthFlows
from google.adk.auth import AuthCredential, AuthCredentialTypes, OAuth2Auth

CLIENT_ID="biscuit-coffee-agent"
CLIENT_SECRET="oHHeazVDRvTK6aHFMop8cTWgx0MzWFvR"

auth_scheme = OAuth2(
    flows=OAuthFlows(
        authorizationCode=OAuthFlowAuthorizationCode(
            authorizationUrl="https://34.160.173.66.nip.io/realms/apigee-demo/protocol/openid-connect/auth",
            tokenUrl="https://34.160.173.66.nip.io/realms/apigee-demo/protocol/openid-connect/token",
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
