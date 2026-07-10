# Apigee Coffee Shop Agent Demo

This repo contains demo assets to show how to use Apigee to serve and secure MCP tools for a coffee shop agent.  It uses the [Apigee MCP server](https://docs.cloud.google.com/apigee/docs/api-platform/apigee-mcp/apigee-mcp-quickstart) to expose MCP tools to an agent.  This demo is intended to be used to demonstrate the capabilities of Apigee and ADK, including tool authorization and filtering.


## Prerequisites

The demo requires the following tools:

* git
* gcloud SDK
* apigeecli
* jq
* uv (Python package manager used to run the agent)

It also requires:
* A GCP project
* An Apigee X Org & instance, with external access via an application load balancer
  * Two Apigee environments (representing dev & prod), each with corresponding environment group hostnames connected to the load balancer.
* API hub
* Agent Registry

## Setup

#### 1. Update .env

Update the project ID, Apigee environment names & environment group hostnames, plus the Agent Registry location in `.env` then source the file:
```bash
source .env
```

#### 2. Enable Agent Registry:

If not already enabed, run the following to enable Agent Registry:

```bash
gcloud services enable agentregistry.googleapis.com
```

Then enable the API hub integration with Agent Registry by following the instructions here: https://docs.cloud.google.com/apigee/docs/apihub/manage-agent-registry-integration

> [!NOTE]
> Agent Registry must be enabled in the same project as API hub.

#### 3. Deploy Apigee assets

> [!WARNING]
> This process will deploy two MCP discovery proxies into the environments you specify. If there are existing MCP proxies already deployed in those environments, you must undeploy them first to avoid conflicts.

To deploy *all* assets to Apigee, run the following:

```bash
bash ./scripts/deploy-apigee.sh
```

To skip deployment of the REST API proxies, run:

```bash
bash ./scripts/deploy-apigee.sh --no-rest
```

To skip deployment of the MCP discovery proxies, run:

```bash
bash ./scripts/deploy-apigee.sh --no-mcp
```

To skip creation of the API products, apps and developers, run:

```bash
bash ./scripts/deploy-apigee.sh --no-products
```

#### 4. Run the agent

Install dependencies and run ADK web:

```bash
cd biscuit-coffee/python/agents
gcert
uv sync
uv run adk web
```

#### 5. Test the agent

Navigate to http://localhost:8000/dev-ui in your browser.

To test the development agent (no security policies), choose `coffee_agent_dev`.

To test the production agent (with OAuth security policies), choose `coffee_agent_prod`.

The production agent should prompt you to login. You can login with username: `customer@biscuit-coffee.com`, and password: `ilovecoffee`.

## Clean Up

Run the following to remove all Apigee assets:

```bash
./scripts/undeploy-apigee.sh
```