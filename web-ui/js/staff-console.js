/**
 * Staff console (UI_VARIANT=staff only): orders board, employees, store ops.
 *
 * Every panel talks to the BFF's /api/staff/* endpoints with the signed-in
 * user's Keycloak token. The BFF runs the matching MCP tool on Apigee with that
 * token, so Apigee decides what each role may do; manager panels are merely
 * hidden for normal staff and any 403 from Apigee is shown as-is.
 *
 * Rendering uses createElement/textContent only (no innerHTML): order, menu and
 * employee data are treated as untrusted.
 */

import {
  BOARD_COLUMNS, BULK_ACTIONS, BULK_CONFIRM_OVER, DATE_RANGES, DAYS, ORDER_FETCH_LIMIT, SELECTABLE_STATUSES,
  bucketOrders, bulkPlan, bulkSummary, decisionOutcome, extractList, extractOrders, filterByRange, formatMoney,
  friendlyError, isSelectable, itemsSummary, maskPII, newPendingOrders, nextActions, normalizeStatus, orderId,
  pendingIds, pruneSelection, sortNewestFirst, validRange, validateHours, validatePrice,
} from './staff-utils.js';
import { StaffAlerts } from './staff-alerts.js';

const BOARD_REFRESH_MS = 10000;
const LS_RANGE = 'biscuit.staff.orderRange';

function lsGet(key) {
  try { return window.localStorage.getItem(key); } catch (e) { return null; }
}

function lsSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch (e) { /* private mode: not persisted */ }
}

/** Tiny DOM builder: el('div', {class: 'x', text: 'y', onclick: fn}, [children]). */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') node.textContent = String(v);
    else if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function setBanner(node, kind, text) {
  if (!node) return;
  node.className = `staff-banner ${kind || ''}`;
  node.textContent = text || '';
  node.hidden = !text;
}

export class StaffConsole {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('staffConsole');
    this.tabBar = document.getElementById('staffTabBar');
    this.chatArea = document.getElementById('chatLayoutArea');
    this.activeTab = 'orders';
    this.boardTimer = null;
    this.boardBusy = false;
    this.loaded = {};
    this.knownPending = null; // pending order ids at the last refresh (null = first load)
    this.selected = new Set(); // order ids ticked for bulk actions
    this.allOrders = [];       // last fetched orders (unfiltered)
    this.visibleOrders = [];   // after the date filter, newest first
    if (!this.root || !this.tabBar) return;

    this.alerts = new StaffAlerts({ onOpenOrders: (id) => this.openOrder(id) });
    this.buildPanes();
    this.tabBar.querySelectorAll('[data-staff-tab]').forEach((btn) => {
      btn.addEventListener('click', () => this.showTab(btn.dataset.staffTab));
    });
    window.addEventListener('biscuit:personachange', () => this.onPersonaChange());
    document.addEventListener('visibilitychange', () => this.syncBoardTimer());
    this.showTab('orders');
  }

  // ------------------------------------------------------------------ plumbing
  isSignedIn() {
    const id = this.app.currentRole && this.app.currentRole.id;
    return id === 'staff' || id === 'manager';
  }

  isManager() {
    return !!(this.app.currentRole && this.app.currentRole.id === 'manager');
  }

  async api(method, path, body) {
    const token = await this.app.agentClient.ensureFreshToken(this.app.agentClient.userId);
    if (!token || !token.access_token) return { ok: false, status: 401, body: {} };
    try {
      const res = await fetch(path, {
        method,
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 403 && json && json.error === 'role_not_allowed') {
        // Gate refused this token server-side: drop it and show the message.
        this.app.agentClient.clearStoredToken();
        this.app.agentClient.lastGateMessage = json.message;
        this.app.refreshAuthUI();
      }
      return { ok: res.ok, status: res.status, body: json || {} };
    } catch (e) {
      return { ok: false, status: 0, body: { message: 'Network error: the staff app server is unreachable.' } };
    }
  }

  showTab(tab) {
    if (!this.isManager() && (tab === 'employees' || tab === 'store')) tab = 'orders';
    this.activeTab = tab;
    this.tabBar.querySelectorAll('[data-staff-tab]').forEach((b) => {
      const on = b.dataset.staffTab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const chat = tab === 'chat';
    this.root.hidden = chat;
    if (this.chatArea) this.chatArea.style.display = chat ? 'flex' : 'none';
    Object.entries(this.panes).forEach(([k, p]) => { p.hidden = k !== tab; });
    if (tab === 'orders') this.refreshBoard();
    if (tab === 'employees' && !this.loaded.employees) this.loadEmployees();
    if (tab === 'store' && !this.loaded.store) this.loadStore();
    this.syncBoardTimer();
  }

  onPersonaChange() {
    const signedIn = this.isSignedIn();
    this.root.classList.toggle('signed-out', !signedIn);
    if (!signedIn) {
      this.loaded = {};
      this.knownPending = null;
      this.alerts.reset();
      this.clearBoard('Sign in with a staff or store manager account to see the orders board.');
    } else if (!this.lastBoardOk) {
      this.refreshBoard();
    }
    if (!this.isManager() && (this.activeTab === 'employees' || this.activeTab === 'store')) this.showTab('orders');
    this.syncBoardTimer();
  }

  /**
   * The board refreshes every 10 s whenever someone is signed in, on any tab and
   * also while the browser tab is in the background: that refresh drives the
   * pending-approval counter, toasts and notifications.
   */
  syncBoardTimer() {
    const want = this.isSignedIn();
    if (want && !this.boardTimer) {
      this.boardTimer = setInterval(() => this.refreshBoard(), BOARD_REFRESH_MS);
    } else if (!want && this.boardTimer) {
      clearInterval(this.boardTimer);
      this.boardTimer = null;
    }
  }

  // ------------------------------------------------------------------ layout
  buildPanes() {
    this.root.replaceChildren();
    this.panes = {
      orders: this.buildOrdersPane(),
      employees: this.buildEmployeesPane(),
      store: this.buildStorePane(),
    };
    Object.values(this.panes).forEach((p) => this.root.appendChild(p));
  }

  paneHeader(title, subtitle, actions = []) {
    return el('div', { class: 'staff-pane-header' }, [
      el('div', {}, [el('h2', { class: 'staff-pane-title', text: title }),
        el('p', { class: 'staff-pane-subtitle', text: subtitle })]),
      el('div', { class: 'staff-pane-actions' }, actions),
    ]);
  }

  // ------------------------------------------------------------------ orders board
  buildOrdersPane() {
    this.boardStamp = el('span', { class: 'staff-stamp', text: '' });
    this.boardBanner = el('div', { class: 'staff-banner', hidden: true });

    // Date range filter (persisted). Sorting is always newest first.
    this.range = validRange(lsGet(LS_RANGE));
    this.rangeSelect = el('select', { class: 'staff-input', 'aria-label': 'Show orders from' },
      DATE_RANGES.map((r) => el('option', { value: r.key, text: r.label, selected: r.key === this.range })));
    this.rangeSelect.addEventListener('change', () => this.setRange(this.rangeSelect.value));

    // Notes under the toolbar: "showing latest 200", "N older pending orders hidden".
    this.limitNote = el('span', { class: 'staff-board-note', hidden: true });
    this.hiddenPendingNote = el('span', { class: 'staff-board-note warn', hidden: true });

    // Bulk actions over the selected In progress / Ready orders.
    this.selectAll = el('input', { type: 'checkbox', 'aria-label': 'Select all visible orders that can be updated' });
    this.selectAll.addEventListener('change', () => this.toggleSelectAll(this.selectAll.checked));
    this.selCount = el('span', { class: 'staff-sel-count', text: '0 selected' });
    this.bulkButtons = Object.entries(BULK_ACTIONS).map(([target, a]) => el('button', {
      type: 'button', class: `staff-btn ${target === 'READY' ? 'progress' : 'approve'}`, text: a.label, disabled: true,
      dataset: { bulk: target }, onclick: () => this.runBulk(target),
    }));
    this.clearSelBtn = el('button', { type: 'button', class: 'staff-btn ghost', text: 'Clear', disabled: true, onclick: () => this.setSelection(new Set()) });
    this.bulkProgress = el('span', { class: 'staff-bulk-progress', role: 'status', 'aria-live': 'polite', text: '' });

    this.boardCols = {};
    const cols = BOARD_COLUMNS.map((c) => {
      const list = el('div', { class: 'staff-col-list' });
      const count = el('span', { class: 'staff-col-count', text: '0' });
      let colCheck = null;
      if (c.statuses.some((s) => SELECTABLE_STATUSES.includes(s))) {
        colCheck = el('input', { type: 'checkbox', class: 'staff-col-select', 'aria-label': `Select all ${c.title} orders` });
        colCheck.addEventListener('change', () => this.toggleColumn(c.key, colCheck.checked));
      }
      this.boardCols[c.key] = { list, count, colCheck };
      return el('section', { class: `staff-col col-${c.key.toLowerCase()}` }, [
        el('div', { class: 'staff-col-head' }, [
          el('label', { class: 'staff-col-title' }, [colCheck, el('span', { text: c.title })]),
          count,
        ]),
        list,
      ]);
    });
    return el('div', { class: 'staff-pane', id: 'staffOrdersPane' }, [
      this.paneHeader('Orders board', 'All customers · newest first · refreshes every 10 s · orders over the approval threshold wait here for staff or the store manager', [
        this.boardStamp,
        ...this.alerts.buildControls(),
        el('button', { type: 'button', class: 'staff-btn ghost', text: 'Refresh', onclick: () => this.refreshBoard(true) }),
      ]),
      el('div', { class: 'staff-board-toolbar' }, [
        el('label', { class: 'staff-check' }, [el('span', { text: 'Show' }), this.rangeSelect]),
        el('span', { class: 'staff-toolbar-sep' }),
        el('label', { class: 'staff-check' }, [this.selectAll, el('span', { text: 'Select all' })]),
        this.selCount,
        ...this.bulkButtons,
        this.clearSelBtn,
        this.bulkProgress,
      ]),
      el('div', { class: 'staff-board-notes' }, [this.limitNote, this.hiddenPendingNote]),
      this.boardBanner,
      el('div', { class: 'staff-board' }, cols),
    ]);
  }

  clearBoard(message) {
    Object.values(this.boardCols || {}).forEach(({ list, count }) => { list.replaceChildren(); count.textContent = '0'; });
    this.lastBoardOk = false;
    this.allOrders = [];
    this.visibleOrders = [];
    this.setSelection(new Set());
    if (this.limitNote) this.limitNote.hidden = true;
    if (this.hiddenPendingNote) this.hiddenPendingNote.hidden = true;
    setBanner(this.boardBanner, 'info', message);
  }

  setRange(key) {
    this.range = validRange(key);
    this.rangeSelect.value = this.range;
    lsSet(LS_RANGE, this.range);
    this.renderBoard(this.allOrders || []);
  }

  async refreshBoard(manual = false, force = false) {
    if (!this.isSignedIn()) {
      this.clearBoard('Sign in with a staff or store manager account to see the orders board.');
      return;
    }
    if (this.boardBusy || this.bulkBusy) return;
    this.boardBusy = true;
    try {
      const r = await this.api('GET', `/api/staff/orders?limit=${ORDER_FETCH_LIMIT}`);
      if (!r.ok) {
        this.lastBoardOk = false;
        setBanner(this.boardBanner, r.status === 501 ? 'info' : 'error', friendlyError(r.status, r.body));
        return;
      }
      this.lastBoardOk = true;
      if (manual || (this.boardBanner.classList.contains('error') || this.boardBanner.classList.contains('info'))) {
        setBanner(this.boardBanner, '', '');
      }
      const orders = extractOrders(r.body.data);
      this.allOrders = orders;
      // A background refresh must not wipe a reject reason that is being typed.
      const editing = !manual && !force && this.root.querySelector('.staff-card-actions input[type="text"]');
      if (!editing) this.renderBoard(orders);
      // Alerts and the counter look at ALL fetched orders, whatever the date filter.
      this.updateAlerts(orders);
      this.boardStamp.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    } finally {
      this.boardBusy = false;
    }
  }

  updateAlerts(orders) {
    const fresh = newPendingOrders(this.knownPending, orders);
    this.knownPending = pendingIds(orders);
    this.alerts.setCount(this.knownPending.size);
    this.alerts.announce(fresh);
  }

  /** Toast / notification / header badge click: show the board and highlight the order. */
  openOrder(id) {
    if (this.activeTab !== 'orders') this.showTab('orders');
    if (!id) return;
    let card = Array.from(this.root.querySelectorAll('.staff-card')).find((c) => c.dataset.orderId === id);
    if (!card && this.range !== 'all' && (this.allOrders || []).some((o) => orderId(o) === id)) {
      // Hidden by the date filter: show everything so the order can be reviewed.
      this.setRange('all');
      card = Array.from(this.root.querySelectorAll('.staff-card')).find((c) => c.dataset.orderId === id);
    }
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 2000);
    }
  }

  renderBoard(orders) {
    const all = orders || [];
    const visible = sortNewestFirst(filterByRange(all, this.range));
    this.visibleOrders = visible;
    const buckets = bucketOrders(visible);
    for (const c of BOARD_COLUMNS) {
      const { list, count } = this.boardCols[c.key];
      const items = buckets[c.key] || [];
      count.textContent = String(items.length);
      list.replaceChildren(...(items.length
        ? items.map((o) => this.orderCard(o))
        : [el('div', { class: 'staff-empty', text: this.range === 'all' ? 'No orders' : 'No orders in this period' })]));
    }

    this.limitNote.hidden = all.length < ORDER_FETCH_LIMIT;
    this.limitNote.textContent = `Showing the latest ${ORDER_FETCH_LIMIT} orders.`;

    const hiddenPending = pendingIds(all).size - pendingIds(visible).size;
    this.hiddenPendingNote.replaceChildren();
    this.hiddenPendingNote.hidden = hiddenPending <= 0;
    if (hiddenPending > 0) {
      this.hiddenPendingNote.append(
        `${hiddenPending} older pending order${hiddenPending === 1 ? ' is' : 's are'} hidden by the date filter. `,
        el('button', { type: 'button', class: 'staff-link', text: 'Show all orders', onclick: () => this.setRange('all') }),
      );
    }

    // Selection survives refreshes: keep ids that are still visible and selectable.
    this.setSelection(pruneSelection(this.selected, visible));
  }

  // ------------------------------------------------------------------ selection + bulk actions
  setSelection(sel) {
    this.selected = sel instanceof Set ? sel : new Set();
    if (!this.boardCols) return;
    this.root.querySelectorAll('.staff-select').forEach((cb) => { cb.checked = this.selected.has(cb.dataset.orderId); });
    const selectable = (this.visibleOrders || []).filter(isSelectable).map(orderId);
    const n = this.selected.size;
    this.selCount.textContent = `${n} selected`;
    this.selectAll.disabled = !selectable.length || !!this.bulkBusy;
    this.selectAll.checked = !!selectable.length && n === selectable.length;
    this.selectAll.indeterminate = n > 0 && n < selectable.length;
    for (const c of BOARD_COLUMNS) {
      const { colCheck } = this.boardCols[c.key];
      if (!colCheck) continue;
      const ids = (this.visibleOrders || []).filter((o) => isSelectable(o) && c.statuses.includes(normalizeStatus(o.status))).map(orderId);
      const picked = ids.filter((id) => this.selected.has(id)).length;
      colCheck.disabled = !ids.length || !!this.bulkBusy;
      colCheck.checked = !!ids.length && picked === ids.length;
      colCheck.indeterminate = picked > 0 && picked < ids.length;
    }
    this.bulkButtons.forEach((b) => { b.disabled = !n || !!this.bulkBusy; });
    this.clearSelBtn.disabled = !n || !!this.bulkBusy;
  }

  toggleSelectAll(on) {
    const ids = (this.visibleOrders || []).filter(isSelectable).map(orderId);
    this.setSelection(new Set(on ? ids : []));
  }

  toggleColumn(key, on) {
    const col = BOARD_COLUMNS.find((c) => c.key === key);
    const sel = new Set(this.selected);
    (this.visibleOrders || [])
      .filter((o) => isSelectable(o) && col.statuses.includes(normalizeStatus(o.status)))
      .forEach((o) => (on ? sel.add(orderId(o)) : sel.delete(orderId(o))));
    this.setSelection(sel);
  }

  toggleOne(id, on) {
    const sel = new Set(this.selected);
    if (on) sel.add(id); else sel.delete(id);
    this.setSelection(sel);
  }

  /**
   * Bulk "Mark ready" / "Complete": valid transitions only, one request at a
   * time through POST /api/staff/orders/{id}/status (keeps well under the BFF
   * rate limit), max BULK_MAX orders per run.
   */
  async runBulk(target) {
    if (this.bulkBusy) return;
    const action = BULK_ACTIONS[target];
    const plan = bulkPlan([...this.selected], this.allOrders || [], target);
    if (!plan.apply.length) {
      setBanner(this.boardBanner, 'warning', bulkSummary(action.label, { done: [], skipped: plan.skipped, failed: [] }));
      return;
    }
    if (target === 'COMPLETED' && plan.apply.length > BULK_CONFIRM_OVER
      && !window.confirm(`Mark ${plan.apply.length} orders as COMPLETED (picked up)?`)) {
      return;
    }
    this.bulkBusy = true;
    this.setSelection(this.selected);
    const done = [];
    const failed = [];
    try {
      for (let i = 0; i < plan.apply.length; i++) {
        const id = plan.apply[i];
        this.bulkProgress.textContent = `Updating ${i + 1}/${plan.apply.length}…`;
        const r = await this.api('POST', `/api/staff/orders/${encodeURIComponent(id)}/status`, { status: target });
        if (r.ok) done.push(id);
        else {
          failed.push({ id, reason: friendlyError(r.status, r.body) });
          if (r.status === 401 || r.status === 429) {
            // Session gone or rate limited: stop instead of failing the rest one by one.
            plan.apply.slice(i + 1).forEach((rest) => failed.push({ id: rest, reason: 'not attempted (stopped after the previous error)' }));
            break;
          }
        }
      }
    } finally {
      this.bulkBusy = false;
      this.bulkProgress.textContent = '';
    }
    const result = { done, skipped: plan.skipped, failed };
    setBanner(this.boardBanner, failed.length || plan.skipped.length ? 'warning' : 'success', bulkSummary(action.label, result));
    this.setSelection(new Set(failed.map((f) => f.id)));
    this.refreshBoard(false, true);
  }

  orderCard(order) {
    const id = orderId(order);
    const status = normalizeStatus(order.status);
    const who = order.name || order.customer_name || '';
    const email = order.email || order.customer_email || order.customer || '';
    const meta = [];
    if (who) meta.push(String(who));
    if (email) meta.push(maskPII('email', email));
    const approval = order.approval && typeof order.approval === 'object' ? order.approval : null;
    const actionsRow = el('div', { class: 'staff-card-actions' });
    const note = el('div', { class: 'staff-card-note', hidden: true });

    for (const a of (id ? nextActions(status) : [])) {
      actionsRow.appendChild(el('button', {
        type: 'button', class: `staff-btn ${a.style}`, text: a.label,
        onclick: () => (a.kind === 'decision' && a.value === 'REJECT'
          ? this.askRejectReason(id, actionsRow, note)
          : this.runOrderAction(id, a, null, actionsRow, note)),
      }));
    }

    return el('article', { class: `staff-card status-${status.toLowerCase()}`, dataset: { orderId: id } }, [
      el('div', { class: 'staff-card-top' }, [
        isSelectable(order) ? el('input', {
          type: 'checkbox', class: 'staff-select', dataset: { orderId: id }, 'aria-label': `Select order ${id}`,
          checked: (this.selected && this.selected.has(id)) || false, disabled: !!this.bulkBusy,
          onchange: (ev) => this.toggleOne(id, ev.target.checked),
        }) : null,
        el('strong', { class: 'staff-card-id', text: id ? `#${id}` : '(no id)' }),
        el('span', { class: `staff-status-tag s-${status.toLowerCase()}`, text: status.replace(/_/g, ' ') }),
      ]),
      meta.length ? el('div', { class: 'staff-card-meta', text: meta.join(' · ') }) : null,
      el('div', { class: 'staff-card-items', text: itemsSummary(order) || '—' }),
      el('div', { class: 'staff-card-bottom' }, [
        el('span', { class: 'staff-card-total', text: formatMoney(order.total_amount) }),
        approval && approval.decision
          ? el('span', { class: 'staff-card-decider', text: `${approval.decision}${approval.decided_by ? ` by ${maskPII('email', approval.decided_by)}` : ''}` })
          : null,
      ]),
      actionsRow,
      note,
    ]);
  }

  askRejectReason(id, actionsRow, note) {
    const input = el('input', { type: 'text', class: 'staff-input', maxlength: '200', placeholder: 'Reason (optional)', 'aria-label': 'Reject reason' });
    const confirm = el('button', {
      type: 'button', class: 'staff-btn reject', text: 'Confirm reject',
      onclick: () => this.runOrderAction(id, { kind: 'decision', value: 'REJECT' }, input.value.trim(), actionsRow, note),
    });
    const cancel = el('button', { type: 'button', class: 'staff-btn ghost', text: 'Back', onclick: () => this.refreshBoard(false, true) });
    actionsRow.replaceChildren(input, confirm, cancel);
    input.focus();
  }

  async runOrderAction(id, action, reason, actionsRow, note) {
    actionsRow.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    const path = action.kind === 'decision'
      ? `/api/staff/orders/${encodeURIComponent(id)}/decision`
      : `/api/staff/orders/${encodeURIComponent(id)}/status`;
    const body = action.kind === 'decision'
      ? { decision: action.value, ...(reason ? { reason: reason.slice(0, 200) } : {}) }
      : { status: action.value };
    const r = await this.api('POST', path, body);
    if (!r.ok) {
      note.hidden = false;
      note.className = 'staff-card-note error';
      note.textContent = friendlyError(r.status, r.body);
      actionsRow.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      return;
    }
    if (action.kind === 'decision') {
      // decideOrder is direct now: the response already carries the final status.
      const out = decisionOutcome(id, action.value, r.body.data);
      setBanner(this.boardBanner, out.kind, out.text);
    } else {
      setBanner(this.boardBanner, 'success', `Order #${id}: marked ${action.value.replace(/_/g, ' ').toLowerCase()}.`);
    }
    this.refreshBoard(false, true);
  }

  // ------------------------------------------------------------------ employees (manager)
  buildEmployeesPane() {
    this.empBanner = el('div', { class: 'staff-banner', hidden: true });
    this.empList = el('div', { class: 'staff-emp-list' });
    this.empDetail = el('div', { class: 'staff-emp-detail' }, [el('div', { class: 'staff-empty', text: 'Select an employee to see details.' })]);
    return el('div', { class: 'staff-pane', id: 'staffEmployeesPane', hidden: true }, [
      this.paneHeader('Employees', 'Store manager only · listEmployees / getEmployee via Apigee · personal data masked', [
        el('button', { type: 'button', class: 'staff-btn ghost', text: 'Reload', onclick: () => this.loadEmployees() }),
      ]),
      this.empBanner,
      el('div', { class: 'staff-emp-layout' }, [this.empList, this.empDetail]),
    ]);
  }

  async loadEmployees() {
    setBanner(this.empBanner, 'info', 'Loading employees…');
    const r = await this.api('GET', '/api/staff/employees');
    if (!r.ok) {
      setBanner(this.empBanner, r.status === 501 ? 'info' : 'error', friendlyError(r.status, r.body));
      this.empList.replaceChildren();
      return;
    }
    this.loaded.employees = true;
    setBanner(this.empBanner, '', '');
    const list = extractList(r.body.data, ['employees', 'items', 'staff']);
    this.empList.replaceChildren(...(list.length ? list.map((e) => {
      const id = String(e.employee_id ?? e.id ?? e.staff_id ?? '');
      return el('button', {
        type: 'button', class: 'staff-emp-row',
        onclick: () => this.loadEmployee(id, e),
      }, [
        el('strong', { text: e.name || e.full_name || id || 'Employee' }),
        el('span', { text: [e.role || e.position || e.title, e.shift].filter(Boolean).join(' · ') }),
        el('small', { text: e.email ? maskPII('email', e.email) : id }),
      ]);
    }) : [el('div', { class: 'staff-empty', text: 'No employees returned.' })]));
  }

  async loadEmployee(id, fallback) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      this.renderKeyValues(this.empDetail, 'Employee', fallback);
      return;
    }
    this.empDetail.replaceChildren(el('div', { class: 'staff-empty', text: 'Loading…' }));
    const r = await this.api('GET', `/api/staff/employees/${encodeURIComponent(id)}`);
    if (!r.ok) {
      this.empDetail.replaceChildren(el('div', { class: 'staff-banner error', text: friendlyError(r.status, r.body) }));
      if (r.status === 501 && fallback) this.renderKeyValues(this.empDetail, 'From the employee list', fallback, true);
      return;
    }
    this.renderKeyValues(this.empDetail, `Employee ${id}`, r.body.data);
  }

  renderKeyValues(container, title, obj, append = false) {
    const rows = [];
    const data = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj.employee || obj) : {};
    for (const [k, v] of Object.entries(data)) {
      if (v === null || v === undefined || typeof v === 'object') continue;
      rows.push(el('div', { class: 'staff-kv' }, [el('span', { text: k.replace(/_/g, ' ') }), el('span', { text: maskPII(k, v) })]));
    }
    const block = el('div', { class: 'staff-kv-block' }, [el('h3', { text: title }), ...(rows.length ? rows : [el('div', { class: 'staff-empty', text: 'No details.' })])]);
    if (append) container.appendChild(block); else container.replaceChildren(block);
  }

  // ------------------------------------------------------------------ store ops (manager)
  buildStorePane() {
    this.storeBanner = el('div', { class: 'staff-banner', hidden: true });

    // Hours
    this.hoursCurrent = el('div', { class: 'staff-hours-current' });
    this.hoursDay = el('select', { class: 'staff-input', 'aria-label': 'Day' }, DAYS.map((d) => el('option', { value: d, text: d })));
    this.hoursOpen = el('input', { type: 'time', class: 'staff-input', value: '07:00', 'aria-label': 'Opens' });
    this.hoursClose = el('input', { type: 'time', class: 'staff-input', value: '18:00', 'aria-label': 'Closes' });
    this.hoursClosed = el('input', { type: 'checkbox', 'aria-label': 'Closed all day' });
    this.hoursClosed.addEventListener('change', () => {
      this.hoursOpen.disabled = this.hoursClosed.checked;
      this.hoursClose.disabled = this.hoursClosed.checked;
    });
    const hoursCard = el('section', { class: 'staff-card-panel' }, [
      el('h3', { text: 'Opening hours' }),
      this.hoursCurrent,
      el('div', { class: 'staff-form-row' }, [
        this.hoursDay, this.hoursOpen, el('span', { text: '–' }), this.hoursClose,
        el('label', { class: 'staff-check' }, [this.hoursClosed, ' Closed']),
        el('button', { type: 'button', class: 'staff-btn approve', text: 'Save hours', onclick: () => this.saveHours() }),
      ]),
    ]);

    // Menu
    this.menuTable = el('div', { class: 'staff-menu-table' });
    const menuCard = el('section', { class: 'staff-card-panel' }, [
      el('h3', { text: 'Menu prices & availability' }),
      this.menuTable,
    ]);

    // Stats
    this.statsDays = el('select', { class: 'staff-input', 'aria-label': 'Period' },
      [['1', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days']].map(([v, t]) => el('option', { value: v, text: t, selected: v === '7' })));
    this.statsDays.addEventListener('change', () => this.loadStats());
    this.statsBody = el('div', { class: 'staff-stats' });
    const statsCard = el('section', { class: 'staff-card-panel' }, [
      el('div', { class: 'staff-card-panel-head' }, [el('h3', { text: 'Sales stats' }), this.statsDays]),
      this.statsBody,
    ]);

    return el('div', { class: 'staff-pane', id: 'staffStorePane', hidden: true }, [
      this.paneHeader('Store operations', 'Store manager only · updateStoreHours / updateMenuItem / getSalesStats via Apigee', [
        el('button', { type: 'button', class: 'staff-btn ghost', text: 'Reload', onclick: () => this.loadStore() }),
      ]),
      this.storeBanner,
      el('div', { class: 'staff-store-grid' }, [statsCard, hoursCard, menuCard]),
    ]);
  }

  async loadStore() {
    this.loaded.store = true;
    setBanner(this.storeBanner, '', '');
    await Promise.all([this.loadHours(), this.loadMenu(), this.loadStats()]);
  }

  storeError(r) {
    setBanner(this.storeBanner, r.status === 501 ? 'info' : 'error', friendlyError(r.status, r.body));
  }

  async loadHours() {
    const r = await this.api('GET', '/api/staff/store/hours');
    if (!r.ok) { this.hoursCurrent.replaceChildren(el('div', { class: 'staff-empty', text: friendlyError(r.status, r.body) })); return; }
    const data = r.body.data;
    const raw = data && typeof data === 'object' && !Array.isArray(data) && data.hours ? data.hours : data;
    // Shapes: [{day, open, close, closed?, hours?}] (current API) or {Monday: {...} | "7-19"}.
    const entries = Array.isArray(raw)
      ? raw.filter((v) => v && typeof v === 'object').map((v) => [String(v.day || ''), v])
      : Object.entries(raw && typeof raw === 'object' ? raw : {});
    const rows = [];
    for (const [day, v] of entries) {
      if (v === null || v === undefined || !day) continue;
      let text;
      if (typeof v === 'object') text = v.closed ? 'Closed' : ([v.open, v.close].filter(Boolean).join(' – ') || String(v.hours || ''));
      else text = String(v);
      rows.push(el('div', { class: 'staff-kv' }, [el('span', { text: day }), el('span', { text })]));
    }
    this.hoursCurrent.replaceChildren(...(rows.length ? rows : [el('div', { class: 'staff-empty', text: 'No hours returned.' })]));
  }

  async saveHours() {
    const v = validateHours(this.hoursDay.value, this.hoursOpen.value, this.hoursClose.value, this.hoursClosed.checked);
    if (!v.ok) { setBanner(this.storeBanner, 'error', v.message); return; }
    const r = await this.api('PUT', '/api/staff/store/hours', v.value);
    if (!r.ok) { this.storeError(r); return; }
    setBanner(this.storeBanner, 'success', `Hours for ${v.value.day} updated.`);
    this.loadHours();
  }

  async loadMenu() {
    const r = await this.api('GET', '/api/staff/menu');
    if (!r.ok) { this.menuTable.replaceChildren(el('div', { class: 'staff-empty', text: friendlyError(r.status, r.body) })); return; }
    const items = extractList(r.body.data, ['menu', 'items']);
    this.menuTable.replaceChildren(...(items.length ? items.map((it) => this.menuRow(it)) : [el('div', { class: 'staff-empty', text: 'No menu items.' })]));
  }

  menuRow(item) {
    const id = String(item.id ?? item.item_id ?? '');
    const validId = /^[A-Za-z0-9_-]{1,64}$/.test(id);
    const available = item.available !== false;
    const price = el('input', { type: 'number', class: 'staff-input price', step: '0.05', min: '0.5', max: '100', value: Number(item.price) || '', 'aria-label': `Price for ${item.name || id}` });
    const save = el('button', { type: 'button', class: 'staff-btn progress', text: 'Save', disabled: !validId, onclick: () => this.patchMenu(id, { price: price.value }, row) });
    const toggle = el('button', {
      type: 'button', class: `staff-btn ${available ? 'reject' : 'approve'}`, disabled: !validId,
      text: available ? 'Mark sold out' : 'Back in stock',
      onclick: () => this.patchMenu(id, { available: !available }, row),
    });
    const row = el('div', { class: `staff-menu-row${available ? '' : ' sold-out'}` }, [
      el('div', { class: 'staff-menu-name' }, [
        el('strong', { text: item.name || id }),
        el('small', { text: [item.size, available ? '' : 'SOLD OUT'].filter(Boolean).join(' · ') }),
      ]),
      el('span', { class: 'staff-menu-dollar', text: '$' }), price, save, toggle,
    ]);
    return row;
  }

  async patchMenu(id, change, row) {
    const body = {};
    if ('price' in change) {
      const v = validatePrice(change.price);
      if (!v.ok) { setBanner(this.storeBanner, 'error', v.message); return; }
      body.price = v.value;
    }
    if ('available' in change) body.available = !!change.available;
    row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    const r = await this.api('PATCH', `/api/staff/menu/${encodeURIComponent(id)}`, body);
    if (!r.ok) {
      this.storeError(r);
      row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      return;
    }
    setBanner(this.storeBanner, 'success', `Menu item ${id} updated.`);
    this.loadMenu();
  }

  async loadStats() {
    const days = ['1', '7', '30'].includes(this.statsDays.value) ? this.statsDays.value : '7';
    const r = await this.api('GET', `/api/staff/stats?days=${days}`);
    if (!r.ok) { this.statsBody.replaceChildren(el('div', { class: 'staff-empty', text: friendlyError(r.status, r.body) })); return; }
    const s = r.body.data && typeof r.body.data === 'object' ? r.body.data : {};
    const kpi = (label, value) => el('div', { class: 'staff-kpi' }, [el('span', { text: label }), el('strong', { text: value })]);
    const nodes = [el('div', { class: 'staff-kpis' }, [
      kpi('Orders', String(s.order_count ?? s.orders ?? s.total_orders ?? '—')),
      kpi('Revenue', formatMoney(s.revenue ?? s.total_revenue) || '—'),
      kpi('Pending approval', String(s.pending_approval_count ?? s.pending_count ?? s.pending ?? (s.by_status && s.by_status.PENDING_APPROVAL) ?? '—')),
    ])];
    if (s.by_status && typeof s.by_status === 'object') {
      nodes.push(el('h4', { text: 'By status' }), ...Object.entries(s.by_status).map(([k, v]) =>
        el('div', { class: 'staff-kv' }, [el('span', { text: k.replace(/_/g, ' ') }), el('span', { text: String(v) })])));
    }
    const top = extractList(s.top_items, []);
    if (top.length) {
      nodes.push(el('h4', { text: 'Top items' }), ...top.slice(0, 5).map((t) =>
        el('div', { class: 'staff-kv' }, [el('span', { text: t.name || t.item_id || 'item' }),
          el('span', { text: `${t.quantity ?? t.count ?? ''}${t.revenue !== undefined ? ` · ${formatMoney(t.revenue)}` : ''}` })])));
    }
    this.statsBody.replaceChildren(...nodes);
  }
}
