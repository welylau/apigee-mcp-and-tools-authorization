---
name: api-hub-project-locationhelper
description: Provides default project and location for the Apigee API hub MCP tool.
---
# Apigee API hub Helper Skill

## Overview

This skill enables the usage of the Apigee API hub MCP server. It provides guidance on how to use the server to lookup information from the hub MCP server, and the default values for the project and location.

## Default Values

When using the Apigee API hub MCP tool, please use the following default values unless otherwise specified in the prompt:

*   **Project ID:** `YOUR_PROJECT_ID`
*   **Location:** `YOUR_LOCATION`

## How to use it

Whenever you call the Apigee API hub tool, ensure you include the project and location parameters with the default values.

For example:

*   If the user says: "List APIs in the hub"
*   You should call the tool by supplying the parent parameter like this (plus any other optional tool inputs), for example:
    `api-hub.list_apis(parent='projects/YOUR_PROJECT_ID/locations/YOUR_LOCATION')`

*   If the user provides a project or location in the prompt, use the values from the prompt instead of these defaults. For example:
    *   User: "List APIs in project 'other-project' in 'europe-west1'"
    *   Call: `api-hub.list_apis(parent='projects/other-project/locations/europe-west1')`

Always prioritize project and location values provided directly in the current user prompt over these default values.
