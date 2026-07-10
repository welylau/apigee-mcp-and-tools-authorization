---
name: apigee-admin
description: Administer Apigee entities including APIs, products, and apps. Use when the user wants to manage Apigee using apigeecli, including installing the tool, handling GCP authentication, importing/deploying proxies, and discovering other commands.
---

# Apigee Admin

## Overview

This skill enables the administration of Apigee entities using the `apigeecli` tool. It handles operations like importing and deploying API proxies, as well as managing other entities like products and apps.

## Prerequisites & Installation

Before performing any Apigee operations, ensure the necessary tools are available.

### 1. Check for `gcloud`
Verify `gcloud` is installed and authenticated. It is required for generating access tokens.
```bash
command -v gcloud
```

### 2. Check for `apigeecli`
1. Check if `apigeecli` is in the system PATH: `command -v apigeecli`.
2. If not found, check the default installation path: `~/.apigeecli/bin/apigeecli`.
3. If still not found, ask the user for permission to install it:
   ```bash
   curl -L https://raw.githubusercontent.com/apigee/apigeecli/main/downloadLatest.sh | sh -
   ```
4. If installed via the script, use the absolute path `~/.apigeecli/bin/apigeecli` for subsequent commands.

## Authentication

All `apigeecli` commands require a GCP access token. Generate it using:
```bash
gcloud auth application-default print-access-token
```
Pass this token to `apigeecli` using the `--token` or `-t` flag.

## Workflows

### 1. Import an API Proxy Bundle
Use this when you have a local proxy bundle (a directory containing an `apiproxy` folder) and want to upload it to your Apigee organization.

**Command:**
```bash
apigeecli apis create bundle -f /path/to/proxy/bundle/apiproxy --name <proxy-name> -o <org-name> --token $(gcloud auth application-default print-access-token)
```
- `<proxy-name>`: The name to give the proxy in Apigee.
- `<org-name>`: The Apigee organization (GCP project ID).

### 2. Deploy a Named Proxy
Use this to deploy a proxy that already exists in the Apigee organization to a specific environment.

**Command:**
```bash
apigeecli apis deploy --wait --name <proxy-name> --ovr --org <org-name> --env <env-name> [sa_args] --token $(gcloud auth application-default print-access-token)
```
- `<env-name>`: The Apigee environment (e.g., `dev`, `prod`).
- `[sa_args]`: If a service account is required, use `--sa <service-account-email>`. Otherwise, omit this.

### 3. Import AND Deploy
Use this when the user wants to deploy a local directory directly. You must perform the **Import** first, followed by the **Deploy**.

**Step 1 (Import):**
```bash
apigeecli apis create bundle -f /path/to/bundle/apiproxy --name <proxy-name> -o <org-name> --token $(gcloud auth application-default print-access-token)
```

**Step 2 (Deploy):**
```bash
apigeecli apis deploy --wait --name <proxy-name> --ovr --org <org-name> --env <env-name> [sa_args] --token $(gcloud auth application-default print-access-token)
```

## Discovery (Other Entities)
`apigeecli` supports many other entities (apps, developers, products, KVMs, etc.). If asked for an operation not covered here, use `apigeecli <entity> --help` to discover the necessary commands and flags. Always use `gcloud auth application-default print-access-token` for authentication.