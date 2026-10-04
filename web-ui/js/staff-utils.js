/**
 * Staff console helpers: role detection, input validation and data shaping.
 *
 * DOM-free on purpose so it can be unit-tested with node
 * (see scratch/ui_harness.mjs). The BFF re-validates everything server-side and
 * Apigee enforces scopes; these checks only give the user early feedback.
 */

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const PRICE_MIN = 0.5;
export const PRICE_MAX = 100;

/** Staff / manager flags from Keycloak access-token claims (mirrors server.py role_flags). */
export function roleFlags(claims) {
  const roles = new Set((claims && claims.realm_access && claims.realm_access.roles) || []);
  const scopes = new Set(String((claims && claims.scope) || '').split(/\s+/).filter(Boolean));
  const manager = roles.has('manager') || scopes.has('biscuit_coffee_manager') || roles.has('biscuit_coffee_manager');
  const staff = manager || roles.has('staff') || scopes.has('biscuit_coffee_staff');
  return { staff, manager };
}

/** True when a user with these claims may use the given UI variant. */
export function variantAllows(variant, claims) {
  const { staff } = roleFlags(claims || {});
  return variant === 'staff' ? staff : !staff;
}

/** Friendly refusal text when the role gate blocks a user. */
export function gateMessage(variant) {
  return variant === 'staff'
    ? 'This is the Biscuit Coffee Staff app. Your account does not have the staff or store manager role. Customers, please use the customer app.'
    : "Staff and store manager accounts can't sign in to the customer app. Please use the Biscuit Coffee Staff app.";
}

/** Canonical order status (backend seeds use COMPLETE, the staff API uses COMPLETED). */
export function normalizeStatus(status) {
  const s = String(status || '').trim().toUpperCase().replace(/\s+/g, '_');
  if (s === 'COMPLETE' || s === 'DONE') return 'COMPLETED';
  if (s === 'PENDING') return 'PENDING_APPROVAL';
  if (s === 'CANCELED') return 'CANCELLED';
  return s || 'UNKNOWN';
}

export const BOARD_COLUMNS = [
  { key: 'PENDING_APPROVAL', title: 'Pending approval', statuses: ['PENDING_APPROVAL'] },
  { key: 'IN_PROGRESS', title: 'In progress', statuses: ['IN_PROGRESS'] },
  { key: 'READY', title: 'Ready for pickup', statuses: ['READY'] },
  { key: 'DONE', title: 'Completed / closed', statuses: ['COMPLETED', 'REJECTED', 'CANCELLED'] },
];

/** Pulls the order array out of whatever shape the tool returned. */
export function extractOrders(data) {
  if (Array.isArray(data)) return data.filter((o) => o && typeof o === 'object');
  if (data && typeof data === 'object') {
    for (const k of ['orders', 'items', 'results', 'data']) {
      if (Array.isArray(data[k])) return data[k].filter((o) => o && typeof o === 'object');
    }
  }
  return [];
}

export function orderId(order) {
  const id = String((order && (order.order_id ?? order.id ?? order.orderId)) ?? '');
  return ID_RE.test(id) ? id : '';
}

/** column key -> orders (newest first is preserved from the API). Unknown statuses go to DONE. */
export function bucketOrders(orders) {
  const out = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.key, []]));
  for (const o of orders) {
    const status = normalizeStatus(o.status);
    const col = BOARD_COLUMNS.find((c) => c.statuses.includes(status));
    out[col ? col.key : 'DONE'].push(o);
  }
  return out;
}

/**
 * Buttons offered for an order in a given status.
 * kind 'decision' -> POST .../decision, kind 'status' -> POST .../status.
 */
export function nextActions(status) {
  switch (normalizeStatus(status)) {
    case 'PENDING_APPROVAL':
      return [
        { kind: 'decision', value: 'APPROVE', label: 'Approve', style: 'approve' },
        { kind: 'decision', value: 'REJECT', label: 'Reject', style: 'reject' },
      ];
    case 'IN_PROGRESS':
      return [
        { kind: 'status', value: 'READY', label: 'Mark ready', style: 'progress' },
        { kind: 'status', value: 'CANCELLED', label: 'Cancel', style: 'reject' },
      ];
    case 'READY':
      return [{ kind: 'status', value: 'COMPLETED', label: 'Complete (picked up)', style: 'approve' }];
    default:
      return [];
  }
}

export function itemsSummary(order) {
  const items = Array.isArray(order && order.items) ? order.items : [];
  if (!items.length) return order && typeof order.items_summary === 'string' ? order.items_summary : '';
  return items.map((it) => {
    const qty = Number(it.quantity) || 1;
    const name = it.name || it.item_name || it.item_id || 'item';
    return `${qty} × ${name}${it.size ? ` (${it.size})` : ''}`;
  }).join(', ');
}

export function formatMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '';
}

export function validatePrice(raw) {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (String(raw ?? '').trim() === '' || !Number.isFinite(n)) return { ok: false, message: 'Price must be a number.' };
  if (n < PRICE_MIN || n > PRICE_MAX) {
    return { ok: false, message: `Price must be between $${PRICE_MIN.toFixed(2)} and $${PRICE_MAX.toFixed(2)}.` };
  }
  return { ok: true, value: Math.round(n * 100) / 100 };
}

export function validateHours(day, open, close, closed) {
  if (!DAYS.includes(day)) return { ok: false, message: 'Pick a day of the week.' };
  if (closed) return { ok: true, value: { day, closed: true } };
  if (!HHMM_RE.test(open || '') || !HHMM_RE.test(close || '')) {
    return { ok: false, message: 'Opening and closing times must be HH:MM (24 h).' };
  }
  if (open >= close) return { ok: false, message: 'Closing time must be later than opening time.' };
  return { ok: true, value: { day, open, close } };
}

/** Masks personal data for on-screen labels (e.g. j***@biscuit-coffee.com, ***-1234). */
export function maskPII(key, value) {
  const k = String(key || '').toLowerCase();
  const v = String(value ?? '');
  if (k.includes('email') || /^[^@\s]+@[^@\s]+$/.test(v)) {
    const [user, domain] = v.split('@');
    return domain ? `${user.slice(0, 1)}***@${domain}` : v;
  }
  if (k.includes('phone') || k.includes('mobile')) return v.length > 4 ? `***-${v.slice(-4)}` : '***';
  if (k.includes('address') || k.includes('ssn') || k.includes('salary') || k.includes('birth')) return '•••';
  return v;
}

export function extractList(data, keys) {
  if (Array.isArray(data)) return data.filter((x) => x && typeof x === 'object');
  if (data && typeof data === 'object') {
    for (const k of keys) if (Array.isArray(data[k])) return data[k].filter((x) => x && typeof x === 'object');
  }
  return [];
}

// ---------------------------------------------------------------- theme
/** localStorage key for the theme choice, one per UI variant. */
export function themeStorageKey(variant) {
  return `biscuit.theme.${variant === 'staff' ? 'staff' : 'customer'}`;
}

/** Theme to start with: the stored explicit choice, else dark for staff and light for customers. */
export function initialTheme(variant, stored) {
  if (stored === 'dark' || stored === 'light') return stored;
  return variant === 'staff' ? 'dark' : 'light';
}

// ---------------------------------------------------------------- date filter + sort
export const DATE_RANGES = [
  { key: 'today', label: 'Today', days: 1 },
  { key: '3d', label: 'Last 3 days', days: 3 },
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: 'all', label: 'All orders', days: null },
];
export const DEFAULT_RANGE = 'today';
export const ORDER_FETCH_LIMIT = 200;

export function validRange(key) {
  return DATE_RANGES.some((r) => r.key === key) ? key : DEFAULT_RANGE;
}

/**
 * Start of a range as epoch ms, in the browser's local timezone.
 * "Today" = since local midnight; "Last N days" = today plus the N-1 previous
 * calendar days (from local midnight). null for "All orders".
 */
export function rangeStart(key, now = new Date()) {
  const r = DATE_RANGES.find((x) => x.key === validRange(key));
  if (!r.days) return null;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - (r.days - 1));
  return d.getTime();
}

/** created_at as epoch ms, NaN when missing or unparsable. */
export function orderTime(order) {
  const raw = order && order.created_at;
  if (!raw) return NaN;
  return Date.parse(String(raw));
}

/** Newest first by created_at; orders without a usable created_at go last (stable). */
export function sortNewestFirst(orders) {
  return (orders || []).map((o, i) => ({ o, i, t: orderTime(o) }))
    .sort((a, b) => {
      const an = Number.isNaN(a.t);
      const bn = Number.isNaN(b.t);
      if (an !== bn) return an ? 1 : -1;
      if (!an && b.t !== a.t) return b.t - a.t;
      return a.i - b.i;
    })
    .map((x) => x.o);
}

/** False for orders without a usable created_at (e.g. seeded rows). */
export function hasKnownDate(order) {
  return !Number.isNaN(orderTime(order));
}

/**
 * Orders inside the range. Orders without a usable created_at are kept in
 * every range (the board tags them "date unknown") so they can't silently
 * drop off the default "Today" view.
 */
export function filterByRange(orders, key, now = new Date()) {
  const start = rangeStart(key, now);
  if (start === null) return (orders || []).slice();
  return (orders || []).filter((o) => {
    const t = orderTime(o);
    return Number.isNaN(t) || t >= start;
  });
}

// ---------------------------------------------------------------- bulk status actions
export const BULK_MAX = 50;
export const BULK_CONFIRM_OVER = 5;
/** Target status -> statuses it may be applied to. Pending approval is never bulk-changed. */
export const BULK_ACTIONS = {
  READY: { label: 'Mark ready', from: ['IN_PROGRESS'] },
  COMPLETED: { label: 'Complete', from: ['READY', 'IN_PROGRESS'] },
};
/** Orders that can carry a selection checkbox. */
export const SELECTABLE_STATUSES = ['IN_PROGRESS', 'READY'];

export function isSelectable(order) {
  return !!orderId(order) && SELECTABLE_STATUSES.includes(normalizeStatus(order && order.status));
}

/**
 * Splits a selection into orders to update and skipped ones (with a reason).
 * Order of `selectedIds` is kept; at most BULK_MAX updates per run.
 */
export function bulkPlan(selectedIds, orders, target) {
  const action = BULK_ACTIONS[target];
  const byId = new Map((orders || []).map((o) => [orderId(o), o]).filter(([id]) => id));
  const apply = [];
  const skipped = [];
  for (const raw of selectedIds || []) {
    const id = String(raw);
    if (!ID_RE.test(id)) { skipped.push({ id, reason: 'invalid order id' }); continue; }
    const o = byId.get(id);
    if (!action) { skipped.push({ id, reason: 'unknown action' }); continue; }
    if (!o) { skipped.push({ id, reason: 'no longer on the board' }); continue; }
    const status = normalizeStatus(o.status);
    if (status === 'PENDING_APPROVAL') { skipped.push({ id, reason: 'waiting for approval (approve or reject it on its card)' }); continue; }
    if (status === target) { skipped.push({ id, reason: `already ${status.replace(/_/g, ' ')}` }); continue; }
    if (!action.from.includes(status)) { skipped.push({ id, reason: `is ${status.replace(/_/g, ' ')}` }); continue; }
    if (apply.length >= BULK_MAX) { skipped.push({ id, reason: `over the ${BULK_MAX}-order limit per run` }); continue; }
    apply.push(id);
  }
  return { apply, skipped };
}

/** Keeps only selected ids that are still on the (visible) board and still selectable. */
export function pruneSelection(selected, visibleOrders) {
  const keep = new Set((visibleOrders || []).filter(isSelectable).map(orderId));
  return new Set([...(selected || [])].filter((id) => keep.has(id)));
}

/** One-line summary of a bulk run. */
export function bulkSummary(label, result) {
  const list = (items) => {
    const shown = items.slice(0, 5).map((x) => `#${x.id} ${x.reason}`).join('; ');
    return items.length > 5 ? `${shown}; +${items.length - 5} more` : shown;
  };
  const parts = [`${label}: ${result.done.length} updated`];
  if (result.skipped.length) parts.push(`${result.skipped.length} skipped (${list(result.skipped)})`);
  if (result.failed.length) parts.push(`${result.failed.length} failed (${list(result.failed)})`);
  return parts.join(' · ');
}

/** Ids of the orders that are waiting for approval. */
export function pendingIds(orders) {
  const ids = new Set();
  for (const o of orders || []) {
    if (normalizeStatus(o && o.status) !== 'PENDING_APPROVAL') continue;
    const id = orderId(o);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * The latest orders plus every pending order (fetched separately, so a busy
 * day can't push pending orders out of the latest-N window). De-duplicated by
 * id; the pending fetch ran last, so its copy wins.
 */
export function mergeOrders(recent, pending) {
  const byId = new Map();
  const noId = [];
  for (const o of [...(recent || []), ...(pending || [])]) {
    const id = orderId(o);
    if (id) byId.set(id, o); else noId.push(o);
  }
  return [...byId.values(), ...noId];
}

/**
 * Pending orders that were not pending at the previous refresh.
 * `prev` is null on the first load (nothing counts as new then).
 */
export function newPendingOrders(prev, orders) {
  if (!prev) return [];
  return (orders || []).filter((o) => {
    if (normalizeStatus(o && o.status) !== 'PENDING_APPROVAL') return false;
    const id = orderId(o);
    return !!id && !prev.has(id);
  });
}

/** "Biscuit Coffee Staff" -> "(3) Biscuit Coffee Staff"; strips an older count first. */
export function titleWithCount(title, count) {
  const base = String(title || '').replace(/^\(\d+\)\s+/, '');
  return count > 0 ? `(${count}) ${base}` : base;
}

/**
 * Banner text after Approve/Reject. decideOrder now returns the final status
 * straight away; if a (legacy) backend still answers PENDING_APPROVAL we say so
 * and let the 10 s board refresh pick up the change.
 */
export function decisionOutcome(id, decision, data) {
  const d = data && typeof data === 'object' ? data : {};
  const order = d.order && typeof d.order === 'object' ? d.order : d;
  const raw = order.status || d.new_status || d.final_status || '';
  const status = raw ? normalizeStatus(raw) : '';
  const verb = decision === 'APPROVE' ? 'approved' : 'rejected';
  if (status === 'PENDING_APPROVAL') {
    return { kind: 'warning', status, text: `Order #${id}: decision recorded, but the order still shows PENDING APPROVAL. The board will refresh.` };
  }
  return {
    kind: 'success',
    status,
    text: `Order #${id}: ${verb}${status ? ` (now ${status.replace(/_/g, ' ')})` : ''}.`,
  };
}

/** User-facing text for a failed staff API call. */
export function friendlyError(status, body) {
  const msg = body && typeof body.message === 'string' ? body.message : '';
  if (status === 501 || (body && body.error === 'tool_unavailable')) {
    return msg || 'This tool is not deployed on the Apigee MCP gateway yet.';
  }
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) {
    if (body && body.error === 'role_not_allowed') return msg;
    return `Apigee refused this request (403): ${msg || 'your role is not allowed to do this.'}`;
  }
  if (status === 404) return msg || 'Not found.';
  if (status === 409) return `Conflict (409): ${msg || 'the order is not in a state that allows this.'}`;
  if (status === 429) return 'Too many requests. Please wait a moment.';
  if (status === 400) return msg || 'The request was rejected as invalid.';
  return msg || `Request failed (HTTP ${status}).`;
}
