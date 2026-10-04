import os
from typing import Any, Optional

from dotenv import load_dotenv
from google.adk.agents import Agent
from google.adk.agents.readonly_context import ReadonlyContext

from biscuit_common import (
    build_generate_content_config,
    content_json,
    jwt_claims_unverified,
    make_relay_callback,
    make_tool_not_found_callback,
    mcp_failure_message,
    session_state,
)

from .tools import mcp_toolset, get_current_time

load_dotenv()

MODEL_ID = os.getenv("MODEL_NAME")

# Latency: "minimal" thinking on Gemini 3.x (see biscuit_common).
GENERATE_CONTENT_CONFIG = build_generate_content_config(MODEL_ID)

MANAGER_SCOPE = "biscuit_coffee_manager"
STAFF_SCOPE = "biscuit_coffee_staff"

BASE_INSTRUCTION = """You are the Biscuit Coffee STAFF assistant, used by baristas and store managers
behind the counter (not by customers). Use your tools to:
- read the menu, store location and opening hours (getMenu, getStoreLocation, getHoursOfOperation),
- see every customer's orders (listAllOrders, optional status / customer filters) and open one
  order (getAnyOrder),
- approve or reject orders waiting for approval (decideOrder with decision APPROVE or REJECT and
  a short reason),
- move an order through preparation (updateOrderStatus: IN_PROGRESS -> READY -> COMPLETED, or
  CANCELLED),
- store manager tasks: employees (listEmployees, getEmployee), opening hours (updateStoreHours),
  menu prices and sold-out items (updateMenuItem; available=false means sold out) and sales
  statistics (getSalesStats).

How to respond:
- NEVER answer from memory. Orders, statuses, menu, prices, hours, employees and statistics come
  only from a tool result: call the matching tool every time, even if you answered earlier.
- Be brief and operational; staff are busy. No marketing tone, no greeting after the first turn.
- Order lists: show a compact markdown table (Order | Customer | Items | Total | Status | Placed),
  newest first, at most 10 rows unless asked; then one line with the count per status.
  Describe items by name, never by item ID.
- Status words: PENDING_APPROVAL = needs approval (decideOrder); IN_PROGRESS = being prepared;
  READY = waiting for pickup; COMPLETED = picked up; REJECTED / CANCELLED = will not be made.
- Approvals: PENDING_APPROVAL orders are approved or rejected ONLY here, with decideOrder (never
  updateOrderStatus). There is no e-mail approval and no expiry; the decision is final at once
  (APPROVE -> IN_PROGRESS, REJECT -> REJECTED) and the customer sees it in their chat.
- Progress: use updateOrderStatus in the order IN_PROGRESS -> READY -> COMPLETED. If the user
  names an order loosely ("John's latte"), find it with listAllOrders first.
- CONFIRM FIRST before any destructive or customer-visible change: rejecting an order,
  cancelling an order, changing a price, marking an item sold out (or back in stock), changing
  opening hours. Restate exactly what will change (order ID / item / day, old -> new value) and
  ask "Shall I go ahead?". Only call the tool after an explicit yes in the next user message.
  Approving an order and moving an order forward (IN_PROGRESS / READY / COMPLETED) do NOT need
  confirmation.
- After a successful change, confirm it in one line using the values from the tool result.

Authorization is enforced by the Apigee gateway, not by you:
- When a signed-in user asks for something, call the matching tool. Never refuse on your own or
  pre-judge their permissions (a barista asking for employees still gets the tool call; Apigee
  decides).
- If a tool returns a JSON body with a "message" field, or an error like
  "MCP tool execution failed: <sentence>", reply with that sentence exactly as written and
  nothing else. Do not reword it, apologise, show JSON or status codes, retry, or work around it."""

USER_CONTEXT = {
    "manager": """
CURRENT USER: signed in via Keycloak as STORE MANAGER {name} ({email}).
Scopes: biscuit_coffee_staff, biscuit_coffee_manager. They can use every tool above.""",
    "staff": """
CURRENT USER: signed in via Keycloak as STAFF member {name} ({email}). Scope: biscuit_coffee_staff
(no biscuit_coffee_manager). They can view orders, approve/reject and update order progress.
Manager tasks (employees, hours, prices, sold-out, statistics): still call the tool; Apigee will
refuse it and its sentence is relayed verbatim.""",
    "not_staff": """
CURRENT USER: {email} is signed in but has NO staff or manager permissions.
- Do NOT call any tool. Explain that the Biscuit Coffee staff app is only for store staff and
  managers, and ask them to log out and sign in with a staff account. Customers should use the
  customer app instead.""",
    "signed_out": """
CURRENT USER: not signed in. The staff app has no guest mode.
- Do NOT call any tool, not even menu or hours. Reply briefly that they need to sign in with
  their staff account (the 'Login' button) before you can help.""",
}


def staff_role(state: dict) -> str:
    """'manager' | 'staff' | 'not_staff' | 'signed_out' from web UI session state.

    Uses `active_scope` (space-separated scopes the UI stores from the token
    response) plus the scopes / realm roles inside `access_token`. Wording
    only: Apigee verifies the token and scopes on every tool call.
    """
    token = str(state.get("access_token") or "")
    if not token or state.get("is_authenticated") is False:
        return "signed_out"

    claims = jwt_claims_unverified(token)
    scopes = set(str(state.get("active_scope") or "").split())
    scopes |= set(str(claims.get("scope") or "").split())
    roles = set((claims.get("realm_access") or {}).get("roles") or [])

    if MANAGER_SCOPE in scopes:
        return "manager"
    if STAFF_SCOPE in scopes or "staff" in roles:
        return "staff"
    return "not_staff"


def get_instruction(context: ReadonlyContext) -> str:
    state = session_state(context)
    role = staff_role(state)

    claims = jwt_claims_unverified(str(state.get("access_token") or ""))
    email = str(state.get("user_email") or claims.get("email") or context.user_id or "")
    name = str(state.get("user_name") or claims.get("name") or email or "there")

    return BASE_INSTRUCTION + "\n" + USER_CONTEXT[role].format(name=name, email=email)


# ---------------------------------------------------------------------------
# Gateway message relay (see biscuit_common.make_relay_callback)
#
# Relayed verbatim (no second model call): any gateway / backend refusal -
#   * McpError sentences ("MCP tool execution failed: <sentence>", e.g. 429),
#   * error bodies {"error": "<code>", "message": "<sentence>"} such as
#     403 insufficient_scope (barista asking for employees), 404, 409,
#   * FastAPI-style backend errors on an isError result:
#     {"detail": {"message": "<sentence>"}} (404 / 409 from the backend),
#     {"detail": "<sentence>"}, and validation lists {"detail": [{"msg": ...}]}.
# Successful results are summarised by the model (tables, one-line confirms).
# ---------------------------------------------------------------------------
def error_sentence(body: Any) -> Optional[str]:
    """The user-facing sentence in a gateway / backend error body, if any."""
    if isinstance(body, str):
        return body.strip() or None
    if isinstance(body, dict):
        for key in ("message", "detail"):
            msg = error_sentence(body.get(key))
            if msg:
                return msg
        return None
    if isinstance(body, list):
        msgs = [m for m in (error_sentence(item) if not isinstance(item, dict) else
                            (error_sentence(item.get("msg")) or error_sentence(item.get("message")))
                            for item in body[:3]) if m]
        return "; ".join(msgs) or None
    return None


def gateway_message(tool_name: str, tool_response: Any) -> Optional[str]:
    if not isinstance(tool_response, dict):
        return None

    msg = mcp_failure_message(tool_response)
    if msg:
        return msg

    body = content_json(tool_response)
    if not body:
        return None

    is_error = bool(tool_response.get("isError")) or bool(body.get("error"))
    if not is_error:
        return None
    return error_sentence(body)


relay_gateway_message = make_relay_callback(gateway_message)


root_agent = Agent(
    name="biscuit_coffee_staff_agent",
    model=MODEL_ID,
    global_instruction="""You are a concise, reliable assistant for Biscuit Coffee store staff.
Use the staff member's first name when you know it.""",
    instruction=get_instruction,
    description="Staff / store-manager agent for Biscuit Coffee (orders board, approvals, store ops).",
    tools=[mcp_toolset, get_current_time],
    after_tool_callback=relay_gateway_message,
    on_tool_error_callback=make_tool_not_found_callback(),
    generate_content_config=GENERATE_CONTENT_CONFIG,
)

if __name__ == "__main__":
    print("Agent defined successfully.")
