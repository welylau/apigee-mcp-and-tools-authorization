import os
from dotenv import load_dotenv
from datetime import datetime
from google.adk.tools.mcp_tool import McpToolset, StreamableHTTPConnectionParams
from google.adk.integrations.agent_registry.agent_registry import AgentRegistry
from .auth_config import auth_scheme, auth_credential, CLIENT_ID

load_dotenv()

PROJECT_ID=os.getenv("GOOGLE_CLOUD_PROJECT")
LOCATION=os.getenv("AGENT_REGISTRY_LOCATION")

def apigee_header_provider(context):
    return {"x-api-key": CLIENT_ID}

registry = AgentRegistry(project_id=PROJECT_ID, location=LOCATION, header_provider=apigee_header_provider)

# Search Agent Registry for the Apigee MCP Server by name
mcp_servers_data = registry.list_mcp_servers(filter_str="displayName:mcp-proxy-prod")
servers_list = mcp_servers_data.get("mcpServers", [])

if servers_list:
    server_name = servers_list[0]["name"]
    mcp_toolset = registry.get_mcp_toolset(
        server_name,
        auth_scheme=auth_scheme,
        auth_credential=auth_credential
    )
else:
    # Fallback directly to the production endpoint if the registry filter returned nothing
    APIGEE_PROD_HOSTNAME = os.getenv("APIGEE_PROD_HOSTNAME")
    if not APIGEE_PROD_HOSTNAME:
        raise ValueError("APIGEE_PROD_HOSTNAME environment variable is not set")
    mcp_toolset = McpToolset(
        connection_params=StreamableHTTPConnectionParams(url=f"https://{APIGEE_PROD_HOSTNAME}/mcp"),
        auth_scheme=auth_scheme,
        auth_credential=auth_credential,
        header_provider=apigee_header_provider
    )

def get_current_time() -> str:
    """Returns the current local time for the coffee shop assistant."""
    now = datetime.now()
    return now.strftime("%A, %B %d, %Y %I:%M %p")