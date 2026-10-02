import logging
import os
from dotenv import load_dotenv
from datetime import datetime

import httpx
from google.adk.tools.mcp_tool import McpToolset, StreamableHTTPConnectionParams
from .auth_config import CLIENT_ID

load_dotenv()

logger = logging.getLogger(__name__)

APIGEE_PROD_HOSTNAME = os.getenv("APIGEE_PROD_HOSTNAME") or "prod.apigee-demo.com"
if not APIGEE_PROD_HOSTNAME or APIGEE_PROD_HOSTNAME.startswith("@"):
    APIGEE_PROD_HOSTNAME = "prod.apigee-demo.com"

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


class _PolicyFaultPassthroughTransport(httpx.AsyncBaseTransport):
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

        return response

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
        "transport": _PolicyFaultPassthroughTransport(httpx.AsyncHTTPTransport()),
    }
    if headers is not None:
        kwargs["headers"] = headers
    if auth is not None:
        kwargs["auth"] = auth
    return httpx.AsyncClient(**kwargs)


def apigee_header_provider(context):
    headers = {"x-api-key": CLIENT_ID}
    if context and hasattr(context, "session") and context.session:
        state = context.session.state or {}
        token = state.get("access_token")
        if token:
            headers["Authorization"] = f"Bearer {token}"
    return headers

mcp_toolset = McpToolset(
    connection_params=StreamableHTTPConnectionParams(
        url=f"https://{APIGEE_PROD_HOSTNAME}/mcp",
        headers={"x-api-key": CLIENT_ID},
        httpx_client_factory=apigee_http_client_factory,
    ),
    header_provider=apigee_header_provider
)

def get_current_time() -> str:
    """Returns the current local time for the coffee shop assistant."""
    now = datetime.now()
    return now.strftime("%A, %B %d, %Y %I:%M %p")
