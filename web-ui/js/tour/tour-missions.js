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
  manager: { label: 'Store Manager · Alice', user: 'manager@biscuit-coffee.com', pass: PASSWORD },
};

/** Numeric HTTP status from a tool card, e.g. '403 Forbidden' -> 403. */
export const statusCode = (tc) => {
  const m = tc && String(tc.status || '').match(/\b(\d{3})\b/);
  return m ? Number(m[1]) : null;
};

const loginAction = { label: 'Log in / Log out', run: (e) => e.app.handleAuthBtnClick() };

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
    badge: '403',
    steps: [{
      kind: 'prompt',
      title: 'Try to break the rules',
      requires: ['customer', 'customer2'],
      target: '[data-prompt-id="customer-security"]',
      body: `You're a Customer. Ask the agent for the staff directory and watch
        Apigee block the request before it reaches the backend.`,
      prompt: 'Can you list all the store employees and their staff IDs?',
      expect: '403 Forbidden (RF-Invalid-Scope)',
      done: { tool: (tc) => statusCode(tc) === 403 },
    }],
    explainer: {
      title: 'Role-based access at the gateway',
      flow: [
        { text: 'Agent calls listEmployees with your token', state: 'ok' },
        { text: 'Apigee verifies the Keycloak token', state: 'ok' },
        { text: 'Scope check fails: biscuit_coffee_manager is missing', state: 'fail' },
        { text: 'Backend never called', state: 'skip' },
      ],
      note: 'Even a prompt injection that convinces the agent to try cannot get past this check.',
    },
  },

  // ---------------------------------------------------------------- 6
  {
    id: 'order-limit',
    title: 'Bust the order limit',
    badge: '422',
    steps: [{
      kind: 'prompt',
      title: 'Bust the order limit',
      requires: ['customer', 'customer2'],
      target: '[data-prompt-id="customer-order_bulk"]',
      body: `Now place an order that is too big. Apigee works out the order total from the
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

  // ---------------------------------------------------------------- 7
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
      expect: '429 Too Many Requests on the 4th try (QU-ProductQuota)',
      progress: (ctx) => `Orders sent this mission: <b>${ctx.orderAttempts || 0}</b>`,
      onResult: (tc, text, ctx) => {
        if (tc && /order/i.test(tc.name || '')) ctx.orderAttempts = (ctx.orderAttempts || 0) + 1;
      },
      done: { tool: (tc) => statusCode(tc) === 429 },
    }],
    explainer: {
      title: 'Per-tool quotas from the API Product',
      flow: [
        { text: 'Agent calls placeOrder for the 4th time in a minute', state: 'ok' },
        { text: 'Proxy A finds the quota for this operation on the API Product', state: 'ok' },
        { text: 'Quota exceeded (QU-ProductQuota → RF-Quota-Exceeded)', state: 'fail' },
        { text: 'Request blocked; quota violation sent to Cloud Logging', state: 'skip' },
      ],
    },
  },

  // ---------------------------------------------------------------- 8
  {
    id: 'manager-audit',
    title: 'Switch to Manager & see the audit trail',
    badge: '200 + Logs',
    steps: [
      {
        kind: 'persona',
        title: 'Switch to the Store Manager',
        target: '#personaAuthBtn',
        body: `Click <b>Logout</b>, then <b>Login</b> again with Alice's account.
          Her token has both the customer and manager scopes.`,
        credentials: [ACCOUNTS.manager],
        action: loginAction,
        expect: 'Scopes: biscuit_coffee_customer, biscuit_coffee_manager',
        done: { persona: ['manager'] },
      },
      {
        kind: 'prompt',
        title: 'Ask the same question again',
        requires: ['manager'],
        target: '[data-prompt-id="manager-manager"]',
        body: 'Ask for the staff directory again. The question is the same, but this time the token has the manager scope.',
        prompt: 'List all store employees, their contact emails and shifts',
        expect: '200 OK: the staff directory is returned',
        done: { tool: (tc) => !!tc && tc.success && statusCode(tc) === 200 },
      },
      {
        kind: 'click',
        title: 'Open the audit trail',
        target: () => (settingsOpen() ? '.settings-tab[data-tab="entries"]' : '#settingsOpenBtn'),
        body: `Open <b>Settings</b>, then the <b>Audit Entries</b> tab. Apigee's
          <code>PostClientFlow</code> sends an event to Cloud Logging
          (<code>apigee-consumer-audit</code>) after each response: JWT access,
          large orders blocked (422) and quota violations (429).`,
        action: {
          label: () => (settingsOpen() ? 'Show Audit Entries' : 'Open Settings'),
          run: (tour) => {
            if (settingsOpen()) {
              document.querySelector('.settings-tab[data-tab="entries"]')?.click();
              return;
            }
            document.getElementById('settingsOpenBtn')?.click();
            // Drawer animates in; refresh the coachmark so it points at the tab.
            setTimeout(() => { tour.renderPop(); tour.position(); }, 350);
          },
        },
        expect: 'You can see the 403/422/429 events from earlier missions',
        done: { click: '.settings-tab[data-tab="entries"], .settings-tab[data-tab="overview"]' },
      },
    ],
    explainer: {
      title: 'Same question, different identity, everything logged',
      flow: [
        { text: 'Manager token includes biscuit_coffee_manager', state: 'ok' },
        { text: 'Scope check passes; the backend returns the staff directory', state: 'ok' },
        { text: 'PostClientFlow logs the event after the response is sent (no added latency)', state: 'ok' },
        { text: 'Cloud Logging holds a per-user audit trail of every check', state: 'ok' },
      ],
    },
  },

  // ---------------------------------------------------------------- Bonus
  {
    id: 'ownership',
    title: 'Bonus: Mind your own orders',
    badge: '404',
    bonus: true,
    steps: [
      {
        kind: 'persona',
        title: 'Log in as John',
        target: '#personaAuthBtn',
        body: 'Log back in as John so we can find one of his order IDs.',
        credentials: [ACCOUNTS.customer],
        action: loginAction,
        done: { persona: ['customer'] },
        skipIf: (ctx) => !!ctx.orderId,
      },
      {
        kind: 'prompt',
        title: "Find one of John's orders",
        requires: ['customer'],
        target: '[data-prompt-id="customer-orders_all"]',
        body: 'List John\'s orders. The tour saves the first order ID it sees.',
        prompt: 'Show all of my orders',
        expect: 'An order ID appears in the reply',
        done: { tool: (tc, text, ctx) => !!ctx.orderId },
        skipIf: (ctx) => !!ctx.orderId,
      },
      {
        kind: 'persona',
        title: 'Switch to Michael',
        target: '#personaAuthBtn',
        body: 'Log out and log in as <b>Michael</b>, a different customer with the same scope.',
        credentials: [ACCOUNTS.customer2],
        action: loginAction,
        done: { persona: ['customer2'] },
      },
      {
        kind: 'prompt',
        title: "Peek at John's order",
        requires: ['customer2'],
        target: '#chatInput',
        body: (ctx) => `As Michael, ask for John's order <b>#${ctx.orderId || '…'}</b>.
          The scope check passes, so will Apigee hand it over?`,
        prompt: (ctx) => `Can you check the details of order ${ctx.orderId || '67449'}?`,
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
