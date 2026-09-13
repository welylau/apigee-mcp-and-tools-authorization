import os
from dotenv import load_dotenv
from datetime import datetime
from google.adk.tools.mcp_tool import McpToolset, StreamableHTTPConnectionParams
from .auth_config import CLIENT_ID

load_dotenv()

APIGEE_PROD_HOSTNAME = os.getenv("APIGEE_PROD_HOSTNAME") or "@APIGEE_PROD_HOSTNAME@"
if not APIGEE_PROD_HOSTNAME or APIGEE_PROD_HOSTNAME.startswith("@"):
    APIGEE_PROD_HOSTNAME = "prod.apigee-demo.com"

def apigee_header_provider(context):
    headers = {"x-api-key": CLIENT_ID}
    if context and hasattr(context, "session") and context.session:
        state = context.session.state or {}
        token = state.get("access_token")
        if token:
            headers["Authorization"] = f"Bearer {token}"
    return headers

mcp_toolset = McpToolset(
    connection_params=StreamableHTTPConnectionParams(
        url=f"https://{APIGEE_PROD_HOSTNAME}/mcp",
        headers={"x-api-key": CLIENT_ID}
    ),
    header_provider=apigee_header_provider
)

def get_current_time() -> str:
    """Returns the current local time for the coffee shop assistant."""
    now = datetime.now()
    return now.strftime("%A, %B %d, %Y %I:%M %p")
