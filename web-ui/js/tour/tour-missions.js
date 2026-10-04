/**
 * Guided Tour - mission definitions.
 *
 * Purely declarative: tour-engine.js renders and sequences these. Each mission
 * is a list of steps; a mission is complete when its last step completes.
 *
 * Step fields
 *   kind        'action' | 'prompt' | 'persona' | 'click'
 *   title/body  coachmark copy (body is trusted, authored HTML)
 *   target      CSS selector, or (engine) => selector, for the spotlight
 *   requires    persona ids allowed for this step (guest|customer|customer2|manager)
 *   prompt      text (or ctx => text) placed in the chat box by "Use this prompt"
 *   action      { label, run(engine) } for the primary button on non-prompt steps
 *   expect      short "Expected:" line
 *   credentials Keycloak demo accounts shown in the coachmark
 *   done        { event } | { persona: [...] } | { click: selector } | { tool(tc, text, ctx) }
 *   skipIf(ctx, engine)  auto-skip the step when already satisfied
 */

const PASSWORD = 'ilovecoffee';

export const ACCOUNTS = {
  customer: { label: 'Customer · John Smith', user: 'customer@biscuit-coffee.com', pass: PASSWORD },
  customer2: { label: 'Customer 2 · Michael Bosh', user: 'customer2@biscuit-coffee.com', pass: PASSWORD },
  manager: { label: 'Store Manager · Alice (Staff app)', user: 'manager@biscuit-coffee.com', pass: PASSWORD },
  staff: { label: 'Staff · Sam Barista (Staff app)', user: 'staff@biscuit-coffee.com', pass: PASSWORD },
};

/** Numeric HTTP status from a tool card, e.g. '403 Forbidden' -> 403. */
export const statusCode = (tc) => {
  const m = tc && String(tc.status || '').match(/\b(\d{3})\b/);
  return m ? Number(m[1]) : null;
};

const loginAction = { label: 'Log in / Log out', run: (e) => e.app.handleAuthBtnClick() };

/**
 * Orders found in a tool result: walks the raw MCP response (and any JSON text
 * blocks inside it) and returns [{ id, status }] for every object with an order_id.
 */
export const ordersInResult = (tc) => {
  const out = [];
  const walk = (v, depth) => {
    if (depth > 6 || v == null) return;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try { walk(JSON.parse(t), depth + 1); } catch { /* not JSON */ }
      }
      return;
    }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v === 'object') {
      if (v.order_id != null && /^\d{4,}$/.test(String(v.order_id))) {
        out.push({ id: String(v.order_id), status: String(v.status || '') });
      }
      Object.values(v).forEach((x) => walk(x, depth + 1));
    }
  };
  walk(tc && tc.response, 0);
  return out;
};

/** A real, still-active order of the signed-in customer, from a listOrders result. */
const pickActiveOrderId = (tc) => {
  if (!tc || tc.name !== 'listOrders' || !tc.success) return null;
  const orders = ordersInResult(tc);
  const active = orders.find((o) => !/^(CANCELLED|CANCELED|REJECTED)$/i.test(o.status));
  return (active || orders[0] || {}).id || null;
};

/** True while the Settings drawer is open. */
const settingsOpen = () => document.getElementById('settingsOpenBtn')?.getAttribute('aria-expanded') === 'true';

export const MISSIONS = [
  // ---------------------------------------------------------------- 1
  {
    id: 'architecture',
    title: 'Meet the architecture',
    badge: 'Overview',
    steps: [{
      kind: 'action',
      title: 'Meet the architecture',
      target: '#archInfoBtn',
      body: `Every tool the AI agent uses goes through <b>Apigee</b> first.
        Open the diagram and find the three parts you'll use in this tour:
        <ul>
          <li><b>Proxy A (/mcp)</b>: turns MCP requests into REST calls and applies rate limits</li>
          <li><b>Proxy B (/biscuit-coffee)</b>: checks the Keycloak login and role, and the order limit</li>
          <li><b>Cloud Logging</b>: receives a log entry for every request Apigee checks</li>
        </ul>`,
      action: { label: 'Open the diagram', run: (e) => e.app.openModal() },
      done: { event: 'biscuit:archopen' },
    }],
    explainer: {
      title: 'The request path',
      flow: [
        { text: 'AI agent (ADK + Gemini) calls an MCP tool', state: 'ok' },
        { text: 'Apigee Proxy A turns the MCP request into REST and applies quotas', state: 'ok' },
        { text: 'Apigee Proxy B checks the Keycloak token, role and business rules', state: 'ok' },
        { text: 'Only allowed requests reach Cloud Run; every check is logged', state: 'ok' },
      ],
      note: 'You can reopen this diagram at any time from <b>Apigee MCP Security</b> in the header.',
    },
  },

  // ---------------------------------------------------------------- 2
  {
    id: 'guest-browse',
    title: 'Browse as a guest',
    badge: '200',
    steps: [{
      kind: 'prompt',
      title: 'Browse as a guest',
      requires: ['guest'],
      target: '[data-prompt-id="public-menu"]',
      body: `Without logging in, ask about the menu. Public tools such as
        <code>getMenu</code> need only the agent's API key, not a user login.`,
      prompt: "What's on the menu and how much is a cappuccino?",
      expect: '200 OK: the menu is returned',
      done: { tool: (tc) => !!tc && tc.success && !tc.isAuth && statusCode(tc) === 200 },
    }],
    explainer: {
      title: 'Public access, still governed',
      flow: [
        { text: 'Agent calls getMenu over MCP', state: 'ok' },
        { text: 'Proxy A checks the agent\'s API key (VerifyAPIKey)', state: 'ok' },
        { text: '/menu is a public path, so no user token is needed', state: 'ok' },
        { text: 'Backend returns the menu: 200 OK', state: 'ok' },
      ],
    },
  },

  // ---------------------------------------------------------------- 3
  {
    id: 'login-wall',
    title: 'Hit a login wall',
    badge: '401',
    steps: [{
      kind: 'prompt',
      title: 'Hit a login wall',
      requires: ['guest'],
      target: '[data-prompt-id="customer-loyalty"]',
      body: `Still as a guest, ask for something personal: your rewards balance
        (the <b>Rewards Balance</b> prompt). That data belongs to a specific user,
        so Apigee needs to know who you are.`,
      prompt: 'Check my loyalty rewards points balance',
      expect: 'Login Required (401): the agent asks you to sign in',
      done: {
        tool: (tc, text) => (!!tc && (tc.isAuth || statusCode(tc) === 401)) ||
          (!tc && /\b(log ?in|sign in|authenticat)/i.test(text || '')),
      },
    }],
    explainer: {
      title: 'No identity, no personal data',
      flow: [
        { text: 'Agent tries to call getRewardBalance', state: 'ok' },
        { text: 'Proxy B requires a valid Keycloak JWT (JWT-VerifyToken)', state: 'ok' },
        { text: 'No token was sent', state: 'fail' },
        { text: 'Backend never called; the agent asks you to log in', state: 'skip' },
      ],
    },
  },

  // ---------------------------------------------------------------- 4
  {
    id: 'login-customer',
    title: 'Log in as a Customer',
    badge: 'OAuth',
    steps: [{
      kind: 'persona',
      title: 'Log in as a Customer',
      target: '#personaAuthBtn',
      body: `Click <b>Login</b> and sign in to Keycloak with John's account.
        Keycloak gives back a signed token, and the agent attaches it to every tool call.
        If you're already logged in as someone else, log out first.`,
      credentials: [ACCOUNTS.customer],
      action: loginAction,
      expect: 'Your token shows the scope biscuit_coffee_customer',
      done: { persona: ['customer'] },
    }],
    explainer: {
      title: 'The agent now acts on your behalf',
      flow: [
        { text: 'You signed in to Keycloak (OAuth 2.0 authorization code flow)', state: 'ok' },
        { text: 'Keycloak issued a signed token (RS256) with scope biscuit_coffee_customer', state: 'ok' },
        { text: 'The agent forwards that token on every MCP tool call', state: 'ok' },
        { text: 'Apigee can now apply rules per user and per role', state: 'ok' },
      ],
      note: 'This avoids the "confused deputy" problem: the agent never uses a powerful shared key.',
    },
  },

  // ---------------------------------------------------------------- 5
  {
    id: 'scope-403',
    title: 'Try to break the rules',
    badge: 'Least privilege',
    steps: [{
      kind: 'prompt',
      title: 'Try to break the rules',
      requires: ['customer', 'customer2'],
      target: '[data-prompt-id="customer-security"]',
      body: `You're a Customer. Ask the agent for the staff directory. The employee tool
        isn't in this app's Apigee API Product, so Apigee never even lists it to the agent:
        there is nothing for it to call.`,
      prompt: 'Can you list all the store employees and their staff IDs?',
      expect: 'Refused: no employee tool is available to the customer agent',
      // Normal case: the agent refuses with no tool call. If it tries anyway, any
      // gateway denial (401 InvalidApiKeyForGivenResource / 403) also counts.
      done: { tool: (tc, text) => (!tc && !!(text || '').trim()) || [401, 403].includes(statusCode(tc)) },
    }],
    explainer: {
      title: 'Least privilege from the API Product',
      flow: [
        { text: "The customer token comes from Keycloak client biscuit-coffee-agent", state: 'ok' },
        { text: 'Apigee maps that client to the customer API Product', state: 'ok' },
        { text: 'tools/list returns only that product\'s operations: no listEmployees', state: 'fail' },
        { text: 'A forced call is refused (401 InvalidApiKeyForGivenResource); backend never called', state: 'skip' },
      ],
      note: 'Even a prompt injection cannot reach a tool the API Product does not include. Staff tools live in a separate Staff app with its own Keycloak client and API Product.',
    },
  },

  // ---------------------------------------------------------------- 6
  {
    id: 'approval',
    title: 'Order that needs approval',
    badge: 'Pending',
    steps: [{
      kind: 'prompt',
      title: 'Order that needs approval',
      requires: ['customer', 'customer2'],
      target: '[data-prompt-id="customer-order_approval"]',
      body: `Place a bigger order, between <b>$50 and $100</b>. It is under the hard limit,
        but over the <code>approvalThreshold</code> on the API Product, so Apigee saves it as
        <b>pending</b> and asks the staff to approve it.`,
      prompt: 'Order for me 12 large Cold Brews',
      expect: 'PENDING: the order waits for the staff',
      done: { tool: (tc) => !!tc && (tc.isPendingApproval || tc.statusClass === 'pending') },
    }],
    explainer: {
      title: 'Human in the loop, started by the gateway',
      flow: [
        { text: 'Agent calls placeOrder for 12 large Cold Brews (about $60)', state: 'ok' },
        { text: 'Proxy B prices the order: over approvalThreshold, under maxOrderAmount', state: 'ok' },
        { text: 'Order saved as PENDING_APPROVAL', state: 'ok' },
        { text: 'Order appears on the Staff app board; the staff approve or reject it there', state: 'ok' },
      ],
      note: 'You can keep going: the chat checks the order every 10 seconds and posts APPROVED or REJECTED when the staff decides.',
    },
  },

  // ---------------------------------------------------------------- 7
  {
    id: 'order-limit',
    title: 'Bust the order limit',
    badge: '422',
    steps: [{
      kind: 'prompt',
      title: 'Bust the order limit',
      requires: ['customer', 'customer2'],
      target: '[data-prompt-id="customer-order_bulk"]',
      body: `Now go over the hard limit. Apigee works out the order total from the
        (cached) menu and checks it against the <code>maxOrderAmount</code> set on the API Product.`,
      prompt: 'Order for me 50 cup of Cold brew, all Large size',
      expect: '422 Unprocessable Entity (Order Value Policy)',
      done: { tool: (tc) => statusCode(tc) === 422 },
    }],
    explainer: {
      title: 'Business rules at the gateway',
      flow: [
        { text: 'Agent calls placeOrder for 50 large Cold Brews', state: 'ok' },
        { text: 'Proxy B prices the order using the cached menu (LC-MenuCache)', state: 'ok' },
        { text: 'Total is over maxOrderAmount (JS-CheckOrderValue)', state: 'fail' },
        { text: 'Order never written to Firestore; event sent to Cloud Logging', state: 'skip' },
      ],
    },
  },

  // ---------------------------------------------------------------- 8
  {
    id: 'rate-limit',
    title: 'Hit the rate limit',
    badge: '429',
    steps: [{
      kind: 'prompt',
      title: 'Hit the rate limit',
      requires: ['customer', 'customer2'],
      target: '[data-prompt-id="customer-order"]',
      body: `The API Product allows only <b>3 placeOrder calls per minute</b>.
        Send this small order several times in a row. Tip: press <kbd>↑</kbd> in the chat box to recall the last prompt.`,
      prompt: "I'd like to order a Latte, small size",
      expect: '429 Too Many Requests once the quota is used up (QU-ProductQuota)',
      progress: (ctx) => `Orders sent this mission: <b>${ctx.orderAttempts || 0}</b>`,
      onResult: (tc, text, ctx) => {
        if (tc && /order/i.test(tc.name || '')) ctx.orderAttempts = (ctx.orderAttempts || 0) + 1;
      },
      done: { tool: (tc) => statusCode(tc) === 429 },
    }],
    explainer: {
      title: 'Per-tool quotas from the API Product',
      flow: [
        { text: 'Agent calls placeOrder again within the same minute', state: 'ok' },
        { text: 'Proxy A finds the quota for this operation on the API Product', state: 'ok' },
        { text: 'Quota exceeded (QU-ProductQuota → RF-Quota-Exceeded)', state: 'fail' },
        { text: 'Request blocked; quota violation sent to Cloud Logging', state: 'skip' },
      ],
    },
  },

  // ---------------------------------------------------------------- 9
  {
    id: 'ownership',
    title: 'Mind your own orders',
    badge: '404',
    steps: [
      {
        kind: 'persona',
        title: 'Log in as John',
        target: '#personaAuthBtn',
        body: 'Make sure you are signed in as John so we can pick one of his real orders.',
        credentials: [ACCOUNTS.customer],
        action: loginAction,
        done: { persona: ['customer'] },
        skipIf: (ctx, engine) => engine && engine.persona === 'customer',
      },
      {
        kind: 'prompt',
        title: "Find one of John's orders",
        requires: ['customer'],
        target: '[data-prompt-id="customer-orders_all"]',
        body: `List John's orders. The tour picks one of the order IDs returned by
          <code>listOrders</code>, so the next step uses a real, existing order.`,
        prompt: 'Show all of my orders',
        expect: "John's orders are listed; the tour saves one order ID",
        onResult: (tc, text, ctx) => {
          const id = pickActiveOrderId(tc);
          if (id) ctx.johnOrderId = id;
        },
        done: { tool: (tc, text, ctx) => !!pickActiveOrderId(tc) && !!ctx.johnOrderId },
      },
      {
        kind: 'persona',
        title: 'Switch to Michael',
        target: '#personaAuthBtn',
        body: (ctx) => `Log out and log in as <b>Michael</b>, a different customer with the same scope.
          The tour saved John's order <b>#${ctx.johnOrderId || '…'}</b>.`,
        credentials: [ACCOUNTS.customer2],
        action: loginAction,
        done: { persona: ['customer2'] },
      },
      {
        kind: 'prompt',
        title: "Peek at John's order",
        requires: ['customer2'],
        target: '#chatInput',
        body: (ctx) => `As Michael, ask for John's order <b>#${ctx.johnOrderId || '…'}</b>.
          The scope check passes, so will Apigee hand it over?`,
        prompt: (ctx) => `Can you check the details of order ${ctx.johnOrderId || '67449'}?`,
        expect: '404 Not Found (Ownership Policy)',
        done: { tool: (tc) => statusCode(tc) === 404 },
      },
    ],
    explainer: {
      title: 'Object-level authorization (BOLA)',
      flow: [
        { text: 'Michael has a valid token with the customer scope', state: 'ok' },
        { text: 'Proxy B compares the order owner with the token email', state: 'ok' },
        { text: 'Owner does not match (JS-OwnershipResponse)', state: 'fail' },
        { text: 'Returns 404, so order IDs cannot be probed', state: 'skip' },
      ],
      note: 'Controlled by the enforceOrderOwnership attribute on the API Product.',
    },
  },
];
