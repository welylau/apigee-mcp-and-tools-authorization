# Biscuit Coffee Shop — AI Agent Web UI

A modern, responsive web application designed to host and showcase the **Biscuit Coffee Agent** built with the **Google Agent Development Kit (ADK)** and secured by **Apigee X** and **Keycloak OAuth 2.0**.

---

## Features

- ☕ **Artisanal Coffee Shop Aesthetic**: Polished coffee-house theme with warm crema highlights, dark obsidian backgrounds, glassmorphism cards, and responsive layouts.
- 🔐 **Visual Role Governance**: Side-by-side comparison explaining what **Customers** vs. **Store Managers** can and cannot do under Apigee security policies.
- 🔄 **One-Click Persona Switcher**: Switch on the fly between **Customer (John Smith)** and **Store Manager (Alice)** to demonstrate dynamic OAuth 2.0 JWT scope enforcement.
- 💡 **Interactive Suggested Prompts**: Pre-configured prompt chips for menu browsing, order placement, rewards checking, and security policy boundary testing.
- 🛡️ **Apigee Policy & Tool Call Visualizer**: Interactive cards showing real-time tool execution (`mcp_proxy_getMenu`, `mcp_proxy_listEmployees`), Apigee endpoints, required scopes, and HTTP status codes (`200 OK` vs. `403 Forbidden`).
- ⚡ **Dual Engine Support**:
  - **Live ADK Mode**: Connects directly to the ADK backend server running on `http://localhost:8000`.
  - **Showcase Simulator Mode**: Built-in realistic offline emulator grounded in the repository's real mock data, allowing seamless presentation even when offline or before backend deployment.
  - **Raw Dev-UI Embed Mode**: Quick toggle to view the native ADK Dev-UI iframe inside the interface.

---

## Role Permissions & Security Matrix

The application demonstrates **Role-Based Tool Authorization** enforced at the API Gateway level by Apigee.

| Feature / Operation | Apigee Flow & Endpoint | Customer (`customer@biscuit-coffee.com`) | Store Manager (`manager@biscuit-coffee.com`) |
| :--- | :--- | :---: | :---: |
| **Active OAuth Scope** | Token Claims | `biscuit_coffee_customer` | `biscuit_coffee_customer`, `biscuit_coffee_manager` |
| **Browse Menu & Pricing** | `GET /menu` (Public) | ✅ **Allowed** | ✅ **Allowed** |
| **Store Hours & Location** | `GET /hours`, `GET /location` (Public) | ✅ **Allowed** | ✅ **Allowed** |
| **Loyalty Rewards Balance** | `GET /loyalty/balance` | ✅ **Allowed** | ✅ **Allowed** |
| **Loyalty Membership Signup** | `POST /loyalty/signup` | ✅ **Allowed** | ✅ **Allowed** |
| **Manage Payment Methods** | `GET/POST /payment-methods` | ✅ **Allowed** | ✅ **Allowed** |
| **Place & Track Orders** | `POST/GET /orders` | ✅ **Allowed** | ✅ **Allowed** |
| **Cancel Active Order** | `DELETE /orders/{id}` | ✅ **Allowed** | ✅ **Allowed** |
| **List Store Employees** | `GET /employees` | ❌ **BLOCKED (403 Forbidden)**<br>`RF-Invalid-Scope` | ✅ **Allowed (200 OK)**<br>`AM-ListEmployees` |
| **View Staff IDs & Emails** | `GET /employees` payload | ❌ **BLOCKED** | ✅ **Allowed** |
| **Alter Apigee / Realm Keys** | Admin Infrastructure | ❌ **BLOCKED** | ❌ **BLOCKED** |

### Apigee Security Enforcement Under the Hood

When the agent invokes the MCP tool `mcp_proxy_listEmployees`:
1. Apigee's `PreFlow` runs `JWT-VerifyToken`, validating the Keycloak JWT signature and issuer.
2. The conditional flow checks:
   ```xml
   <Condition>!(jwt.JWT-VerifyToken.claim.scope ~~ ".*\bbiscuit_coffee_manager\b.*")</Condition>
   <Name>RF-Invalid-Scope</Name>
   ```
3. If the token contains only `biscuit_coffee_customer`, Apigee immediately terminates the request with **HTTP 403 Forbidden**, preventing the AI Agent from accessing internal staff records.

---

## Suggested Prompts

Click any of the suggested prompt chips in the UI or copy them into the chat:

### 👤 Customer Prompts
- *"What's on the menu today and how much is a cappuccino?"*
- *"Where is Biscuit Coffee located and what are your opening hours?"*
- *"Check my loyalty rewards points balance"*
- *"I'd like to order a Latte and a warm Biscuit"*
- *"Can you show my saved payment methods?"*
- *"What is the status of my order #ord-8921?"*

### 👔 Store Manager Prompts
- *"List all store employees, their contact emails and shifts"*
- *"Show me the employee directory and staff IDs"*
- *"What is the current team roster for barista scheduling?"*

### 🛡️ Security & Boundary Demonstration Prompts
- **As Customer:** *"Can you list all the store employees and their staff IDs?"*
  - **Expected Result:** The Apigee Gateway returns `403 Forbidden` (`RF-Invalid-Scope`). The agent informs the user that manager authorization is required.
- **Switch to Manager:** Click the **Store Manager** tab at the top.
- **As Store Manager:** Send the exact same prompt: *"Can you list all the store employees and their staff IDs?"*
  - **Expected Result:** The Apigee Gateway validates the `biscuit_coffee_manager` scope, returns `200 OK`, and the agent presents the full staff directory!

---

## Quickstart

### Option 1: Using the Python Server (Recommended)
From the repository root or the `web-ui` directory:

```bash
cd web-ui
python3 server.py 3000
```
Open **http://localhost:3000** in your browser.

### Option 2: Using NPM / npx
```bash
cd web-ui
npm start
```

### Option 3: Direct Browser File Access
You can also directly double-click `web-ui/index.html` or open it in Google Chrome / Safari / Firefox.

---

## Connecting to the Live ADK Agent

1. In a separate terminal, start the ADK backend server:
   ```bash
   cd biscuit-coffee/python/agents
   uv sync
   uv run adk web
   ```
2. Open the Web UI at **http://localhost:3000**.
3. The connection pill in the top header will automatically detect the ADK server at `http://localhost:8000` and switch the status dot to green (**ADK Web Live**).
