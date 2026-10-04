"""MCP tools for the staff agent (coffee_agent_staff)."""

from biscuit_common import get_current_time, make_mcp_toolset  # noqa: F401 - get_current_time used by agent.py

from .auth_config import CLIENT_ID

# Staff allow-list (= the `biscuit-coffee-staff` API product operations).
# Manager-only tools (listEmployees, getEmployee, updateStoreHours,
# updateMenuItem, getSalesStats) are exposed to normal staff too on purpose:
# Apigee decides, and its 403 sentence is relayed verbatim. Tools the gateway
# has not published yet are simply absent from tools/list.
STAFF_TOOLS = [
    "getStoreLocation",
    "getHoursOfOperation",
    "getMenu",
    "listAllOrders",
    "getAnyOrder",
    "updateOrderStatus",
    "decideOrder",
    "listEmployees",
    "getEmployee",
    "updateStoreHours",
    "updateMenuItem",
    "getSalesStats",
]

mcp_toolset = make_mcp_toolset(CLIENT_ID, tool_filter=STAFF_TOOLS)
