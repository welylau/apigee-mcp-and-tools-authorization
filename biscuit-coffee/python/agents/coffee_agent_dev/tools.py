from datetime import datetime
from google.adk.tools.mcp_tool import McpToolset, StreamableHTTPConnectionParams

mcp_toolset = McpToolset(
    connection_params=StreamableHTTPConnectionParams(url="https://drush-apigee-dev.34-117-138-63.nip.io/mcp"),
)

def get_current_time() -> str:
    """Returns the current local time for the coffee shop assistant."""
    now = datetime.now()
    return now.strftime("%A, %B %d, %Y %I:%M %p")
