---
name: adk-local-testing
description: Provides instructions for testing an ADK agent locally using the 'adk run' command. Use this when you need to verify agent behavior, test prompts, or debug tool-calling logic in the terminal.
---

# ADK Local Testing Skill

This skill allows the agent to execute and interact with an ADK agent in the local development environment.

## Prerequisites
* The ADK must be installed (`uv sync`).
* A virtual environment (like `uv` or `venv`) should be active.
* The agent must have a valid `agent.yaml` or `agent.py` in the target directory.

## Instructions

### 1. Initialize the Environment
Before running, ensure environment variables are loaded.
* Check for a `.env` file in `./biscuit-coffee/python/agents`.
* Command: `source .venv/bin/activate` (or equivalent).

### 2. Run the Agent
To start a terminal-based chat session with the agent, use the command belowfrom the `biscuit-coffee/python/agents` directory.
For example
```bash
adk run coffee_agent_alpha | tee agent-output.log
```
You can use the content of `agent-output.log` to see if the agent returned the expected response, or if there were any errors.