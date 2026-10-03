import json
import os
import re
from typing import Any, Optional

from dotenv import load_dotenv
from google.adk.agents import Agent
from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.tool_context import ToolContext
from google.genai import types as genai_types

from .tools import mcp_toolset, get_current_time

load_dotenv()

MODEL_ID = os.getenv("MODEL_NAME")

# To route the model through an Apigee LLM proxy instead of calling Vertex AI
# directly, wrap it with google.adk.models.apigee_llm.ApigeeLlm, e.g.
#   model = ApigeeLlm(model=f"apigee/{MODEL_ID}",
#                     proxy_url=f"https://{APIGEE_HOSTNAME}{APIGEE_LLM}",
#                     custom_headers={"x-api-key": CLIENT_ID})

# ---------------------------------------------------------------------------
# Latency: Gemini 3.x thinks by default (~300-400 thought tokens, ~3.5 s per
# call) and a tool turn makes two model calls. This agent only routes simple
# tool calls, so "minimal" thinking keeps quality while cutting each call to
# ~1 s. Override with MODEL_THINKING_LEVEL=low|medium|high, or set it empty to
# use the model default. Only applied to Gemini 3.x (2.x uses thinking_budget).
# ---------------------------------------------------------------------------
THINKING_LEVEL = os.getenv("MODEL_THINKING_LEVEL", "minimal").strip().lower()
GENERATE_CONTENT_CONFIG = None
if THINKING_LEVEL and str(MODEL_ID or "").startswith("gemini-3"):
    GENERATE_CONTENT_CONFIG = genai_types.GenerateContentConfig(
        thinking_config=genai_types.ThinkingConfig(thinking_level=THINKING_LEVEL)
    )

BASE_INSTRUCTION = """You are the Biscuit Coffee customer service assistant. Use your tools to:
- show the menu, store location and opening hours (getMenu, getStoreLocation, getHoursOfOperation),
- sign customers up for loyalty rewards and check their balance (getRewardBalance),
- place, look up and cancel orders,
- let store managers list employees (listEmployees).

How to respond:
- NEVER answer from memory. Menu items, prices, store location, hours, rewards, orders and staff
  come only from a tool result: call the matching tool on every such question, even if you
  answered it earlier in the conversation. You know nothing about Biscuit Coffee without tools.
- Greet the user once at the start of the conversation.
- Menu: summarise the getMenu result in at most 6 short bullets. Give sizes and prices only when
  asked or when the user asks about a specific drink.
- Orders can be placed or looked up by loyalty ID, email address, or first name + last initial.
  Describe order items by name, never by item ID.
- Keep replies short. End with "Is there anything else I can help you with?"

Authorization is enforced by the Apigee gateway, not by you:
- When a logged-in user asks for something, call the matching tool. Never refuse on your own
  or pre-judge their permissions.
- If a tool returns a JSON body with a "message" field, or an error like
  "MCP tool execution failed: <sentence>", reply with that sentence exactly as written and
  nothing else. Do not reword it, add an apology, show JSON or status codes, call it a
  technical issue, retry, or work around the rule (e.g. by splitting an order).
- For "order_not_found", never speculate about why, and never suggest the order may belong to
  someone else.
- When an order succeeds, include the tool's confirmation "message" exactly as written and do
  not restate the price or order ID yourself."""

USER_CONTEXT = {
    "manager": """
CURRENT USER: logged in via Keycloak as STORE MANAGER {name} ({email}).
Scopes: biscuit_coffee_customer, biscuit_coffee_manager.
- Use listEmployees for staff questions.
- For rewards and order lookups, pass '{email}' as the email; never ask for it.""",
    "customer": """
CURRENT USER: logged in via Keycloak as CUSTOMER {name} ({email}). Scope: biscuit_coffee_customer.
- For rewards and order lookups, pass '{email}' as the email; never ask for it.
- Staff / employee questions: you MUST still call listEmployees (Apigee decides). Only if it
  returns a permission, scope or forbidden error, reply: "I'm sorry, {first}, but viewing store
  employee information requires Store Manager permissions (biscuit_coffee_manager). Your current
  account is authenticated as a Customer ({email}). Please log out first using the 'Logout'
  button on the left panel, and then log in with Store Manager credentials
  (manager@biscuit-coffee.com).\"""",
    "guest": """
CURRENT USER: guest, not logged in.
- Menu, location and hours: use the public tools directly; do not ask them to log in.
- Orders, order lookups and loyalty rewards: do NOT call a tool. Politely explain that this
  requires signing in and invite them to click the 'Login' button.
- Staff / employee questions: do NOT call a tool. Explain that employee records require Store
  Manager authorization (biscuit_coffee_manager) and invite them to log in with
  manager@biscuit-coffee.com.""",
}

DEFAULT_NAMES = {"manager": "Alice", "customer2": "Michael Bosh", "customer": "John Smith"}


def get_instruction(context: ReadonlyContext) -> str:
    state = context.session.state or {}
    email = str(state.get("user_email") or context.user_id or "")
    is_guest = not email or email.startswith("guest") or "guest@" in email
    role = "guest" if is_guest else ("manager" if "manager" in email else "customer")

    name = state.get("user_name")
    if not name:
        name = next((n for key, n in DEFAULT_NAMES.items() if key in email), "Valued Customer")
    first = str(name).split()[0]

    return BASE_INSTRUCTION + "\n" + USER_CONTEXT[role].format(name=name, first=first, email=email)


# ---------------------------------------------------------------------------
# Gateway message relay (latency + exact wording)
#
# Apigee owns the customer-facing wording for its business rules. When a tool
# result carries one of those sentences, end the turn with it directly:
#   * skip_summarization=True -> ADK does NOT make a second model call
#     (saves ~1-2.5 s) and the wording can never be paraphrased.
#   * The original tool response is kept intact (the web UI classifies it to
#     render the tool card); only a `relay_message` field is added, which the
#     UI shows as the reply text.
#
# Relayed:  422 order_limit_exceeded, 404 order_not_found, 429 quota (arrives as
#           "MCP tool execution failed: <sentence>"), successful order confirmation.
# Not relayed: 403 insufficient scope - the model adds the manager-login guidance.
# ---------------------------------------------------------------------------
RELAY_CODES = {"order_limit_exceeded", "order_not_found"}
_TRANSPORT_CRASH = re.compile(r"TaskGroup|connection lost|ConnectionError", re.I)
_MCP_FAILED = "MCP tool execution failed:"


def _content_json(tool_response: dict) -> Optional[dict]:
    for part in tool_response.get("content") or []:
        text = part.get("text") if isinstance(part, dict) else None
        if not text:
            continue
        try:
            body = json.loads(text)
        except (TypeError, ValueError):
            continue
        if isinstance(body, dict):
            return body
    return None


def gateway_message(tool_name: str, tool_response: Any) -> Optional[str]:
    if not isinstance(tool_response, dict):
        return None

    # 429: McpError raised from the JSON-RPC error body (see tools.py transport shim).
    err = tool_response.get("error")
    if isinstance(err, str) and err.startswith(_MCP_FAILED) and not _TRANSPORT_CRASH.search(err):
        msg = err[len(_MCP_FAILED):].strip()
        return msg or None

    body = _content_json(tool_response)
    if not body or not isinstance(body.get("message"), str):
        return None

    # 422 / 404: {"error": "<code>", "message": "<sentence>"}
    if body.get("error") in RELAY_CODES:
        return body["message"]

    # Successful order: {"order_id": "...", "message": "Your order is confirmed. ..."}
    if tool_name == "placeOrder" and body.get("order_id") and not tool_response.get("isError"):
        return body["message"]
    return None


def relay_gateway_message(
    tool: BaseTool, args: dict, tool_context: ToolContext, tool_response: Any
) -> Optional[dict]:
    msg = gateway_message(tool.name, tool_response)
    if not msg:
        return None  # normal path: the model writes the reply
    tool_context.actions.skip_summarization = True
    return {**tool_response, "relay_message": msg}


root_agent = Agent(
    name="biscuit_coffee_agent",
    model=MODEL_ID,
    global_instruction="""You are a helpful, polite virtual assistant for the Biscuit Coffee shop.
Use the customer's first name when you know it.""",
    instruction=get_instruction,
    description="An online agent for Biscuit Coffee.",
    tools=[mcp_toolset, get_current_time],
    after_tool_callback=relay_gateway_message,
    generate_content_config=GENERATE_CONTENT_CONFIG,
)

if __name__ == "__main__":
    print("Agent defined successfully.")