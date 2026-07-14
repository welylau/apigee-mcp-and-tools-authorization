import os
from datetime import datetime
from dotenv import load_dotenv
from google.adk.tools.mcp_tool import McpToolset, StreamableHTTPConnectionParams

load_dotenv()

APIGEE_DEV_HOSTNAME = os.getenv("APIGEE_DEV_HOSTNAME")
if not APIGEE_DEV_HOSTNAME:
    raise ValueError("APIGEE_DEV_HOSTNAME environment variable is not set")

mcp_toolset = McpToolset(
    connection_params=StreamableHTTPConnectionParams(url=f"https://{APIGEE_DEV_HOSTNAME}/mcp"),
)

def get_current_time() -> str:
    """Returns the current local time for the coffee shop assistant."""
    now = datetime.now()
    return now.strftime("%A, %B %d, %Y %I:%M %p")
