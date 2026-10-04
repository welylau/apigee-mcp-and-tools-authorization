"""Helpers shared by the Biscuit Coffee ADK agents (customer + staff).

This is deliberately a single top-level *module file*, not a package folder:
`adk web .` lists every non-hidden sub-directory of the agents dir as an app,
so a `common/` folder would show up in /list-apps. A plain .py file is never
listed, and the ADK agent loader puts the agents dir on sys.path, so the agent
packages can simply `import biscuit_common`.
"""

import base64
import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone, tzinfo
from typing import Any, Callable, Iterable, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from dotenv import load_dotenv
from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.mcp_tool import McpToolset, StreamableHTTPConnectionParams
from google.adk.tools.tool_context import ToolContext
from google.genai import types as genai_types

load_dotenv()

logger = logging.getLogger(__name__)

APIGEE_PROD_HOSTNAME = os.getenv("APIGEE_PROD_HOSTNAME") or "prod.apigee-demo.com"
if not APIGEE_PROD_HOSTNAME or APIGEE_PROD_HOSTNAME.startswith("@"):
    APIGEE_PROD_HOSTNAME = "prod.apigee-demo.com"

MCP_URL = f"https://{APIGEE_PROD_HOSTNAME}/mcp"


# ---------------------------------------------------------------------------
# Model config
#
# Latency: Gemini 3.x thinks by default (~300-400 thought tokens, ~3.5 s per
# call) and a tool turn makes two model calls. These agents only route simple
# tool calls, so "minimal" thinking keeps quality while cutting each call to
# ~1 s. Override with MODEL_THINKING_LEVEL=low|medium|high, or set it empty to
# use the model default. Only applied to Gemini 3.x (2.x uses thinking_budget).
# ---------------------------------------------------------------------------
def build_generate_content_config(model_id: Optional[str]):
    thinking_level = os.getenv("MODEL_THINKING_LEVEL", "minimal").strip().lower()
    if thinking_level and str(model_id or "").startswith("gemini-3"):
        return genai_types.GenerateContentConfig(
            thinking_config=genai_types.ThinkingConfig(thinking_level=thinking_level)
        )
    return None


# --------------------------------------------------------------------------
# Apigee policy-fault passthrough
#
# Apigee enforces the per-tool quota at the gateway and replies with a real
# HTTP 429 whose body is a well-formed JSON-RPC 2.0 error carrying a
# customer-ready message (see apiproxy/.../RF-Quota-Exceeded.xml).
#
# The MCP SDK, however, calls `response.raise_for_status()` in
# `_handle_post_request` *before* it looks at the body. Any non-2xx therefore
# aborts at the transport layer: the JSON-RPC payload is discarded, the session
# TaskGroup crashes, and ADK only surfaces a bare
# "MCP session connection lost" ConnectionError. The model never learns that it
# was rate limited, so it improvises something like "a temporary technical
# issue".
#
# The transport below re-labels those specific responses as 200 *locally*, so
# the SDK parses the JSON-RPC error and raises McpError with the gateway's own
# message. ADK then hands that message to the model verbatim.
#
# The real 429 is still what Apigee returns and records - this only changes how
# this client reads it. The body is streamed through untouched.
# --------------------------------------------------------------------------

# Statuses that Apigee uses for policy rejections carrying a JSON-RPC body.
POLICY_FAULT_STATUSES = frozenset({429})

# Gateway access denials (Apigee fault body, not JSON-RPC) on tools/call.
POLICY_DENIAL_STATUSES = frozenset({401, 403})
DENIED_MESSAGE = "This operation is not available to your account."


class PolicyFaultPassthroughTransport(httpx.AsyncBaseTransport):
    """Lets JSON-RPC error bodies survive non-2xx gateway responses."""

    def __init__(self, inner: httpx.AsyncBaseTransport):
        self._inner = inner

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        response = await self._inner.handle_async_request(request)

        content_type = response.headers.get("content-type", "").lower()
        if (
            response.status_code in POLICY_FAULT_STATUSES
            and content_type.startswith("application/json")
        ):
            logger.info(
                "Relabelling HTTP %s from %s as 200 so the JSON-RPC error body "
                "reaches the agent (gateway still returned %s).",
                response.status_code,
                request.url,
                response.status_code,
            )
            # Reuse the original stream: the body is never buffered here.
            return httpx.Response(
                200,
                headers=response.headers,
                stream=response.stream,
                extensions=response.extensions,
                request=request,
            )

        return await self._denial_as_tool_result(request, response)

    async def _denial_as_tool_result(
        self, request: httpx.Request, response: httpx.Response
    ) -> httpx.Response:
        """Gateway 401/403 on a tools/call -> an isError tool result (HTTP 200 locally).

        Apigee rejects tools/call for an operation the app's API product does
        not include with HTTP 401 (oauth.v2.InvalidApiKeyForGivenResource) and
        an Apigee fault body, not JSON-RPC. Like the 429 case, the MCP SDK's
        raise_for_status() would crash the whole MCP session (TaskGroup
        error) and the model would only see "connection lost". Here such a
        response is rewritten into the same shape the prod proxy uses for 403
        insufficient_scope: {"error": "...", "message": "<sentence>"} inside
        an isError tool result, so the relay callbacks / model handle it and
        the session stays usable. initialize / tools/list failures (real
        misconfiguration) are left untouched.
        """
        if response.status_code not in POLICY_DENIAL_STATUSES:
            return response
        try:
            rpc = json.loads(request.content or b"{}")
        except (ValueError, httpx.RequestNotRead):
            return response
        if not isinstance(rpc, dict) or rpc.get("method") != "tools/call":
            return response

        raw = await response.aread()
        await response.aclose()
        message = DENIED_MESSAGE
        error_code = "access_denied"
        try:
            body = json.loads(raw)
            if isinstance(body, dict):
                if "jsonrpc" in body:  # already JSON-RPC: just let the SDK parse it
                    return httpx.Response(200, headers=response.headers, content=raw, request=request)
                if isinstance(body.get("message"), str) and body["message"].strip():
                    message = body["message"].strip()
                if isinstance(body.get("error"), str):
                    error_code = body["error"]
        except ValueError:
            pass

        logger.info(
            "Gateway denied tools/call %s with HTTP %s; returning it to the agent as a tool error.",
            (rpc.get("params") or {}).get("name"),
            response.status_code,
        )
        result = {
            "jsonrpc": "2.0",
            "id": rpc.get("id"),
            "result": {
                "content": [
                    {"type": "text", "text": json.dumps({"error": error_code, "message": message})}
                ],
                "isError": True,
            },
        }
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            content=json.dumps(result).encode(),
            request=request,
        )

    async def __aenter__(self):
        await self._inner.__aenter__()
        return self

    async def __aexit__(self, *exc_info):
        await self._inner.__aexit__(*exc_info)

    async def aclose(self):
        await self._inner.aclose()


def apigee_http_client_factory(
    headers: dict | None = None,
    timeout: httpx.Timeout | None = None,
    auth: httpx.Auth | None = None,
) -> httpx.AsyncClient:
    """Build the MCP HTTP client with the policy-fault passthrough installed.

    Mirrors the defaults of `mcp.shared._httpx_utils.create_mcp_http_client`
    (follow_redirects on, 30s connect / 300s read) and matches the
    McpHttpClientFactory protocol ADK expects.
    """
    kwargs = {
        "follow_redirects": True,
        "timeout": timeout or httpx.Timeout(30.0, read=300.0),
        "transport": PolicyFaultPassthroughTransport(httpx.AsyncHTTPTransport()),
    }
    if headers is not None:
        kwargs["headers"] = headers
    if auth is not None:
        kwargs["auth"] = auth
    return httpx.AsyncClient(**kwargs)


# ---------------------------------------------------------------------------
# Auth headers + MCP toolset
#
# x-api-key = the Keycloak client id of the calling app (Apigee VerifyAPIKey
# matches it against the token's azp). Bearer = the signed-in user's Keycloak
# access token, put into session state by the web UI on every /run.
# ---------------------------------------------------------------------------
def make_header_provider(api_key: str) -> Callable[[Any], dict]:
    def header_provider(context):
        headers = {"x-api-key": api_key}
        if context and hasattr(context, "session") and context.session:
            state = context.session.state or {}
            token = state.get("access_token")
            if token:
                headers["Authorization"] = f"Bearer {token}"
        return headers

    return header_provider


def make_mcp_toolset(api_key: str, tool_filter: Optional[Iterable[str]] = None) -> McpToolset:
    """MCP toolset for the Apigee prod MCP endpoint.

    `tool_filter` is an allow-list of MCP tool names. Names the gateway does
    not (yet) publish in tools/list are simply absent - nothing fails.
    """
    return McpToolset(
        connection_params=StreamableHTTPConnectionParams(
            url=MCP_URL,
            headers={"x-api-key": api_key},
            httpx_client_factory=apigee_http_client_factory,
        ),
        header_provider=make_header_provider(api_key),
        tool_filter=list(tool_filter) if tool_filter is not None else None,
    )


STORE_TIMEZONE_DEFAULT = "Asia/Singapore"
# Used only if the container has no IANA tz database (Singapore has no DST).
_FALLBACK_TZ = timezone(timedelta(hours=8))


def _store_tz() -> tuple[tzinfo, str]:
    name = (os.getenv("STORE_TIMEZONE") or STORE_TIMEZONE_DEFAULT).strip()
    for candidate in (name, STORE_TIMEZONE_DEFAULT):
        try:
            return ZoneInfo(candidate), candidate
        except (ZoneInfoNotFoundError, ValueError):
            logger.warning("Time zone %r not available", candidate)
    return _FALLBACK_TZ, STORE_TIMEZONE_DEFAULT


def get_current_time() -> str:
    """Returns the current local time at the Biscuit Coffee store (store time zone)."""
    tz, label = _store_tz()
    now = datetime.now(tz)
    offset = now.strftime("%z")
    return f"{now.strftime('%A, %B %d, %Y %I:%M %p')} (store time, {label}, UTC{offset[:3]}:{offset[3:]})"


# ---------------------------------------------------------------------------
# Session state helpers
# ---------------------------------------------------------------------------
def jwt_claims_unverified(token: str) -> dict:
    """Decode a JWT payload WITHOUT verifying it.

    Only used to word the agent's instructions (e.g. manager vs staff).
    Never an authorization decision: Apigee verifies the token on every call.
    """
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
        return claims if isinstance(claims, dict) else {}
    except Exception:  # noqa: BLE001 - malformed token -> no claims
        return {}


def session_state(context: ReadonlyContext) -> dict:
    return dict(context.session.state or {}) if context and context.session else {}


# ---------------------------------------------------------------------------
# Gateway message relay (latency + exact wording)
#
# Apigee owns the user-facing wording for its business rules. When a tool
# result carries one of those sentences, end the turn with it directly:
#   * skip_summarization=True -> ADK does NOT make a second model call
#     (saves ~1-2.5 s) and the wording can never be paraphrased.
#   * The original tool response is kept intact (the web UI classifies it to
#     render the tool card); only a `relay_message` field is added, which the
#     UI shows as the reply text.
# ---------------------------------------------------------------------------
_TRANSPORT_CRASH = re.compile(r"TaskGroup|connection lost|ConnectionError", re.I)
MCP_FAILED = "MCP tool execution failed:"


def content_json(tool_response: dict) -> Optional[dict]:
    """First JSON object found in an MCP tool result's text content."""
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


def mcp_failure_message(tool_response: Any) -> Optional[str]:
    """Gateway sentence from an McpError (e.g. 429 quota), else None."""
    if not isinstance(tool_response, dict):
        return None
    err = tool_response.get("error")
    if isinstance(err, str) and err.startswith(MCP_FAILED) and not _TRANSPORT_CRASH.search(err):
        msg = err[len(MCP_FAILED):].strip()
        return msg or None
    return None


def make_relay_callback(message_fn: Callable[[str, Any], Optional[str]]):
    """Build an after_tool_callback that relays `message_fn`'s sentence verbatim."""

    def relay_gateway_message(
        tool: BaseTool, args: dict, tool_context: ToolContext, tool_response: Any
    ) -> Optional[dict]:
        msg = message_fn(tool.name, tool_response)
        if not msg:
            return None  # normal path: the model writes the reply
        tool_context.actions.skip_summarization = True
        return {**tool_response, "relay_message": msg}

    return relay_gateway_message


# ---------------------------------------------------------------------------
# Unknown tool guard
#
# If the MCP toolset cannot connect (gateway down, API key not provisioned,
# 401 on tools/list), ADK continues with no MCP tools. Gemini may still emit a
# call to e.g. getMenu; ADK then raises "Tool 'getMenu' not found." and /run
# answers HTTP 500. This on_tool_error_callback turns that into a short reply
# (no second model call). Any other tool error is left to ADK (returns None).
# ---------------------------------------------------------------------------
TOOL_UNAVAILABLE_MESSAGE = (
    "Sorry, I can't reach the Biscuit Coffee store system right now. Please try again in a moment."
)


def make_tool_not_found_callback(message: str = TOOL_UNAVAILABLE_MESSAGE):
    def on_tool_error(
        tool: BaseTool, args: dict, tool_context: ToolContext, error: Exception
    ) -> Optional[dict]:
        text = str(error)
        if not (isinstance(error, ValueError) and text.startswith("Tool '") and "not found" in text):
            return None
        logger.warning("Model called unavailable tool %r: %s", getattr(tool, "name", "?"), error)
        tool_context.actions.skip_summarization = True
        return {"error": "tool_unavailable", "message": message, "relay_message": message}

    return on_tool_error
