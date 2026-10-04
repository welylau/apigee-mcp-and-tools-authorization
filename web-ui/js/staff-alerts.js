/**
 * Staff app alerts for orders waiting for approval.
 *
 * Approvals happen only in the Staff app, so the app has to get attention by
 * itself:
 *  - a counter on the "Orders board" tab and next to the role badge in the header
 *  - the count in document.title, e.g. "(2) Biscuit Coffee ..."
 *  - a toast when a new pending order appears (not on the first load)
 *  - optionally a browser notification + a short WebAudio beep
 *
 * Browser notifications are only requested from an explicit click on
 * "Enable alerts" (never auto-prompted). "Mute" silences the notification and
 * the sound (toast and counters stay); both settings live in localStorage.
 *
 * All text is set with textContent: order data is untrusted.
 */

import { formatMoney, itemsSummary, orderId, titleWithCount } from './staff-utils.js';

const LS_MUTED = 'biscuit.staffAlerts.muted';
const LS_NOTIFY = 'biscuit.staffAlerts.notify';
const TOAST_MS = 8000;
const MAX_TOASTS = 4;

function lsGet(key) {
  try { return window.localStorage.getItem(key); } catch (e) { return null; }
}

function lsSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch (e) { /* private mode: keep in memory only */ }
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

export class StaffAlerts {
  /** @param {{onOpenOrders?: Function}} opts */
  constructor(opts = {}) {
    this.onOpenOrders = opts.onOpenOrders || (() => {});
    this.muted = lsGet(LS_MUTED) === '1';
    this.notifyWanted = lsGet(LS_NOTIFY) === '1';
    this.count = 0;
    this.baseTitle = titleWithCount(document.title, 0);
    this.audio = null;

    // Counter on the Orders tab.
    const tab = document.querySelector('#staffTabBar [data-staff-tab="orders"]');
    this.tabCount = make('span', 'staff-pending-count', '0');
    this.tabCount.hidden = true;
    this.tabCount.setAttribute('aria-label', 'orders waiting for approval');
    if (tab) tab.appendChild(this.tabCount);

    // Header badge, next to the role badge.
    const roleBadge = document.getElementById('staffRoleBadge');
    this.headerBadge = make('button', 'staff-pending-badge', '');
    this.headerBadge.type = 'button';
    this.headerBadge.id = 'staffPendingBadge';
    this.headerBadge.hidden = true;
    this.headerBadge.title = 'Orders waiting for approval: open the orders board';
    this.headerBadge.addEventListener('click', () => this.onOpenOrders());
    if (roleBadge && roleBadge.parentNode) roleBadge.parentNode.insertBefore(this.headerBadge, roleBadge.nextSibling);

    // Toast stack.
    this.toastStack = make('div', 'staff-toast-stack');
    this.toastStack.setAttribute('role', 'status');
    this.toastStack.setAttribute('aria-live', 'polite');
    document.body.appendChild(this.toastStack);

    // Browsers only allow audio after a user gesture: unlock it on the first click.
    const unlock = () => { this.ensureAudio(); document.removeEventListener('click', unlock, true); };
    document.addEventListener('click', unlock, true);
  }

  // ------------------------------------------------------------------ controls
  /** "Enable alerts" + "Mute" buttons for the orders pane header. */
  buildControls() {
    this.enableBtn = make('button', 'staff-btn ghost staff-alert-toggle');
    this.enableBtn.type = 'button';
    this.enableBtn.addEventListener('click', () => this.toggleNotifications());
    this.muteBtn = make('button', 'staff-btn ghost staff-alert-toggle');
    this.muteBtn.type = 'button';
    this.muteBtn.addEventListener('click', () => this.toggleMute());
    this.renderControls();
    return [this.enableBtn, this.muteBtn];
  }

  notificationsSupported() {
    return typeof window.Notification === 'function';
  }

  notificationsOn() {
    return this.notificationsSupported() && this.notifyWanted && window.Notification.permission === 'granted';
  }

  renderControls() {
    if (!this.enableBtn) return;
    const supported = this.notificationsSupported();
    const perm = supported ? window.Notification.permission : 'unsupported';
    if (!supported) {
      this.enableBtn.textContent = '🔕 Browser alerts unavailable';
      this.enableBtn.disabled = true;
    } else if (perm === 'denied') {
      this.enableBtn.textContent = '🔕 Alerts blocked by browser';
      this.enableBtn.disabled = true;
      this.enableBtn.title = 'Allow notifications for this site in the browser settings to enable alerts.';
    } else {
      this.enableBtn.disabled = false;
      this.enableBtn.textContent = this.notificationsOn() ? '🔔 Alerts on' : '🔔 Enable alerts';
      this.enableBtn.title = this.notificationsOn()
        ? 'Browser notification + sound for new pending orders. Click to turn off.'
        : 'Show a browser notification and play a sound when a new order needs approval.';
    }
    this.enableBtn.setAttribute('aria-pressed', this.notificationsOn() ? 'true' : 'false');
    this.muteBtn.textContent = this.muted ? '🔇 Muted' : '🔊 Sound on';
    this.muteBtn.title = this.muted
      ? 'Notifications and sound are muted (the counter and toasts still show). Click to unmute.'
      : 'Click to mute notifications and sound.';
    this.muteBtn.setAttribute('aria-pressed', this.muted ? 'true' : 'false');
  }

  async toggleNotifications() {
    this.ensureAudio();
    if (!this.notificationsSupported()) return;
    if (this.notificationsOn()) {
      this.notifyWanted = false;
      lsSet(LS_NOTIFY, '0');
      this.renderControls();
      return;
    }
    let perm = window.Notification.permission;
    if (perm === 'default') {
      try { perm = await window.Notification.requestPermission(); } catch (e) { perm = 'denied'; }
    }
    this.notifyWanted = perm === 'granted';
    lsSet(LS_NOTIFY, this.notifyWanted ? '1' : '0');
    this.renderControls();
    if (this.notifyWanted && !this.muted) this.beep();
  }

  toggleMute() {
    this.muted = !this.muted;
    lsSet(LS_MUTED, this.muted ? '1' : '0');
    this.renderControls();
    if (!this.muted) { this.ensureAudio(); this.beep(); }
  }

  // ------------------------------------------------------------------ updates
  /** Called after every successful board refresh. */
  setCount(count) {
    this.count = Math.max(0, Number(count) || 0);
    const text = String(this.count);
    this.tabCount.textContent = text;
    this.tabCount.hidden = this.count === 0;
    this.headerBadge.textContent = `⏳ ${text} pending`;
    this.headerBadge.hidden = this.count === 0;
    document.title = titleWithCount(this.baseTitle, this.count);
  }

  /** Clears counters (signed out). */
  reset() {
    this.setCount(0);
    this.toastStack.replaceChildren();
  }

  /** New pending orders since the last refresh. */
  announce(orders) {
    if (!orders || !orders.length) return;
    for (const o of orders.slice(0, MAX_TOASTS)) this.toast(o);
    if (orders.length > MAX_TOASTS) {
      this.toastText(`+${orders.length - MAX_TOASTS} more orders waiting for approval`);
    }
    if (this.muted) return;
    this.beep();
    if (this.notificationsOn()) this.notify(orders);
  }

  describe(order) {
    const id = orderId(order);
    const parts = [formatMoney(order.total_amount), order.name || order.customer_name || '', itemsSummary(order)]
      .filter(Boolean);
    return { id, line: parts.join(' · ').slice(0, 140) };
  }

  toast(order) {
    const { id, line } = this.describe(order);
    const node = make('div', 'staff-toast');
    const title = make('strong', '', `New order waiting for approval${id ? `: #${id}` : ''}`);
    const body = make('span', '', line);
    const open = make('button', 'staff-btn approve', 'Review');
    open.type = 'button';
    open.addEventListener('click', () => { node.remove(); this.onOpenOrders(id); });
    const close = make('button', 'staff-toast-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', () => node.remove());
    node.append(close, title, body, open);
    this.pushToast(node);
  }

  toastText(text) {
    const node = make('div', 'staff-toast');
    node.appendChild(make('strong', '', text));
    this.pushToast(node);
  }

  pushToast(node) {
    this.toastStack.appendChild(node);
    while (this.toastStack.children.length > MAX_TOASTS + 1) this.toastStack.firstChild.remove();
    setTimeout(() => node.remove(), TOAST_MS);
  }

  notify(orders) {
    try {
      const first = this.describe(orders[0]);
      const title = orders.length === 1
        ? `Order #${first.id} needs approval`
        : `${orders.length} orders need approval`;
      const n = new window.Notification(title, {
        body: orders.length === 1 ? first.line : 'Open the Biscuit Coffee Staff app to approve or reject them.',
        tag: 'biscuit-pending-orders',
        renotify: true,
      });
      n.onclick = () => { window.focus(); this.onOpenOrders(first.id); n.close(); };
    } catch (e) {
      /* Notification constructor can throw (e.g. some mobile browsers): toast already shown. */
    }
  }

  // ------------------------------------------------------------------ sound
  ensureAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      if (!this.audio) this.audio = new Ctx();
      if (this.audio.state === 'suspended') this.audio.resume().catch(() => {});
    } catch (e) {
      this.audio = null;
    }
    return this.audio;
  }

  /** Two short tones (~0.35 s), generated with WebAudio: no external asset. */
  beep() {
    const ctx = this.audio || this.ensureAudio();
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    [[880, 0], [1320, 0.18]].forEach(([freq, at]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.2, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.17);
    });
  }
}
