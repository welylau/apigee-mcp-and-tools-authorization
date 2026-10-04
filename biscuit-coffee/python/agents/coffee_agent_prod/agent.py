import json
import logging
import os
import re
from collections import OrderedDict
from typing import Any, Optional

from dotenv import load_dotenv
from google.adk.agents import Agent
from google.adk.agents.callback_context import CallbackContext
from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.models.llm_response import LlmResponse
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.tool_context import ToolContext
from google.genai import types as genai_types

from biscuit_common import (
    build_generate_content_config,
    content_json,
    make_relay_callback,
    make_tool_not_found_callback,
    mcp_failure_message,
)

from .tools import mcp_toolset, get_current_time

load_dotenv()

logger = logging.getLogger(__name__)

MODEL_ID = os.getenv("MODEL_NAME")

# To route the model through an Apigee LLM proxy instead of calling Vertex AI
# directly, wrap it with google.adk.models.apigee_llm.ApigeeLlm, e.g.
#   model = ApigeeLlm(model=f"apigee/{MODEL_ID}",
#                     proxy_url=f"https://{APIGEE_HOSTNAME}{APIGEE_LLM}",
#                     custom_headers={"x-api-key": CLIENT_ID})

# Latency: "minimal" thinking on Gemini 3.x (see biscuit_common).
GENERATE_CONTENT_CONFIG = build_generate_content_config(MODEL_ID)

BASE_INSTRUCTION = """You are the Biscuit Coffee customer service assistant. Use your tools to:
- show the menu, store location and opening hours (getMenu, getStoreLocation, getHoursOfOperation),
- sign customers up for loyalty rewards and check their balance (getRewardBalance),
- place, look up and cancel orders.

How to respond:
- NEVER answer from memory. Menu items, prices, store location, hours, rewards and orders
  come only from a tool result: call the matching tool on every such question, even if you
  answered it earlier in the conversation. You know nothing about Biscuit Coffee without tools.
- Greet the user once at the start of the conversation.
- Menu: summarise the getMenu result in at most 6 short bullets. Give sizes and prices only when
  asked or when the user asks about a specific drink.
- Orders can be placed or looked up by loyalty ID, email address, or first name + last initial.
  Describe order items by name, never by item ID.
- Keep replies short. End with "Is there anything else I can help you with?"
- This is the customer app. Staff, employee and store-management questions are not handled
  here: politely say so (store staff use the separate Biscuit Coffee staff app).

Authorization is enforced by the Apigee gateway, not by you:
- When a logged-in user asks for something, call the matching tool. Never refuse on your own
  or pre-judge their permissions.
- If a tool returns a JSON body with a "message" field, or an error like
  "MCP tool execution failed: <sentence>", reply with that sentence exactly as written and
  nothing else. Do not reword it, add an apology, show JSON or status codes, call it a
  technical issue, retry, or work around the rule (e.g. by splitting an order).
- For "order_not_found", never speculate about why, and never suggest the order may belong to
  someone else.
- EVERY new order request MUST call placeOrder, even if it looks like an earlier order in this
  conversation. Never repeat or reuse an earlier confirmation, order ID or total: each order
  gets its own ID and price from the tool.
- When an order succeeds, include the tool's confirmation "message" exactly as written and do
  not restate the price or order ID yourself.
- Some larger orders need the store team's approval; the confirmation message says so. The store
  team reviews them in the Biscuit Coffee staff app, and the order status in this chat updates as
  soon as they approve or reject it. Do not try to avoid approval (e.g. by splitting the order),
  do not mention e-mail, and do not promise when it will be decided.
- When looking up an order, explain its status in plain words: PENDING_APPROVAL = waiting for the
  store team to review it in the staff app; REJECTED = the store did not approve it, so it will not be made;
  IN_PROGRESS = being prepared; READY = ready for pickup; COMPLETED = picked up."""

USER_CONTEXT = {
    "customer": """
CURRENT USER: logged in via Keycloak as CUSTOMER {name} ({email}). Scope: biscuit_coffee_customer.
- For rewards and order lookups, pass '{email}' as the email; never ask for it.""",
    "guest": """
CURRENT USER: guest, not logged in.
- Menu, location and hours: use the public tools directly; do not ask them to log in.
- Orders, order lookups and loyalty rewards: do NOT call a tool. Politely explain that this
  requires signing in and invite them to click the 'Login' button.""",
}

DEFAULT_NAMES = {"customer2": "Michael Bosh", "customer": "John Smith"}


def get_instruction(context: ReadonlyContext) -> str:
    state = context.session.state or {}
    email = str(state.get("user_email") or context.user_id or "")
    is_guest = not email or email.startswith("guest") or "guest@" in email
    # Store managers / staff are refused by the customer UI and use
    # coffee_agent_staff, so every signed-in user here is a customer.
    role = "guest" if is_guest else "customer"

    name = state.get("user_name")
    if not name:
        name = next((n for key, n in DEFAULT_NAMES.items() if key in email), "Valued Customer")
    first = str(name).split()[0]

    return BASE_INSTRUCTION + "\n" + USER_CONTEXT[role].format(name=name, first=first, email=email)


# ---------------------------------------------------------------------------
# Gateway message relay (see biscuit_common.make_relay_callback)
#
# Relayed:  422 order_limit_exceeded, 404 order_not_found, 429 quota (arrives as
#           "MCP tool execution failed: <sentence>"), successful order confirmation.
# Not relayed: anything else - the model writes the reply.
# ---------------------------------------------------------------------------
RELAY_CODES = {"order_limit_exceeded", "order_not_found"}


def gateway_message(tool_name: str, tool_response: Any) -> Optional[str]:
    if not isinstance(tool_response, dict):
        return None

    # 429: McpError raised from the JSON-RPC error body (see biscuit_common transport shim).
    msg = mcp_failure_message(tool_response)
    if msg:
        return msg

    body = content_json(tool_response)
    if not body or not isinstance(body.get("message"), str):
        return None

    # 422 / 404: {"error": "<code>", "message": "<sentence>"}
    if body.get("error") in RELAY_CODES:
        return body["message"]

    # Successful order: {"order_id": "...", "message": "Your order is confirmed. ..."}
    if tool_name == "placeOrder" and body.get("order_id") and not tool_response.get("isError"):
        return body["message"]
    return None


relay_gateway_message = make_relay_callback(gateway_message)


# ---------------------------------------------------------------------------
# Fake-confirmation guard
#
# A real order confirmation never comes from the model: it is Apigee's sentence,
# relayed straight from the placeOrder result (skip_summarization). That
# sentence sits in the chat history, so on a similar follow-up ("12 large
# cappuccinos" after "11 large cappuccinos") the model can copy it WITHOUT
# calling placeOrder - showing an order ID and total that do not exist.
#
# How it works:
#   * after_tool_callback (record_tool_result) writes a per-invocation record
#     into `temp:` session state: whether a placeOrder SUCCEEDED this turn
#     (order_id present, not isError), whether an order lookup ran, and every
#     order-id-like number seen in this turn's tool results. `temp:` keys are
#     never persisted, and the record also carries the invocation id.
#   * after_model_callback (block_fake_order_confirmation): if model-written
#     text claims an order was placed/confirmed, it is allowed only when a
#     placeOrder succeeded or an order lookup ran this turn, AND every order
#     id the text mentions came from a tool result of this turn. Otherwise the
#     text is replaced with an honest reply.
#   * Streamed (partial) chunks are buffered per invocation in a small bounded
#     cache and suppressed once the claim appears.
# ---------------------------------------------------------------------------
FAKE_CONFIRMATION = re.compile(
    r"order (?:is|was|has been) (?:now )?(?:confirmed|placed|submitted|created)"
    r"|has been placed"
    r"|(?:i|we)(?:'ve| have)? (?:just |now |successfully )?(?:placed|submitted|created|put in)"
    r" (?:your|the|an?|this) (?:new )?order"
    r"|order\s*(?:id|number|no\.?|#)\s*(?:is|:|=)?\s*\**\s*#?\d"
    r"|order\s+#\s*\d"
    r"|#\d{4,}\**\s+(?:is\s+)?(?:confirmed|placed)"
    r"|(?:now|is) pending approval",
    re.I,
)
ORDER_ID_IN_TEXT = re.compile(r"(?<![\d.$])#?(\d{4,6})(?!\d|\.\d)")
ORDER_LOOKUP_TOOLS = {"getOrder", "listOrders", "cancelOrder"}
GUARD_STATE_KEY = "temp:order_guard"
FAKE_CONFIRMATION_REPLY = (
    "Sorry, I couldn't place that order just now - no order was created. "
    "Please ask me again and I'll place it for you."
)

PARTIAL_CACHE_MAX = 256
_partial_text: "OrderedDict[str, str]" = OrderedDict()


def _is_successful_order(tool_response: Any) -> bool:
    if not isinstance(tool_response, dict) or tool_response.get("isError"):
        return False
    if mcp_failure_message(tool_response) or tool_response.get("error"):
        return False
    body = content_json(tool_response) or {}
    return bool(body.get("order_id")) and not body.get("error")


def record_tool_result(tool: BaseTool, tool_context: ToolContext, tool_response: Any) -> None:
    """Remember what this turn's tools returned (for the guard)."""
    inv_id = tool_context.invocation_id
    rec = tool_context.state.get(GUARD_STATE_KEY)
    if not isinstance(rec, dict) or rec.get("inv") != inv_id:
        rec = {"inv": inv_id, "placed": False, "lookup": False, "ids": []}
    else:
        rec = {**rec, "ids": list(rec.get("ids") or [])}
    if tool.name == "placeOrder" and _is_successful_order(tool_response):
        rec["placed"] = True
    if tool.name in ORDER_LOOKUP_TOOLS:
        rec["lookup"] = True
    try:
        blob = json.dumps(tool_response, default=str)
    except (TypeError, ValueError):
        blob = str(tool_response)
    rec["ids"] = sorted(set(rec["ids"]) | set(ORDER_ID_IN_TEXT.findall(blob)))[:500]
    tool_context.state[GUARD_STATE_KEY] = rec


def after_tool(
    tool: BaseTool, args: dict, tool_context: ToolContext, tool_response: Any
) -> Optional[dict]:
    """after_tool_callback: record for the guard, then the gateway relay."""
    try:
        record_tool_result(tool, tool_context, tool_response)
    except Exception:  # noqa: BLE001 - the guard must never break a tool call
        logger.exception("order guard: could not record tool result")
    return relay_gateway_message(tool, args, tool_context, tool_response)


def _guard_record(callback_context: CallbackContext) -> dict:
    rec = callback_context.state.get(GUARD_STATE_KEY)
    if isinstance(rec, dict) and rec.get("inv") == callback_context.invocation_id:
        return rec
    return {}


def claim_is_backed(text: str, rec: dict) -> bool:
    """True when an order claim in `text` is backed by this turn's tool results."""
    if not (rec.get("placed") or rec.get("lookup")):
        return False
    mentioned = set(ORDER_ID_IN_TEXT.findall(text))
    return mentioned <= set(rec.get("ids") or [])


def _text_of(llm_response: LlmResponse) -> str:
    parts = (llm_response.content.parts if llm_response.content else None) or []
    if any(p.function_call for p in parts):
        return ""  # a tool call is coming - nothing to judge yet
    return "".join(p.text for p in parts if p.text and not p.thought)


def _buffer_partial(inv_id: str, text: str) -> str:
    seen = _partial_text.pop(inv_id, "") + text
    _partial_text[inv_id] = seen[-4000:]
    while len(_partial_text) > PARTIAL_CACHE_MAX:
        _partial_text.popitem(last=False)  # drop the oldest (e.g. aborted streams)
    return seen


def block_fake_order_confirmation(
    callback_context: CallbackContext, llm_response: LlmResponse
) -> Optional[LlmResponse]:
    inv_id = callback_context.invocation_id
    text = _text_of(llm_response)
    if llm_response.partial:
        text = _buffer_partial(inv_id, text)
    else:
        _partial_text.pop(inv_id, None)

    if not text or not FAKE_CONFIRMATION.search(text):
        return None
    if claim_is_backed(text, _guard_record(callback_context)):
        return None

    if llm_response.partial:
        # Stop streaming the fake sentence; the final response is replaced below.
        return LlmResponse(
            content=genai_types.Content(role="model", parts=[genai_types.Part(text="")]),
            partial=True,
        )
    logger.warning("Blocked an order confirmation not backed by a tool result: %r", text[:200])
    return LlmResponse(
        content=genai_types.Content(role="model", parts=[genai_types.Part(text=FAKE_CONFIRMATION_REPLY)])
    )


root_agent = Agent(
    name="biscuit_coffee_agent",
    model=MODEL_ID,
    global_instruction="""You are a helpful, polite virtual assistant for the Biscuit Coffee shop.
Use the customer's first name when you know it.""",
    instruction=get_instruction,
    description="An online agent for Biscuit Coffee.",
    tools=[mcp_toolset, get_current_time],
    after_tool_callback=after_tool,
    after_model_callback=block_fake_order_confirmation,
    on_tool_error_callback=make_tool_not_found_callback(),
    generate_content_config=GENERATE_CONTENT_CONFIG,
)

if __name__ == "__main__":
    print("Agent defined successfully.")