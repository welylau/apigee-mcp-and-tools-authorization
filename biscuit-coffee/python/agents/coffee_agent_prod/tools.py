"""MCP tools for the customer agent (coffee_agent_prod).

The transport shim, header provider and toolset builder live in the shared
`biscuit_common` module (agents/biscuit_common.py) so the customer and staff
agents cannot drift apart.
"""

from biscuit_common import (  # noqa: F401 - re-exported for compatibility
    APIGEE_PROD_HOSTNAME,
    POLICY_FAULT_STATUSES,
    PolicyFaultPassthroughTransport as _PolicyFaultPassthroughTransport,
    apigee_http_client_factory,
    get_current_time,
    make_header_provider,
    make_mcp_toolset,
)

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
    "getPaymentMethods",
    "getPaymentMethodById",
    "addPaymentMethod",
]

apigee_header_provider = make_header_provider(CLIENT_ID)

mcp_toolset = make_mcp_toolset(CLIENT_ID, tool_filter=CUSTOMER_TOOLS)
