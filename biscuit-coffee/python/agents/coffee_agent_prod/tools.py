"""MCP tools for the customer agent (coffee_agent_prod).

The transport shim, header provider and toolset builder live in the shared
`biscuit_common` module (agents/biscuit_common.py) so the customer and staff
agents cannot drift apart.
"""

from biscuit_common import get_current_time, make_mcp_toolset  # noqa: F401 - get_current_time used by agent.py

from .auth_config import CLIENT_ID

# Customer allow-list. Staff / manager tools (listEmployees, listAllOrders,
# decideOrder, updateMenuItem, ...) are never exposed to the customer agent;
# they belong to coffee_agent_staff. Apigee still enforces the API product.
CUSTOMER_TOOLS = [
    "getStoreLocation",
    "getHoursOfOperation",
    "getMenu",
    "getOrder",
    "placeOrder",
    "cancelOrder",
    "listOrders",
    "signUpLoyalty",
    "getRewardBalance",
]

mcp_toolset = make_mcp_toolset(CLIENT_ID, tool_filter=CUSTOMER_TOOLS)
