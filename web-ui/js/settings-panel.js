/**
 * Settings drawer: hosting topology + Apigee consumer audit log dashboard.
 *
 * Security notes:
 *  - All DOM is built with createElement / createElementNS + textContent.
 *    No innerHTML anywhere, so log content (which partly originates from
 *    API callers) can never be interpreted as markup.
 *  - Data comes only from the same-origin BFF (/api/settings/*). That
 *    endpoint validates the Keycloak token server-side, masks e-mails and
 *    only returns API-key fingerprints.
 *  - Links are only rendered for http(s) URLs (no javascript: etc.).
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const EVENT_META = {
  quota_exceeded: { label: 'Quota exceeded', color: 'var(--apigee-orange)', short: '429 quota' },
  order_limit_exceeded: { label: 'Large order blocked', color: 'var(--danger)', short: '422 > $100' },
  jwt_access: { label: 'JWT access', color: 'var(--google-blue)', short: 'JWT' },
  approval_required: { label: 'Pending staff approval', color: 'var(--warning)', short: 'approval' },
  approval_trigger_failed: { label: 'Approval request failed (legacy)', color: 'var(--google-yellow)', short: 'approval failed' },
};
const ROLE_COLORS = {
  customer: 'var(--role-customer)',
  manager: 'var(--role-manager)',
  staff: 'var(--google-green, #34a853)',
  anonymous: 'var(--text-dim)',
  unknown: 'var(--border-accent)',
};
const ERROR_COLOR = 'var(--danger)';
const BADGE_POLL_MS = 60000;

// ---------------------------------------------------------------- helpers
function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined && opts.text !== null) node.textContent = String(opts.text);
  if (opts.title) node.title = String(opts.title);
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, String(v));
  }
  if (opts.style) {
    for (const [k, v] of Object.entries(opts.style)) node.style.setProperty(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const c of [].concat(children)) if (c) node.appendChild(c);
  return node;
}

function svgTitle(text) {
  const t = document.createElementNS(SVG_NS, 'title');
  t.textContent = text;
  return t;
}

function safeLink(url, label) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
    return el('a', {
      className: 's-link', text: label || url,
      attrs: { href: u.href, target: '_blank', rel: 'noopener noreferrer' },
    });
  } catch {
    return el('span', { className: 's-mono', text: url || '—' });
  }
}

function fmtTime(iso, withSeconds = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  });
}

function relTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function shortFp(fp) {
  if (!fp) return '—';
  const hex = fp.replace(/^sha256:/, '');
  return hex.length > 16 ? `sha256:${hex.slice(0, 8)}…${hex.slice(-6)}` : fp;
}

function shortSa(sa) {
  if (!sa) return '';
  return sa.split('/').pop().split('@')[0];
}

function kv(rows) {
  const dl = el('dl', { className: 's-kv' });
  for (const [k, v] of rows) {
    if (v === undefined) continue;
    dl.appendChild(el('dt', { text: k }));
    const dd = el('dd');
    if (v instanceof Node) dd.appendChild(v);
    else dd.textContent = v === null || v === '' ? '—' : String(v);
    dl.appendChild(dd);
  }
  return dl;
}

function chip(text, color = '', title = '') {
  return el('span', { className: `s-chip ${color}`.trim(), text, title });
}

function card(title, body, count) {
  return el('div', { className: 's-card' }, [
    el('div', { className: 's-card-title' }, [
      el('span', { text: title }),
      count !== undefined ? el('span', { className: 's-count', text: count }) : null,
    ]),
    ...[].concat(body),
  ]);
}

function statusClass(code) {
  const n = parseInt(code, 10);
  if (Number.isNaN(n)) return '';
  if (n >= 500) return 'err';
  if (n >= 400) return n === 401 || n === 403 || n === 422 || n === 429 ? 'err' : 'warn';
  return 'ok';
}

// ---------------------------------------------------------------- panel
export class SettingsPanel {
  /**
   * @param {() => Promise<string|null>} getAccessToken resolves the current
   *        user's Keycloak access token (or null when signed out).
   */
  constructor(getAccessToken) {
    this.getAccessToken = getAccessToken;
    this.state = { tab: 'hosting', range: '1d', event: 'all', env: 'all', page: 1, pageSize: 25 };
    this.expanded = new Set();
    this.hostingLoaded = false;
    this.logsLoaded = false;
    this.inflight = null;

    this.openBtn = document.getElementById('settingsOpenBtn');
    this.drawer = document.getElementById('settingsDrawer');
    this.backdrop = document.getElementById('settingsBackdrop');
    this.closeBtn = document.getElementById('settingsCloseBtn');
    this.refreshBtn = document.getElementById('settingsRefreshBtn');
    this.hostingPane = document.getElementById('settingsHostingPane');
    this.logsShell = document.getElementById('settingsLogsShell');
    this.overviewPane = document.getElementById('settingsOverviewPane');
    this.entriesPane = document.getElementById('settingsEntriesPane');
    this.entriesTabBtn = document.getElementById('settingsTabEntries');
    this.logsMeta = document.getElementById('logsMeta');
    this.rangeChips = document.getElementById('logsRangeChips');
    this.eventFilter = document.getElementById('logsEventFilter');
    this.envFilter = document.getElementById('logsEnvFilter');
    this.adminTab = document.getElementById('staffAdminTab');
    this.badges = ['settingsErrBadge', 'staffAdminErrBadge'].map((id) => document.getElementById(id)).filter(Boolean);
    if (!this.openBtn || !this.drawer) return;
    this.bind();
    this.startErrorBadge();
  }

  bind() {
    this.openBtn.addEventListener('click', () => this.open());
    if (this.adminTab) {
      this.adminTab.addEventListener('click', async () => {
        const toOverview = this.state.tab === 'hosting';
        if (toOverview) this.state.tab = 'overview'; // open() then loads the logs, not hosting
        await this.open();
        if (toOverview) this.switchTab('overview');
      });
    }
    this.closeBtn.addEventListener('click', () => this.close());
    this.maxBtn = document.getElementById('settingsMaximizeBtn');
    if (this.maxBtn) {
      // UI preference only (no sensitive data) - safe in localStorage.
      this.setMaximized(localStorage.getItem('biscuit_settings_maximized') === '1');
      this.maxBtn.addEventListener('click', () => this.setMaximized(!this.drawer.classList.contains('maximized')));
    }
    this.backdrop.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.drawer.classList.contains('open')) this.close();
    });
    this.refreshBtn.addEventListener('click', () => {
      if (this.state.tab === 'hosting') this.loadHosting(true);
      else this.loadLogs(true);
    });
    this.drawer.querySelectorAll('.settings-tab').forEach((btn) => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });
    this.rangeChips.querySelectorAll('.range-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.state.range = btn.dataset.range;
        this.state.page = 1;
        this.rangeChips.querySelectorAll('.range-chip').forEach((b) => b.classList.toggle('active', b === btn));
        this.loadLogs();
      });
    });
    this.eventFilter.addEventListener('change', () => {
      this.state.event = this.eventFilter.value;
      this.state.page = 1;
      this.loadLogs();
    });
    this.envFilter.addEventListener('change', () => {
      this.state.env = this.envFilter.value;
      this.state.page = 1;
      this.loadLogs();
    });
  }

  setMaximized(on) {
    this.drawer.classList.toggle('maximized', on);
    if (this.maxBtn) {
      this.maxBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      this.maxBtn.title = on ? 'Restore panel size' : 'Maximize panel';
    }
    try { localStorage.setItem('biscuit_settings_maximized', on ? '1' : '0'); } catch { /* storage disabled */ }
  }

  async open() {
    this.lastFocus = document.activeElement;
    this.drawer.classList.add('open');
    this.backdrop.classList.add('active');
    this.drawer.setAttribute('aria-hidden', 'false');
    this.openBtn.setAttribute('aria-expanded', 'true');
    this.closeBtn.focus();

    // Never show data loaded for a previous session (logout / user switch).
    const who = await this.currentIdentity();
    if (who !== this.loadedFor) {
      this.loadedFor = who;
      this.hostingLoaded = false;
      this.logsLoaded = false;
      this.expanded.clear();
      this.hostingPane.replaceChildren();
      this.overviewPane.replaceChildren();
      this.entriesPane.replaceChildren();
      this.logsMeta.textContent = '';
      this.setEntriesCount(null);
    }
    if (this.state.tab === 'hosting' && !this.hostingLoaded) this.loadHosting();
    if (this.state.tab !== 'hosting' && !this.logsLoaded) this.loadLogs();
  }

  async currentIdentity() {
    try {
      const tok = await this.getAccessToken();
      if (!tok) return null;
      const part = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(part)).sub || null;
    } catch {
      return null;
    }
  }

  close() {
    this.drawer.classList.remove('open');
    this.backdrop.classList.remove('active');
    this.drawer.setAttribute('aria-hidden', 'true');
    this.openBtn.setAttribute('aria-expanded', 'false');
    if (this.lastFocus && this.lastFocus.focus) this.lastFocus.focus();
  }

  switchTab(tab, load = true) {
    this.state.tab = tab;
    this.drawer.querySelectorAll('.settings-tab').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const isLogs = tab === 'overview' || tab === 'entries';
    this.hostingPane.classList.toggle('active', tab === 'hosting');
    this.logsShell.classList.toggle('active', isLogs);
    this.overviewPane.classList.toggle('active', tab === 'overview');
    this.entriesPane.classList.toggle('active', tab === 'entries');
    if (!load) return;
    if (tab === 'hosting' && !this.hostingLoaded) this.loadHosting();
    if (isLogs && !this.logsLoaded) this.loadLogs();
  }

  /** Jump to the Audit Entries tab filtered to HTTP 4xx/5xx responses. */
  showErrors() {
    this.state.event = 'errors';
    this.state.page = 1;
    this.expanded.clear();
    if (this.eventFilter) this.eventFilter.value = 'errors';
    this.switchTab('entries', false);
    this.loadLogs();
  }

  // ---------------- error badge (header button + console tab)
  isManagerView() {
    const b = document.body;
    return b.dataset.uiVariant === 'staff' && b.dataset.staffRole === 'manager';
  }

  setBadge(count) {
    for (const badge of this.badges) {
      badge.hidden = !count;
      badge.textContent = count > 99 ? '99+' : String(count || '');
      badge.title = count ? `${count} gateway error(s) in the last hour` : '';
    }
    const label = count ? ` (${count} gateway error(s) in the last hour)` : '';
    this.openBtn.setAttribute('aria-label', `Admin panel${label}`);
  }

  async refreshBadge() {
    if (!this.badges.length || document.hidden || !this.isManagerView()) {
      if (!this.isManagerView()) this.setBadge(0);
      return;
    }
    try {
      const { status, body } = await this.api('/api/settings/logs?range=1h&event=errors&pageSize=10');
      this.setBadge(status === 200 ? ((body.page || {}).total || 0) : 0);
    } catch {
      /* keep the last value; the next poll retries */
    }
  }

  startErrorBadge() {
    if (!this.badges.length) return;
    const tick = () => this.refreshBadge();
    // First check once the role is known (app.js sets data-staff-role after sign-in).
    new MutationObserver(tick).observe(document.body, { attributes: true, attributeFilter: ['data-staff-role'] });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    setInterval(tick, BADGE_POLL_MS);
    tick();
  }

  setEntriesCount(n) {
    if (!this.entriesTabBtn) return;
    this.entriesTabBtn.textContent = n === null || n === undefined ? 'Audit Entries' : `Audit Entries (${n})`;
  }

  async api(path) {
    const token = await this.getAccessToken();
    if (!token) return { status: 401, body: { message: 'Sign in to view settings.' } };
    const res = await fetch(path, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    let body = {};
    try { body = await res.json(); } catch { body = {}; }
    return { status: res.status, body };
  }

  setSpinning(on) {
    this.refreshBtn.classList.toggle('spinning', on);
  }

  renderGate(container, status, body) {
    const msgs = {
      401: ['Sign in required', 'Sign in to the staff console as a store manager to view this panel.'],
      403: ['Store manager only', body?.message || 'The admin panel is restricted to the store manager role.'],
      429: ['Slow down', 'Too many requests, try again in a minute.'],
      502: ['Google Cloud API error', body?.message || 'Could not reach Google Cloud APIs.'],
      503: ['Identity provider unavailable', 'Keycloak could not be reached to validate your session.'],
    };
    const [title, text] = msgs[status] || ['Something went wrong', body?.message || `HTTP ${status}`];
    container.replaceChildren(el('div', { className: 's-card s-empty' }, [el('strong', { text: title }), text]));
  }

  // ============================================================ HOSTING
  async loadHosting(refresh = false) {
    this.hostingPane.replaceChildren(
      el('div', { className: 's-skeleton' }), el('div', { className: 's-skeleton' }), el('div', { className: 's-skeleton' }));
    this.setSpinning(true);
    try {
      const { status, body } = await this.api(`/api/settings/hosting${refresh ? '?refresh=1' : ''}`);
      if (status !== 200) { this.renderGate(this.hostingPane, status, body); return; }
      this.hostingLoaded = true;
      this.renderHosting(body);
    } catch {
      this.renderGate(this.hostingPane, 0, { message: 'Network error while loading hosting info.' });
    } finally {
      this.setSpinning(false);
    }
  }

  renderHosting(d) {
    const rt = d.runtime || {};
    const groups = d.environmentGroups || [];
    const activeGroup = groups.find((g) => (g.hostnames || []).includes(rt.gatewayHostname));
    const activeEnvs = activeGroup ? activeGroup.environments : [];
    const nodes = [];

    // Banner: where is this UI pointed?
    nodes.push(el('div', { className: 's-banner' }, [
      el('span', { text: '🧭' }),
      el('span', {}, [
        'This Web UI\'s agent calls ',
        el('strong', { text: rt.gatewayHostname || 'unknown gateway' }),
        activeGroup ? ` → env group ${activeGroup.name} → ` : '',
        activeEnvs.length ? el('strong', { text: activeEnvs.join(', ') }) : '',
      ]),
      chip(rt.container ? (rt.cloudRunService ? `Cloud Run: ${rt.cloudRunService}` : 'Container') : 'Local machine', 'blue'),
    ]));

    if ((d.errors || []).length) {
      nodes.push(el('div', { className: 's-alert' }, [`Some sections could not be loaded: ${d.errors.join(' • ')}`]));
    }

    // Runtime + IdP. Infrastructure details (bind address, revision, Python,
    // ADK URL, issuer) are only returned to store managers.
    const realmMatch = /\/realms\/([^/]+)/.exec(rt.keycloakBase || '');
    const has = (v) => v !== undefined && v !== null && v !== '';
    const runtimeRows = [
      ['Web UI URL', safeLink(rt.localUrl)],
      has(rt.bindHost) ? ['Bound to', `${rt.bindHost}:${rt.port}`] : null,
      ['Hosting', rt.cloudRunService
        ? `Cloud Run (${rt.cloudRunService}${rt.cloudRunRevision ? ' • ' + rt.cloudRunRevision : ''})`
        : (rt.container ? 'Container' : 'Local (python server.py)')],
      has(rt.pythonVersion) ? ['Python', rt.pythonVersion] : null,
      ['ADK backend', el('span', {}, [
        el('span', { className: `s-dot ${rt.adkLive ? 'ok' : 'bad'}` }), ' ',
        el('span', { className: 's-mono', text: rt.adkBackend || (rt.adkLive ? 'online' : 'offline') }),
      ])],
      ['Model', rt.model],
    ].filter(Boolean);
    const idpRows = [
      has(rt.keycloakBase) ? ['Issuer', safeLink(rt.keycloakBase)] : null,
      realmMatch ? ['Realm', realmMatch[1]] : null,
      ['UI client ID', el('span', { className: 's-mono', text: rt.keycloakClientId })],
      ['Secret', 'Held server-side only (BFF)'],
    ].filter(Boolean);
    nodes.push(el('div', { className: 's-grid-2 s-section-gap' }, [
      card('Web UI runtime', kv(runtimeRows)),
      card('Identity provider (Keycloak)', kv(idpRows)),
    ]));

    // Apigee gateway / env groups
    const egTable = el('table', { className: 's-table' }, [
      el('thead', {}, el('tr', {}, ['Env group', 'Hostnames', 'Environments'].map((h) => el('th', { text: h })))),
      el('tbody', {}, groups.map((g) => el('tr', { className: g === activeGroup ? 'highlight' : '' }, [
        el('td', {}, [el('strong', { text: g.name }), g === activeGroup ? chip('in use', 'blue') : null]),
        el('td', {}, (g.hostnames || []).map((h) => chip(h, h === rt.gatewayHostname ? 'blue' : ''))),
        el('td', {}, (g.environments || []).map((e) => chip(e, 'orange'))),
      ]))),
    ]);
    nodes.push(card('Apigee X gateway', [
      kv([
        ['Organization', d.apigeeOrg],
        ['MCP endpoint', rt.gatewayHostname ? safeLink(`https://${rt.gatewayHostname}/mcp`) : '—'],
      ]),
      el('div', { className: 's-table-wrap', style: { 'margin-top': '10px' } }, egTable),
    ]));

    // Proxies & deployments
    const deps = d.deployments || [];
    nodes.push(card('API proxies & deployments', el('div', { className: 's-table-wrap' }, el('table', { className: 's-table' }, [
      el('thead', {}, el('tr', {}, ['Proxy', 'Environment', 'Rev', 'Deployed', 'Service account'].map((h) => el('th', { text: h })))),
      el('tbody', {}, deps.map((r) => el('tr', { className: activeEnvs.includes(r.environment) ? 'highlight' : '' }, [
        el('td', {}, el('strong', { text: r.proxy })),
        el('td', {}, chip(r.environment, r.environment && r.environment.includes('prod') ? 'red' : 'green')),
        el('td', { className: 's-mono', text: r.revision }),
        el('td', { text: fmtTime(r.deployedAt, false), title: r.deployedAt }),
        el('td', { className: 's-mono', text: shortSa(r.serviceAccount) || '— none —', title: r.serviceAccount }),
      ]))),
    ])), deps.length));

    // Products
    const prods = d.products || [];
    nodes.push(card('API products', prods.map((p) => el('div', { className: 's-sub-item' }, [
      el('div', { className: 's-sub-head' }, [
        el('div', {}, [el('div', { className: 's-sub-name', text: p.name }), el('div', { className: 's-sub-meta', text: p.displayName })]),
        el('div', {}, (p.environments || []).map((e) => chip(e, e.includes('prod') ? 'red' : 'green'))),
      ]),
      el('div', {}, [
        ...(p.proxies || []).map((x) => chip(`proxy: ${x}`, 'orange')),
        chip(`${p.operations} operations`),
        chip(`approval: ${p.approval || '—'}`),
        p.quota ? chip(`quota ${p.quota}`, 'purple') : null,
        ...Object.entries(p.attributes || {}).map(([k, v]) => chip(`${k}=${v}`, '', 'product attribute')),
      ]),
      ...(p.controls || []).map((c) => el('div', { className: 's-sub-meta', style: { 'margin-top': '4px' } }, [
        el('span', { className: 's-mono', text: (c.operations || []).join(', ') }),
        c.quota ? chip(`quota ${c.quota}`, 'purple') : null,
        ...Object.entries(c.attributes || {}).map(([k, v]) => chip(`${k}=${v}`, 'sky')),
      ])),
    ])), prods.length));

    // Developer apps
    const apps = d.apps || [];
    nodes.push(card('Developer apps', apps.map((a) => el('div', { className: 's-sub-item' }, [
      el('div', { className: 's-sub-head' }, [
        el('div', {}, [
          el('div', { className: 's-sub-name', text: a.name }),
          el('div', { className: 's-sub-meta', text: `Developer: ${a.developer || '—'} • created ${fmtTime(a.createdAt, false)}` }),
        ]),
        chip(a.status || '—', a.status === 'approved' ? 'green' : 'red'),
      ]),
      el('div', {}, Object.entries(a.attributes || {}).map(([k, v]) => chip(`${k}: ${v}`, '', 'app attribute'))),
      ...(a.credentials || []).map((c) => el('div', { className: 's-sub-meta', style: { 'margin-top': '6px' } }, [
        '🔑 ',
        el('span', { className: 's-mono', text: shortFp(c.keyFingerprint), title: c.keyFingerprint }),
        ' ',
        chip(c.status || '—', c.status === 'approved' ? 'green' : 'red'),
        ...(c.products || []).map((x) => chip(x, 'blue')),
        c.expiresAt ? chip(`expires ${fmtTime(c.expiresAt, false)}`) : chip('no expiry'),
      ])),
    ])), apps.length));

    // Backend + observability
    const be = d.backend || {};
    const obs = d.observability || {};
    nodes.push(el('div', { className: 's-grid-2 s-section-gap' }, [
      card('Backend (Cloud Run)', kv([
        ['Service', be.service],
        ['Region', be.region],
        ['URL', be.url ? safeLink(be.url) : '—'],
        ['Revision', be.latestRevision],
        ['Updated', fmtTime(be.updatedAt, false)],
        ['Ingress', be.ingress],
      ])),
      card('Observability', kv([
        ['GCP project', d.project],
        ['Audit log', el('span', { className: 's-mono', text: obs.logName })],
        ['Console', obs.consoleUrl ? safeLink(obs.consoleUrl, 'Open in Cloud Logging ↗') : '—'],
        ['Fetched', `${fmtTime(d.fetchedAt)}${d.cached ? ' (cached)' : ''}`],
      ])),
    ]));

    this.hostingPane.replaceChildren(...nodes);
  }

  // ============================================================ LOGS
  async loadLogs(refresh = false) {
    const s = this.state;
    const qs = new URLSearchParams({
      range: s.range, event: s.event, env: s.env, page: String(s.page), pageSize: String(s.pageSize),
    });
    if (refresh) qs.set('refresh', '1');
    const ticket = Symbol('logs');
    this.inflight = ticket;
    this.setSpinning(true);
    this.logsMeta.textContent = 'Loading…';
    if (!this.logsLoaded) {
      this.overviewPane.replaceChildren(el('div', { className: 's-skeleton' }), el('div', { className: 's-skeleton' }));
      this.entriesPane.replaceChildren(el('div', { className: 's-skeleton' }), el('div', { className: 's-skeleton' }));
    }
    try {
      const { status, body } = await this.api(`/api/settings/logs?${qs.toString()}`);
      if (this.inflight !== ticket) return; // a newer request superseded this one
      if (status !== 200) {
        this.logsMeta.textContent = '';
        this.setEntriesCount(null);
        this.renderGate(this.overviewPane, status, body);
        this.renderGate(this.entriesPane, status, body);
        return;
      }
      this.logsLoaded = true;
      this.renderLogs(body);
    } catch {
      if (this.inflight === ticket) {
        const err = { message: 'Network error while loading logs.' };
        this.renderGate(this.overviewPane, 0, err);
        this.renderGate(this.entriesPane, 0, err);
      }
    } finally {
      if (this.inflight === ticket) this.setSpinning(false);
    }
  }

  syncEnvOptions(envs) {
    const current = this.state.env;
    const opts = [el('option', { text: 'All environments', attrs: { value: 'all' } })];
    for (const e of envs) opts.push(el('option', { text: e, attrs: { value: e } }));
    if (current !== 'all' && !envs.includes(current)) opts.push(el('option', { text: current, attrs: { value: current } }));
    this.envFilter.replaceChildren(...opts);
    this.envFilter.value = current;
  }

  renderLogs(d) {
    const a = d.aggregates || {};
    const k = a.kpis || {};
    this.syncEnvOptions((d.filters || {}).environments || []);
    this.logsMeta.textContent = `${d.logName} • updated ${fmtTime(d.fetchedAt)}`
      + `${d.truncated ? ' • showing the most recent 5,000 entries' : ''}`;
    this.setEntriesCount((d.page || {}).total ?? 0);

    if (!k.total) {
      const errorsOnly = (d.filters || {}).event === 'errors';
      const empty = () => el('div', { className: 's-card s-empty' }, errorsOnly ? [
        el('strong', { text: '✅ No gateway errors in this window' }),
        'No 4xx / 5xx responses were recorded. Try a wider range to look further back.',
      ] : [
        el('strong', { text: 'No audit events in this window' }),
        'Try a wider range, or log in and chat (guest calls are not audited). Quota and large-order violations are logged too.',
      ]);
      this.overviewPane.replaceChildren(empty());
      this.entriesPane.replaceChildren(empty());
      return;
    }

    const kpi = (label, value, hint, accent, onClick) => {
      const node = el('div', { className: `kpi-card${onClick ? ' kpi-clickable' : ''}`, style: { '--kpi-accent': accent } }, [
        el('div', { className: 'kpi-label', text: label }),
        el('div', { className: 'kpi-value', text: value }),
        hint ? el('div', { className: 'kpi-hint', text: hint }) : null,
      ]);
      if (onClick) {
        node.setAttribute('role', 'button');
        node.setAttribute('tabindex', '0');
        node.title = 'Show these entries';
        node.addEventListener('click', onClick);
        node.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onClick(); } });
      }
      return node;
    };
    const errHint = k.errors
      ? `${k.deniedRate}% • ${k.authErrors} auth • ${k.rateLimited} 429 • ${k.serverErrors} 5xx`
      : 'no 4xx / 5xx';

    this.overviewPane.replaceChildren(
      el('div', { className: 'kpi-grid' }, [
        kpi('Events', k.total.toLocaleString(), `range ${d.range}`, 'var(--google-blue)'),
        kpi('Errors', (k.errors || 0).toLocaleString(), errHint, ERROR_COLOR, k.errors ? () => this.showErrors() : null),
        kpi('Violations', k.violations, 'quota + large order', 'var(--danger)'),
        kpi('Quota 429', k.quotaExceeded, '> 3 placeOrder / min', 'var(--apigee-orange)'),
        kpi('Large order 422', k.largeOrders, k.maxRejectedOrder ? `max $${k.maxRejectedOrder.toFixed(2)}` : 'orders > $100', 'var(--danger)'),
        kpi('End users', k.uniqueUsers, `${k.uniqueApps} client app(s)`, 'var(--role-manager)'),
      ]),
      card('Recent errors (HTTP 4xx / 5xx)', this.recentErrors(a.recentErrors || [], k.lastErrorAt), k.errors || 0),
      card('Events over time', this.timelineChart(a.timeline)),
      el('div', { className: 's-grid-2 s-grid-3 s-section-gap' }, [
        card('Errors by status', this.barList((a.errorsByStatus || []).map((x) => ({ ...x, color: this.statusColor(x.label) })),
          ERROR_COLOR, 'No errors in range')),
        card('Errors by tool / path', this.barList(a.errorPaths, ERROR_COLOR, 'No errors in range')),
        card('Event mix', this.donut(a.byEvent || [], k.total)),
        card('End-user roles (from IdP JWT)', this.roleSplit(a.byRole || [])),
        card('Top violators', this.barList(a.topViolators, 'var(--danger)', 'No violations in range')),
        card('MCP tools / API paths', this.barList(a.topPaths, 'var(--google-blue)')),
        card('Response status', this.barList((a.byStatus || []).map((x) => ({ ...x, color: this.statusColor(x.label) })))),
        card('Consumers (client_id)', this.barList(a.topClients, 'var(--apigee-orange)')),
        card('Environments', this.barList(a.byEnvironment, 'var(--success)')),
        card('Proxies', this.barList(a.byProxy, 'var(--role-customer)')),
      ]),
    );
    this.entriesPane.replaceChildren(
      card('Audit entries (click a row to expand consumer & JWT details)',
        [this.table(d.entries || []), this.pager(d.page)], (d.page || {}).total),
    );
  }

  /** Newest error responses, one line each; click opens the filtered entries tab. */
  recentErrors(items, lastAt) {
    if (!items.length) {
      return el('div', { className: 's-muted', text: '✅ No 4xx / 5xx responses in this range.', style: { 'font-size': '12px' } });
    }
    const list = el('div', { className: 'err-list' }, items.map((e) => {
      const row = el('div', { className: 'err-row', attrs: { role: 'button', tabindex: '0' }, title: e.ts }, [
        el('span', { className: `status-pill ${statusClass(e.status)}`, text: e.status }),
        el('span', { className: 'err-what s-mono', text: e.tool || `${e.verb} ${e.path}`.trim() || '—' }),
        el('span', { className: 'err-who', text: e.user || e.clientId || e.role || '—' }),
        el('span', { className: `ev-badge ${e.event}`, text: (EVENT_META[e.event] || {}).short || e.event }),
        el('span', { className: 'err-when s-sub-meta', text: relTime(e.ts) }),
      ]);
      const go = () => this.showErrors();
      row.addEventListener('click', go);
      row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
      return row;
    }));
    const foot = el('div', { className: 's-sub-meta', style: { 'margin-top': '8px' } }, [
      lastAt ? `Last error ${relTime(lastAt)} • ` : '',
      el('button', { className: 'pager-btn', text: 'View all errors →', attrs: { type: 'button' } }),
    ]);
    foot.querySelector('button').addEventListener('click', () => this.showErrors());
    return [list, foot];
  }

  statusColor(code) {
    const c = statusClass(code);
    return c === 'ok' ? 'var(--success)' : c === 'warn' ? 'var(--warning)' : c === 'err' ? 'var(--danger)' : 'var(--text-dim)';
  }

  // ---------------- widgets
  timelineChart(tl) {
    const buckets = (tl && tl.buckets) || [];
    const W = 1200, H = 200, padL = 30, padB = 22, padT = 8, padR = 6;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const events = Object.keys(EVENT_META);
    const max = Math.max(1, ...buckets.map((b) => Math.max(b.errors || 0, events.reduce((s, e) => s + (b[e] || 0), 0))));
    const bw = innerW / Math.max(1, buckets.length);
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': 'Audit events over time' });

    for (let i = 0; i <= 4; i += 1) {
      const y = padT + innerH - (innerH * i) / 4;
      root.appendChild(svg('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: 'chart-grid' }));
      const lbl = svg('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end', class: 'chart-axis' });
      lbl.textContent = String(Math.round((max * i) / 4));
      root.appendChild(lbl);
    }

    const step = tl ? tl.stepSeconds : 3600;
    const labelEvery = Math.ceil(buckets.length / 6);
    buckets.forEach((b, i) => {
      let y = padT + innerH;
      const x = padL + i * bw + bw * 0.12;
      const w = Math.max(1, bw * 0.76);
      const total = events.reduce((s, e) => s + (b[e] || 0), 0);
      const g = svg('g', {}, [svgTitle(`${fmtTime(b.start, false)} — ${total} event(s)\n`
        + events.map((e) => `${EVENT_META[e].label}: ${b[e] || 0}`).join('\n') + `\nErrors (4xx/5xx): ${b.errors || 0}`)]);
      // invisible hit area so the tooltip works on empty buckets too
      g.appendChild(svg('rect', { x: padL + i * bw, y: padT, width: bw, height: innerH, fill: 'transparent' }));
      for (const e of events) {
        const v = b[e] || 0;
        if (!v) continue;
        const h = (innerH * v) / max;
        y -= h;
        g.appendChild(svg('rect', { x, y, width: w, height: h, rx: 2, style: `fill:${EVENT_META[e].color}` }));
      }
      root.appendChild(g);
      if (i % labelEvery === 0) {
        const d = new Date(b.start);
        const t = svg('text', { x: padL + i * bw + bw / 2, y: H - 6, 'text-anchor': 'middle', class: 'chart-axis' });
        t.textContent = step >= 86400
          ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          : step >= 3 * 3600
            ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' })
            : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        root.appendChild(t);
      }
    });

    // Errors (HTTP 4xx/5xx) as a line over the stacked event bars.
    if (buckets.some((b) => b.errors)) {
      const pts = buckets.map((b, i) => `${padL + i * bw + bw / 2},${padT + innerH - (innerH * (b.errors || 0)) / max}`).join(' ');
      root.appendChild(svg('polyline', { points: pts, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', style: `stroke:${ERROR_COLOR}`, 'pointer-events': 'none' }));
      buckets.forEach((b, i) => {
        if (!b.errors) return;
        root.appendChild(svg('circle', { cx: padL + i * bw + bw / 2, cy: padT + innerH - (innerH * b.errors) / max, r: 3, style: `fill:${ERROR_COLOR}`, 'pointer-events': 'none' }));
      });
    }

    const legend = el('div', { className: 'legend' }, [
      ...events.map((e) => el('span', { className: 'legend-item' }, [
        el('span', { className: 'legend-swatch', style: { background: EVENT_META[e].color } }),
        EVENT_META[e].label,
      ])),
      el('span', { className: 'legend-item' }, [
        el('span', { className: 'legend-swatch legend-line', style: { background: ERROR_COLOR } }),
        'Errors (4xx / 5xx)',
      ]),
    ]);
    return [root, legend];
  }

  donut(items, total) {
    const R = 46, C = 2 * Math.PI * R;
    const root = svg('svg', { viewBox: '0 0 120 120', role: 'img', 'aria-label': 'Event mix' });
    root.appendChild(svg('circle', { cx: 60, cy: 60, r: R, fill: 'none', 'stroke-width': 14, style: 'stroke:var(--bg-tertiary)' }));
    let offset = 0;
    for (const it of items) {
      const frac = total ? it.count / total : 0;
      const meta = EVENT_META[it.label] || { color: 'var(--text-dim)', label: it.label };
      root.appendChild(svg('circle', {
        cx: 60, cy: 60, r: R, fill: 'none', 'stroke-width': 14,
        'stroke-dasharray': `${frac * C} ${C}`, 'stroke-dashoffset': -offset * C,
        transform: 'rotate(-90 60 60)', style: `stroke:${meta.color}`,
      }, [svgTitle(`${meta.label}: ${it.count}`)]));
      offset += frac;
    }
    const v = svg('text', { x: 60, y: 62, 'text-anchor': 'middle', class: 'donut-center-value' });
    v.textContent = String(total);
    const l = svg('text', { x: 60, y: 76, 'text-anchor': 'middle', class: 'donut-center-label' });
    l.textContent = 'events';
    root.append(v, l);

    const legend = el('div', { className: 'bar-list', style: { flex: '1' } }, items.map((it) => {
      const meta = EVENT_META[it.label] || { color: 'var(--text-dim)', label: it.label };
      const pct = total ? Math.round((100 * it.count) / total) : 0;
      return el('div', { className: 'bar-row-head' }, [
        el('span', { className: 'legend-item' }, [
          el('span', { className: 'legend-swatch', style: { background: meta.color } }), meta.label]),
        el('span', { className: 'bar-row-count', text: `${it.count} (${pct}%)` }),
      ]);
    }));
    return el('div', { className: 'donut-wrap' }, [root, legend]);
  }

  roleSplit(items) {
    const total = items.reduce((s, x) => s + x.count, 0) || 1;
    const bar = el('div', { className: 'stack-bar' }, items.map((x) => el('div', {
      className: 'stack-seg',
      title: `${x.label}: ${x.count}`,
      style: { width: `${(100 * x.count) / total}%`, background: ROLE_COLORS[x.label] || 'var(--text-dim)' },
    })));
    const legend = el('div', { className: 'legend' }, items.map((x) => el('span', { className: 'legend-item' }, [
      el('span', { className: 'legend-swatch', style: { background: ROLE_COLORS[x.label] || 'var(--text-dim)' } }),
      `${x.label} — ${x.count} (${Math.round((100 * x.count) / total)}%)`,
    ])));
    const note = el('div', { className: 's-sub-meta', style: { 'margin-top': '8px' },
      text: 'Role comes from the Keycloak JWT verified by Biscuit-Coffee-Shop; MCP quota events derive it from the token scope.' });
    return [bar, legend, note];
  }

  barList(items, color, emptyText = 'No data') {
    if (!items || !items.length) return el('div', { className: 's-muted', text: emptyText, style: { 'font-size': '12px' } });
    const max = Math.max(...items.map((x) => x.count), 1);
    return el('div', { className: 'bar-list' }, items.map((x) => el('div', { className: 'bar-row' }, [
      el('div', { className: 'bar-row-head' }, [
        el('span', { className: 'bar-row-label', text: x.label, title: x.label }),
        el('span', { className: 'bar-row-count', text: x.count }),
      ]),
      el('div', { className: 'bar-track' }, el('div', {
        className: 'bar-fill', style: { width: `${(100 * x.count) / max}%`, '--bar-color': x.color || color },
      })),
    ])));
  }

  // ---------------- table + paging
  table(entries) {
    const head = el('thead', {}, el('tr', {},
      ['Time', 'Event', 'End user', 'Consumer', 'Tool / path', 'Env', 'Status'].map((h) => el('th', { text: h }))));
    const body = el('tbody');
    for (const e of entries) {
      const key = e.id || `${e.ts}-${e.correlationId}`;
      const isErr = parseInt(e.status, 10) >= 400;
      const row = el('tr', { className: `s-row${isErr ? ' s-row-error' : ''}${this.expanded.has(key) ? ' expanded' : ''}`, attrs: { tabindex: '0' } }, [
        el('td', { title: e.ts }, [el('div', { text: fmtTime(e.ts) }), el('div', { className: 's-sub-meta', text: relTime(e.ts) })]),
        el('td', {}, el('span', { className: `ev-badge ${e.event}`, text: (EVENT_META[e.event] || {}).short || e.event })),
        el('td', {}, [
          el('div', { text: e.user || '—' }),
          e.role ? chip(e.roleVerified ? e.role : `${e.role}*`, e.role === 'manager' ? 'purple' : e.role === 'customer' ? 'sky' : '',
            e.roleVerified ? 'role verified from JWT' : 'role derived from token scope (JWT not verified on this proxy)') : null,
        ]),
        el('td', {}, [
          el('div', { className: 's-mono', text: e.clientId || '—' }),
          e.app ? el('div', { className: 's-sub-meta', text: e.app }) : null,
        ]),
        el('td', {}, [
          el('div', { className: 's-mono', text: e.tool || e.path || '—' }),
          e.tool && e.path ? el('div', { className: 's-sub-meta', text: `${e.verb} ${e.path}` }) : null,
        ]),
        el('td', {}, [el('div', { text: e.environment || '—' }), el('div', { className: 's-sub-meta', text: `${e.proxy} r${e.revision}` })]),
        el('td', {}, el('span', { className: `status-pill ${statusClass(e.status)}`, text: e.status || '—' })),
      ]);
      const toggle = () => {
        if (this.expanded.has(key)) this.expanded.delete(key); else this.expanded.add(key);
        const open = this.expanded.has(key);
        row.classList.toggle('expanded', open);
        detail.hidden = !open;
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
      const detail = el('tr', { className: 's-detail' }, el('td', { attrs: { colspan: '7' } }, this.detail(e)));
      detail.hidden = !this.expanded.has(key);
      body.append(row, detail);
    }
    return el('div', { className: 's-table-wrap' }, el('table', { className: 's-table' }, [head, body]));
  }

  detail(e) {
    const pre = (obj) => el('pre', { className: 'detail-pre', text: JSON.stringify(obj, null, 2) });
    return el('div', { className: 'detail-grid' }, [
      el('div', {}, [
        el('div', { className: 'detail-label', text: 'Consumer' }),
        kv([
          ['API key', el('span', { className: 's-mono', text: shortFp(e.keyFingerprint), title: e.keyFingerprint })],
          ['Client ID', e.clientId],
          ['App', e.app],
          ['Developer', e.developer],
          ['Product', e.product],
          ['Products on key', e.productsOnKey],
          ['Client IP', e.clientIp],
        ]),
        el('div', { className: 'detail-label', text: 'Custom attributes', style: { 'margin-top': '10px' } }),
        pre(e.attributes || {}),
      ]),
      el('div', {}, [
        el('div', { className: 'detail-label', text: 'End user (IdP JWT)' }),
        kv([
          ['User', e.user],
          ['Subject', el('span', { className: 's-mono', text: e.userSub || '—' })],
          ['Role', `${e.role}${e.roleVerified ? ' (verified)' : ' (from scope)'}`],
          ['Scope', el('span', { className: 's-mono', text: e.scope || '—' })],
          ['JTI', el('span', { className: 's-mono', text: e.jti || '—' })],
          ['Correlation', el('span', { className: 's-mono', text: e.correlationId || '—' })],
        ]),
        el('div', { className: 'detail-label', text: 'Event detail', style: { 'margin-top': '10px' } }),
        pre(e.detail || {}),
      ]),
    ]);
  }

  pager(p) {
    if (!p) return null;
    const { number, pages, total, size } = p;
    const from = total ? (number - 1) * size + 1 : 0;
    const to = Math.min(total, number * size);
    const go = (n) => { this.state.page = n; this.expanded.clear(); this.loadLogs(); };
    const btn = (label, n, opts = {}) => {
      const b = el('button', { className: `pager-btn${opts.active ? ' active' : ''}`, text: label, attrs: { type: 'button' } });
      if (opts.disabled) b.disabled = true;
      else if (!opts.active) b.addEventListener('click', () => go(n));
      if (opts.label) b.setAttribute('aria-label', opts.label);
      return b;
    };
    const buttons = [btn('‹', number - 1, { disabled: number <= 1, label: 'Previous page' })];
    const windowPages = new Set([1, pages, number - 1, number, number + 1].filter((n) => n >= 1 && n <= pages));
    let last = 0;
    for (const n of [...windowPages].sort((x, y) => x - y)) {
      if (n - last > 1) buttons.push(el('span', { className: 'pager-ellipsis', text: '…' }));
      buttons.push(btn(String(n), n, { active: n === number }));
      last = n;
    }
    buttons.push(btn('›', number + 1, { disabled: number >= pages, label: 'Next page' }));

    const sizeSel = el('select', { className: 'logs-select', attrs: { 'aria-label': 'Rows per page' } },
      [10, 25, 50].map((n) => el('option', { text: `${n} / page`, attrs: { value: n } })));
    sizeSel.value = String(size);
    sizeSel.addEventListener('change', () => {
      this.state.pageSize = parseInt(sizeSel.value, 10);
      this.state.page = 1;
      this.loadLogs();
    });

    return el('div', { className: 'pager' }, [
      el('span', { text: `Showing ${from}–${to} of ${total}` }),
      el('div', { className: 'pager-buttons' }, buttons),
      sizeSel,
    ]);
  }
}
