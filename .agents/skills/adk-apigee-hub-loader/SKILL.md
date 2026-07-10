---
name: adk-apigee-hub-loader
description: >-
  Guides the agent on how to add tools from Apigee API Hub to an ADK agent,
  selecting the correct Toolset (APIHubToolset for REST APIs, McpToolset for MCP services).
  Use when the user wants to integrate an ADK agent with tools listed in Apigee API Hub.
---
# ADK Apigee API Hub Tool Loader Skill

This skill helps you correctly configure tools from Apigee API Hub within an Agent Development Kit (ADK) agent. The key is to use the appropriate ADK Toolset based on the type of API or service registered in the Hub.

## When to use this skill

Use this skill when the user asks to add APIs, or MCP servers from Apigee API Hub to the coffee_agent_alpha ADK agent. You will need to generate Python code to add the tools to the agent, in the `tools.py` file in the `coffee_agent_alpha` agent. Do not modify the `coffee_agent_dev` or `coffee_agent_prod` agents unless specifically asked to do so. Ignore any local specs contained in the `api` directory. They are only there for reference and should not be used.

## How to use it

Unless the user specifically requests an MCP tool (or if they specifically ask for a REST or OpenAPI), you should look for hub entries which are REST APIs. If the user asks to add an MCP server from the hub, you should look for hub entries which are MCP servers.

You can find REST APIs listed in Apigee API Hub using the `list_apis` tool call with the `filter` argument set to `api_style.enum_values.values.id:rest`.

You can find MCP servers listed in Apigee API Hub using the `list_apis` tool call with the `filter` argument set to `api_style.enum_values.values.id:mcp-api`.

1.  **Identify the Tool Type in API Hub:**
    *   Determine if the entry in Apigee API Hub represents a:
        *   **REST API:** Typically defined by an OpenAPI Specification. These will have the style attribute set to `REST`.
        *   **MCP Tool/Server:** Specifically registered as an MCP service, likely defined by an MCP schema and crucially, should have an accessible server endpoint URL. These will have the style attribute set to `MCP`.
    *   You will need to interact with the `api-hub` MCP server to confirm the style, and necessary connection information.

2.  **Choose the Correct ADK Toolset implementation:**

    *   **For REST APIs (OpenAPI Spec): Use `APIHubToolset`**
        *   This toolset is designed to parse OpenAPI specifications and create tools for each operation.
        *   You will need to supply the `apihub_resource_name` which typically looks like `projects/<proj>/locations/<loc>/apis/<api_id>`.
        *   Because I am running in a staging environment, you will need to create a custom APIHubClient with the `root_url` set to "https://staging-apihub.sandbox.googleapis.com". This is included in the example below.
        *   Example Python code for your ADK agent:
            ```python
            from google.adk.tools.apihub_tool import APIHubToolset

            # Replace with actual values
            apihub_api_resource = "projects/your-gcp-project/locations/your-location/apis/your-api-id" # example: "projects/axahc-test-20/locations/us-central1/apis/46996f36-3ad3-491d-bb17-d1371f3b2061"
            auth_scheme = None # Specify auth if needed
            auth_credential = None # Specify auth if needed

            staging_client = APIHubClient()
            staging_client.root_url = "https://staging-apihub.us-central1.rep.sandbox.googleapis.com/v1"

            rest_api_tools = APIHubToolset(
                name="my_rest_api_from_hub",
                apihub_resource_name=apihub_api_resource,
                auth_scheme=auth_scheme,
                auth_credential=auth_credential,
                apihub_client=staging_client
                # Add other necessary params like service_account_json or access_token
            )
            # Add to agent tools: tools=[*rest_api_tools.get_tools()]
            ```

    *   **For MCP Tools/Servers: Use `McpToolset`**
        *   This toolset connects to an existing MCP server endpoint.
        *   The API Hub entry for an MCP tool MUST provide the server's connection parameters, most importantly the URL.
        *   Use `StreamableHTTPConnectionParams` and supply the `url` parameter.
        *   Set it to the endpoint URL obtained from the `Deployment` for the hub entry. Only consider Deployments where the `sourceEnvironment` is `default-dev`.If the Deployment contains multiple endpoints, use the one that ends with `/mcp`. Do not use endpoints that end with `/.well-known/oauth-protected-resource/mcp`.
        *   Example Python code for your ADK agent:
            ```python
            from google.adk.tools.mcp_tool import McpToolset
            from google.adk.tools.mcp_tool import StreamableHTTPConnectionParams

            # Extracted from API Hub entry for the MCP tool
            mcp_server_url = "https://your-mcp-server-endpoint.com/mcp" # Example URL

            mcp_tools = McpToolset(
                connection_params=StreamableHTTPConnectionParams(url=mcp_server_url),
                tool_name_prefix="my_mcp_tool_"
            )
            # Add to agent tools: tools=[*mcp_tools.get_tools()]
            ```

3.  **Construct the Code:**
    *   Based on the tool type and the information obtained, generate the appropriate Python code snippet to instantiate either `APIHubToolset` or `McpToolset` and add it to the agent's tool list.
    *   Ensure all required parameters like resource names, URLs, and authentication details are correctly included.
    *   If the agent already references existing tools for this purpose, replace them with this new tool.


**Example User Prompt:** "Add the 'Order API' from API Hub to my ADK agent."

**Agent's Thought Process:**

1.  Need to determine if 'Order API' is REST or MCP in API Hub. (How can I check this? Ask the user or use the api-hub MCP server).
2.  Assuming 'Order API' is a REST API with resource name `projects/axahc-test-20/locations/us-central1/apis/02f77579-d31c-44cb-a2fd-59e314463577`.
3.  I should use `APIHubToolset`.
4.  Generate code for `APIHubToolset` with the given resource name.

**Example User Prompt:** "Integrate the 'Notification MCP Service' listed in API Hub."

**Agent's Thought Process:**

1.  The user specified "MCP Service". I should use `McpToolset`.
2.  I need to get the MCP server endpoint URL for this service from API Hub. (query API Hub to get endpoints from Deployments in source environment `default-dev`, or ask the user if you can't find it).
3.  When querying the Deployment from the API Hub, I may see multiple endpoints within it. Ignore any endpoint URLs that end with `/.well-known/oauth-protected-resource/mcp`. The correct endpoint should look like `https://axahc-test-20-staging-dev.34-128-188-31.nip.io/mcp`.
4.  Generate code for `McpToolset` using `StreamableHTTPConnectionParams` for the `connection_params` argument, and provide this URL. Do not use `SseConnectionParams`.
