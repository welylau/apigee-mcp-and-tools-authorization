/**
 * Main Web UI Application Logic
 * Biscuit Coffee Shop - Apigee + ADK Agent Showcase
 */

import { AdkAgentClient } from './agent-client.js';
import { SettingsPanel } from './settings-panel.js';
import { GuidedTour } from './tour/tour-engine.js';
import { StaffConsole } from './staff-console.js';
import { roleFlags, variantAllows, gateMessage, initialTheme, themeStorageKey } from './staff-utils.js';
import { beginAuthRequest, completeAuthRequest } from './oauth-pkce.js';

/** Element with plain-text content (never parsed as HTML). */
function textEl(tag, text = '', className = '') {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== '' && text !== null && text !== undefined) el.textContent = String(text);
  return el;
}

// Static icon markup (constants in this file, never data).
const LOCK_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>';
const USERS_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>';
const WRENCH_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';

// User Personas & Scopes (customer app). Store managers and staff are refused
// by the customer app's role gate and use the Staff app instead.
export const PERSONAS = {
  customer: {
    id: 'customer',
    name: 'John Smith',
    roleName: 'Customer (John Smith)',
    email: 'customer@biscuit-coffee.com',
    avatar: '👤',
    scopes: ['biscuit_coffee_customer'],
    scopeDescription: 'biscuit_coffee_customer',
    badgeClass: 'customer',
    summary: 'Standard customer account (John Smith). Can view menu, place orders, and check rewards.'
  },
  customer2: {
    id: 'customer2',
    name: 'Michael Bosh',
    roleName: 'Customer (Michael Bosh)',
    email: 'customer2@biscuit-coffee.com',
    avatar: '👤',
    scopes: ['biscuit_coffee_customer'],
    scopeDescription: 'biscuit_coffee_customer',
    badgeClass: 'customer',
    summary: 'Second customer account (Michael Bosh). Can view menu, place orders, and test cross-user isolation.'
  }
};

// Staff app personas (UI_VARIANT=staff).
export const STAFF_PERSONAS = {
  manager: {
    id: 'manager',
    name: 'Alice (Manager)',
    roleName: 'Store Manager',
    roleBadge: 'STORE MANAGER',
    email: 'manager@biscuit-coffee.com',
    avatar: '👔',
    scopes: ['biscuit_coffee_staff', 'biscuit_coffee_manager'],
    scopeDescription: 'biscuit_coffee_staff, biscuit_coffee_manager',
    badgeClass: 'manager',
    summary: 'Store manager: all orders, approvals, employees, store operations and audit logs.'
  },
  staff: {
    id: 'staff',
    name: 'Sam Barista',
    roleName: 'Staff',
    roleBadge: 'STAFF',
    email: 'staff@biscuit-coffee.com',
    avatar: '🧑‍🍳',
    scopes: ['biscuit_coffee_staff'],
    scopeDescription: 'biscuit_coffee_staff',
    badgeClass: 'staff',
    summary: 'Barista: all orders, approvals and order progress.'
  }
};

export const GUEST_PERSONA = {
  id: 'guest',
  name: 'Not Logged In',
  roleName: 'Guest',
  email: 'No active Keycloak session',
  avatar: '🔒',
  scopes: [],
  scopeDescription: 'None (Unauthenticated)',
  badgeClass: 'unauthenticated',
  summary: 'Unauthenticated visitor. Can explore public menu and hours. Login to place orders or access management tools.'
};

// Staff app before sign-in: no guest mode, the agent is not usable yet.
export const STAFF_SIGNED_OUT_PERSONA = {
  ...GUEST_PERSONA,
  name: 'Not signed in',
  email: 'Staff sign-in required',
  summary: 'Sign in with a staff or store manager account.'
};

// Suggested Prompts by Persona
export const SUGGESTED_PROMPTS = [
  // Public (Unauthenticated Users)
  {
    category: 'menu',
    icon: '☕',
    text: "What's on the menu and how much is a cappuccino?",
    label: "Menu & Pricing",
    role: 'public'
  },
  {
    category: 'info',
    icon: '📍',
    text: "Where is Biscuit Coffee located and what are your hours?",
    label: "Location & Hours",
    role: 'public'
  },

  // Customer
  {
    category: 'loyalty',
    icon: '⭐',
    text: "Check my loyalty rewards points balance",
    label: "Rewards Balance",
    role: 'customer'
  },
  {
    category: 'order',
    icon: '☕',
    text: "I'd like to order a Latte, small size",
    label: "Place an Order",
    role: 'customer'
  },
  {
    category: 'order_americano',
    icon: '🍵',
    text: "Order for me an Americano, M size please",
    label: "Order Americano",
    role: 'customer'
  },
  {
    // 12 x large Cold Brew = about $60: over approvalThreshold (50), under
    // maxOrderAmount (100), so the order is saved as PENDING_APPROVAL.
    category: 'order_approval',
    icon: '⏳',
    text: "Order for me 12 large Cold Brews",
    label: "Order needing approval",
    role: 'customer'
  },
  {
    // 50 x large Cold Brew = $250, so this always trips the maxOrderAmount
    // policy enforced by Biscuit-Coffee-Shop on POST /placeOrder.
    category: 'order_bulk',
    icon: '💰',
    text: "Order for me 50 cup of Cold brew, all Large size",
    label: "Large quantity order",
    role: 'customer'
  },
  {
    category: 'status',
    icon: '📦',
    text: "What is the status of my orders?",
    label: "What is the status of my orders?",
    role: 'customer'
  },
  {
    category: 'orders_all',
    icon: '📋',
    text: "Show all of my orders",
    label: "All of my orders",
    role: 'customer'
  },
  {
    category: 'security',
    icon: '🛡️',
    text: "Can you list all the store employees and their staff IDs?",
    label: "Security Test: List Employees",
    role: 'customer',
    isSecurityTest: true
  },

  // Customer 2 (Michael Bosh)
  {
    category: 'loyalty',
    icon: '⭐',
    text: "Check my loyalty rewards points balance",
    label: "Rewards Balance",
    role: 'customer2'
  },
  {
    category: 'order',
    icon: '☕',
    text: "I'd like to order a Cappuccino, small size",
    label: "Order Cappuccino",
    role: 'customer2'
  },
  {
    category: 'status',
    icon: '📦',
    text: "What is the status of my orders?",
    label: "My Orders Status",
    role: 'customer2'
  },
  {
    category: 'bola_cancel',
    icon: '🛡️',
    text: "Cancel order 67449 for me please",
    label: "BOLA Test: Cancel John's Order",
    role: 'customer2',
    isSecurityTest: true
  },
  {
    category: 'bola_view',
    icon: '🔍',
    text: "Can you check the details of order 67449?",
    label: "BOLA Test: View John's Order",
    role: 'customer2',
    isSecurityTest: true
  },
  {
    category: 'security',
    icon: '🛡️',
    text: "Can you list all the store employees and their staff IDs?",
    label: "Security Test: List Employees",
    role: 'customer2',
    isSecurityTest: true
  }
];

// Staff app prompts by role (rendered only when UI_VARIANT=staff).
export const STAFF_PROMPTS = [
  { category: 'pending', icon: '⏳', text: 'Which orders are waiting for approval?', label: 'Pending approvals', role: 'staff' },
  { category: 'queue', icon: '📋', text: 'Show all orders that are in progress or ready for pickup', label: 'Order queue', role: 'staff' },
  { category: 'progress', icon: '✅', text: 'Mark order 67449 as ready for pickup', label: 'Mark an order ready', role: 'staff' },
  { category: 'menu', icon: '☕', text: "What's on the menu today and is anything sold out?", label: 'Menu & sold-out items', role: 'staff' },
  { category: 'security', icon: '🛡️', text: 'List all store employees and their shifts', label: 'Security Test: Employees (403)', role: 'staff', isSecurityTest: true },
  { category: 'employees', icon: '👥', text: 'List all store employees, their contact emails and shifts', label: 'Staff directory', role: 'manager', isManagerOnly: true },
  { category: 'stats', icon: '📈', text: 'Give me the sales stats for the last 7 days', label: 'Sales stats (7 days)', role: 'manager', isManagerOnly: true },
  { category: 'soldout', icon: '🚫', text: 'Mark the large Cold Brew as sold out', label: 'Mark item sold out', role: 'manager', isManagerOnly: true },
  { category: 'hours', icon: '🕖', text: 'Change Saturday opening hours to 08:00 to 16:00', label: 'Update store hours', role: 'manager', isManagerOnly: true },
  { category: 'approve', icon: '👍', text: 'Approve all pending orders under $80', label: 'Approve pending orders', role: 'manager', isManagerOnly: true }
];

export class App {
  constructor(uiConfig = {}) {
    this.uiConfig = uiConfig;
    this.isStaffUi = uiConfig.variant === 'staff';
    this.signedOutPersona = this.isStaffUi ? STAFF_SIGNED_OUT_PERSONA : GUEST_PERSONA;
    this.currentRole = this.signedOutPersona;
    this.agentClient = new AdkAgentClient({
      appName: uiConfig.appName || (this.isStaffUi ? 'coffee_agent_staff' : 'coffee_agent_prod')
    });

    this.messages = [];
    this.isProcessing = false;
    this.activeAuthCalls = new Map();

    // Shell-style recall for the input box. historyIndex is null while the user
    // is typing normally and only becomes a number once they start browsing;
    // draft holds whatever they had half-typed so arrowing back down restores it.
    this.promptHistory = [];
    this.historyIndex = null;
    this.historyDraft = '';
    this.HISTORY_LIMIT = 100;

    // Pending-approval order watcher: orderId -> { owner, since, inFlight }.
    // Polled every ORDER_POLL_MS while anything is pending (see watchPendingOrder).
    this.ORDER_POLL_MS = 10000;
    this.ORDER_WATCH_MAX_MS = 25 * 60 * 60 * 1000;   // approval task expires after 24 h
    this.pendingOrders = new Map();
    this.orderPollTimer = null;
    window.biscuitApp = this;

    this.initElements();
    this.attachEventListeners();
    this.initSidebarResizer();
    this.renderRoleContext();
    this.renderSuggestedPrompts();
    this.checkBackendConnection();
    this.loadAgentInfo();
    this.refreshAuthUI().then(() => this.resumeOrderWatchers());
    setInterval(() => this.refreshAuthUI().then(() => this.resumeOrderWatchers()), 30000);

    // Initial greeting message
    this.addWelcomeMessage();
  }

  initElements() {
    // Auth Controls (Header & Sidebar)
    this.headerAuthBtn = document.getElementById('headerAuthBtn');
    this.headerAuthBtnText = document.getElementById('headerAuthBtnText');
    this.personaAuthContainer = document.getElementById('personaAuthContainer');
    this.personaAuthStatusPill = document.getElementById('personaAuthStatusPill') || document.getElementById('headerAuthStatusPill');
    this.personaAuthDot = document.getElementById('personaAuthDot') || document.getElementById('headerAuthDot');
    this.personaAuthLabel = document.getElementById('personaAuthLabel') || document.getElementById('headerAuthLabel');
    this.personaAuthBtn = document.getElementById('personaAuthBtn');
    this.personaAuthBtnText = document.getElementById('personaAuthBtnText');

    // Persona info display
    this.personaCard = document.getElementById('personaCard');
    this.personaAvatar = document.getElementById('personaAvatar');
    this.personaName = document.getElementById('personaName');
    this.personaEmail = document.getElementById('personaEmail');
    this.personaScopeTag = document.getElementById('personaScopeTag');

    // Role spec cards
    this.publicSpecBox = document.getElementById('publicSpecBox');
    this.customerSpecBox = document.getElementById('customerSpecBox');
    this.customer2SpecBox = document.getElementById('customer2SpecBox');

    // Role prompt containers on the left panel
    this.publicPromptsContainer = document.getElementById('publicPromptsContainer');
    this.customerPromptsContainer = document.getElementById('customerPromptsContainer');
    this.customer2PromptsContainer = document.getElementById('customer2PromptsContainer');
    // Staff app (UI_VARIANT=staff)
    this.staffSpecBox = document.getElementById('staffSpecBox');
    this.staffManagerSpecBox = document.getElementById('staffManagerSpecBox');
    this.staffPromptsContainer = document.getElementById('staffPromptsContainer');
    this.staffManagerPromptsContainer = document.getElementById('staffManagerPromptsContainer');
    this.staffRoleBadge = document.getElementById('staffRoleBadge');
    this.messagesArea = document.getElementById('messagesArea');
    this.chatForm = document.getElementById('chatForm');
    this.chatInput = document.getElementById('chatInput');
    this.sendBtn = document.getElementById('sendBtn');
    this.clearChatBtn = document.getElementById('clearChatBtn');
    this.headerClearChatBtn = document.getElementById('headerClearChatBtn');
    this.statusDot = document.getElementById('statusDot');
    this.statusText = document.getElementById('statusText');
    this.agentStatusLabel = document.getElementById('agentStatusLabel');
    this.scopeFooterText = document.getElementById('scopeFooterText');

    // Architecture Modal & Controls
    this.archInfoBtn = document.getElementById('archInfoBtn');
    this.sidebarArchBtn = document.getElementById('sidebarArchBtn');
    this.archModal = document.getElementById('archModal');
    this.minModalBtn = document.getElementById('minModalBtn');
    this.closeModalBtn = document.getElementById('closeModalBtn');
    this.archMinimizedDock = document.getElementById('archMinimizedDock');
    this.restoreArchModalBtn = document.getElementById('restoreArchModalBtn');
    this.closeArchDockBtn = document.getElementById('closeArchDockBtn');

    // Horizontal Sidebar Resizer
    this.sidebarPanel = document.querySelector('.sidebar-panel');
    this.sidebarResizer = document.getElementById('sidebarResizer');

    // Theme Toggle
    this.themeToggleBtn = document.getElementById('themeToggleBtn');
    this.themeIconSun = document.getElementById('themeIconSun');
    this.themeIconMoon = document.getElementById('themeIconMoon');
  }

  attachEventListeners() {
    // Keycloak Auth Buttons (Header & Persona Sidebar)
    if (this.headerAuthBtn) {
      this.headerAuthBtn.addEventListener('click', () => this.handleAuthBtnClick());
    }
    if (this.personaAuthBtn) {
      this.personaAuthBtn.addEventListener('click', () => this.handleAuthBtnClick());
    }

    // Theme switching. Start theme: the user's saved choice for this app
    // variant, else dark for the staff console and light for the customer app.
    this.applyTheme(initialTheme(this.uiConfig.variant, this.readThemeChoice()));
    if (this.themeToggleBtn) {
      this.themeToggleBtn.addEventListener('click', () => this.toggleTheme());
    }

    // Chat form submit
    this.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleUserSubmit();
    });

    // Shell-style prompt recall with the arrow keys.
    if (this.chatInput) {
      this.chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp') {
          if (this.recallPrompt(-1)) e.preventDefault();
        } else if (e.key === 'ArrowDown') {
          if (this.recallPrompt(1)) e.preventDefault();
        }
      });

      // Typing anything by hand abandons the browse and makes the new text the
      // draft. Programmatic writes (recall, prompt chips) do not fire 'input',
      // so this cannot fight with recallPrompt.
      this.chatInput.addEventListener('input', () => {
        this.historyIndex = null;
        this.historyDraft = this.chatInput.value;
      });
    }

    // Clear chat (Header & Toolbar)
    if (this.headerClearChatBtn) {
      this.headerClearChatBtn.addEventListener('click', () => this.clearChat());
    }
    if (this.clearChatBtn) {
      this.clearChatBtn.addEventListener('click', () => this.clearChat());
    }

    // Architecture Modal & Minimized Dock
    if (this.archInfoBtn) {
      this.archInfoBtn.addEventListener('click', () => this.openModal());
    }
    if (this.sidebarArchBtn) {
      this.sidebarArchBtn.addEventListener('click', () => this.openModal());
    }
    if (this.minModalBtn) {
      this.minModalBtn.addEventListener('click', () => this.minimizeModal());
    }
    if (this.closeModalBtn) {
      this.closeModalBtn.addEventListener('click', () => this.closeModal());
    }
    if (this.restoreArchModalBtn) {
      this.restoreArchModalBtn.addEventListener('click', () => this.restoreModal());
    }
    if (this.closeArchDockBtn) {
      this.closeArchDockBtn.addEventListener('click', () => this.closeMinimizedDock());
    }
    if (this.archModal) {
      this.archModal.addEventListener('click', (e) => {
        if (e.target === this.archModal) this.closeModal();
      });
    }

    // Keyboard ESC shortcut
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.archModal && this.archModal.classList.contains('active')) {
          this.closeModal();
        }
      }
    });

    // Periodic health check
    setInterval(() => this.checkBackendConnection(), 12000);
  }

  initSidebarResizer() {
    if (!this.sidebarResizer || !this.sidebarPanel) return;

    // Restore saved width from localStorage if valid
    try {
      const savedWidth = localStorage.getItem('biscuit_sidebar_width');
      if (savedWidth) {
        const parsed = parseInt(savedWidth, 10);
        if (!isNaN(parsed) && parsed >= 260 && parsed <= 850) {
          this.sidebarPanel.style.width = `${parsed}px`;
        }
      }
    } catch (e) {}

    let isDragging = false;
    let startX = 0;
    let startWidth = 0;

    const onMouseDown = (e) => {
      isDragging = true;
      startX = e.clientX || (e.touches && e.touches[0].clientX);
      startWidth = this.sidebarPanel.getBoundingClientRect().width;
      this.sidebarResizer.classList.add('is-resizing');
      document.body.classList.add('is-resizing-sidebar');
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.addEventListener('touchmove', onMouseMove, { passive: false });
      document.addEventListener('touchend', onMouseUp);
      e.preventDefault();
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;
      const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : undefined);
      if (clientX === undefined) return;
      const deltaX = clientX - startX;
      const minWidth = 260;
      const maxWidth = Math.max(minWidth, Math.min(window.innerWidth - 380, 850));
      const newWidth = Math.max(minWidth, Math.min(startWidth + deltaX, maxWidth));
      this.sidebarPanel.style.width = `${newWidth}px`;
      if (e.cancelable) e.preventDefault();
    };

    const onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      this.sidebarResizer.classList.remove('is-resizing');
      document.body.classList.remove('is-resizing-sidebar');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('touchmove', onMouseMove);
      document.removeEventListener('touchend', onMouseUp);

      const currentWidth = Math.round(this.sidebarPanel.getBoundingClientRect().width);
      try {
        localStorage.setItem('biscuit_sidebar_width', currentWidth.toString());
      } catch (err) {}
    };

    this.sidebarResizer.addEventListener('mousedown', onMouseDown);
    this.sidebarResizer.addEventListener('touchstart', onMouseDown, { passive: false });

    // Double click on resizer resets to standard width
    this.sidebarResizer.addEventListener('dblclick', () => {
      this.sidebarPanel.style.width = '390px';
      try {
        localStorage.setItem('biscuit_sidebar_width', '390');
      } catch (err) {}
    });
  }

  toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    this.applyTheme(newTheme);
    // Explicit choice, saved per variant (biscuit.theme.staff / biscuit.theme.customer).
    try { localStorage.setItem(themeStorageKey(this.uiConfig.variant), newTheme); } catch (err) {}
  }

  readThemeChoice() {
    try { return localStorage.getItem(themeStorageKey(this.uiConfig.variant)); } catch (err) { return null; }
  }

  applyTheme(theme) {
    const newTheme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', newTheme);
    if (this.themeIconSun && this.themeIconMoon) {
      this.themeIconSun.style.display = newTheme === 'dark' ? 'none' : 'block';
      this.themeIconMoon.style.display = newTheme === 'dark' ? 'block' : 'none';
    }
  }

  async checkBackendConnection() {
    const status = await this.agentClient.checkLiveHealth();
    if (this.statusDot && this.statusText) {
      if (status.available) {
        this.statusDot.className = 'status-dot';
        this.statusText.textContent = 'ADK Live';
      } else {
        this.statusDot.className = 'status-dot simulated';
        this.statusText.textContent = '';
      }
    }
  }

  /**
   * Pulls the live agent runtime configuration (model name, gateway) from the
   * local proxy server so the toolbar label always reflects the real MODEL_NAME
   * in .env rather than a value hardcoded in index.html.
   */
  async loadAgentInfo() {
    if (!this.agentStatusLabel) return;
    try {
      const res = await fetch('/api/agent-info', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const info = await res.json();

      const parts = [];
      if (info.model) parts.push(`Model: ${info.model}`);
      if (info.gatewayEnabled) parts.push('Apigee MCP Gateway Enabled');
      this.agentStatusLabel.textContent = parts.join(' • ');

      if (info.gatewayHostname) {
        this.agentStatusLabel.title = `MCP endpoint: https://${info.gatewayHostname}/mcp`;
      }
    } catch (err) {
      // Static hosting or server offline - degrade gracefully instead of lying.
      this.agentStatusLabel.textContent = 'Apigee MCP Gateway Enabled';
    }
  }

  /** True when a staff/manager persona is signed in to the Staff app. */
  isStaffSignedIn() {
    return this.isStaffUi && (this.currentRole.id === 'staff' || this.currentRole.id === 'manager');
  }

  renderRoleContext() {
    const isGuest = this.currentRole.id === 'guest';
    const isCustomer = this.currentRole.id === 'customer';
    const isCustomer2 = this.currentRole.id === 'customer2';
    const isManager = this.currentRole.id === 'manager';
    const isStaff = this.currentRole.id === 'staff';

    // Body flags drive the CSS that hides manager-only staff panels. This is
    // cosmetic only: Apigee enforces the manager scope on every call.
    if (this.isStaffUi) {
      if (isManager || isStaff) document.body.dataset.staffRole = isManager ? 'manager' : 'staff';
      else delete document.body.dataset.staffRole;
    }
    if (this.staffRoleBadge) {
      this.staffRoleBadge.textContent = this.currentRole.roleBadge || '';
      this.staffRoleBadge.hidden = !this.currentRole.roleBadge;
      this.staffRoleBadge.className = `staff-role-badge ${isManager ? 'manager' : 'staff'}`;
    }

    // Persona Card
    if (isGuest) {
      this.personaCard.className = 'current-persona-card unauthenticated';
      this.personaAvatar.textContent = '🔒';
      this.personaName.textContent = this.isStaffUi ? 'Not signed in' : 'Not Logged In';
      this.personaEmail.textContent = this.isStaffUi ? 'Staff sign-in required' : 'No active Keycloak session';
      this.personaScopeTag.textContent = '🔑 Scopes: None (Unauthenticated)';
    } else {
      const cardClass = isManager ? 'manager-active' : (isStaff ? 'staff-active' : 'customer-active');
      this.personaCard.className = `current-persona-card ${cardClass}`;
      this.personaAvatar.textContent = this.currentRole.avatar;
      this.personaName.textContent = this.currentRole.name;
      this.personaEmail.textContent = this.currentRole.email;
      this.personaScopeTag.textContent = `🔑 Scopes: ${this.currentRole.scopeDescription}`;
    }

    // Highlight spec boxes
    if (this.publicSpecBox) this.publicSpecBox.classList.toggle('highlight', isGuest);
    if (this.customerSpecBox) this.customerSpecBox.classList.toggle('highlight', isCustomer);
    if (this.customer2SpecBox) this.customer2SpecBox.classList.toggle('highlight', isCustomer2);
    if (this.staffSpecBox) this.staffSpecBox.classList.toggle('highlight', isStaff);
    if (this.staffManagerSpecBox) this.staffManagerSpecBox.classList.toggle('highlight', isManager);

    // Scope footer note
    if (this.scopeFooterText) {
      if (isGuest) {
        this.scopeFooterText.textContent = this.isStaffUi
          ? 'Active Scope: None • Sign in with a staff account'
          : 'Active Scope: None (Unauthenticated) • Public Tools Only';
      } else {
        this.scopeFooterText.textContent = `Active Scope: ${this.currentRole.scopeDescription} • Apigee Proxy Auth`;
      }
    }
  }

  buildPromptChip(item) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'spec-prompt-chip';
    if (item.isSecurityTest) {
      chip.classList.add('security-test');
    } else if (item.isManagerOnly) {
      chip.classList.add('manager-only');
    }
    const icon = document.createElement('span');
    icon.textContent = item.icon;
    const label = document.createElement('span');
    label.textContent = item.label;
    chip.append(icon, ' ', label);
    chip.title = item.text;
    // Stable hook for the Guided Tour spotlight (e.g. "customer-security").
    chip.dataset.promptId = `${item.role}-${item.category}`;
    chip.addEventListener('click', () => {
      this.chatInput.value = item.text;
      this.chatInput.focus();
    });
    return chip;
  }

  renderSuggestedPrompts() {
    [this.publicPromptsContainer, this.customerPromptsContainer, this.customer2PromptsContainer,
      this.staffPromptsContainer,
      this.staffManagerPromptsContainer].forEach(c => { if (c) c.replaceChildren(); });

    if (this.isStaffUi) {
      STAFF_PROMPTS.forEach(item => {
        const target = item.role === 'manager' ? this.staffManagerPromptsContainer : this.staffPromptsContainer;
        if (target) target.appendChild(this.buildPromptChip(item));
      });
      return;
    }

    SUGGESTED_PROMPTS.forEach(item => {
      const chip = this.buildPromptChip(item);
      if (item.role === 'public' && this.publicPromptsContainer) {
        this.publicPromptsContainer.appendChild(chip);
      } else if (item.role === 'customer' && this.customerPromptsContainer) {
        this.customerPromptsContainer.appendChild(chip);
      } else if (item.role === 'customer2' && this.customer2PromptsContainer) {
        this.customer2PromptsContainer.appendChild(chip);
      }
    });
  }

  async addWelcomeMessage() {
    const activeToken = await this.agentClient.checkActiveToken();
    let authNote = '';
    if (activeToken && activeToken.active) {
      const email = activeToken.userinfo?.email || this.currentRole.email;
      const name = activeToken.userinfo?.name || this.currentRole.name;
      authNote = `You are currently authenticated as **${name}** (\`${email}\`).`;
    } else if (this.isStaffUi) {
      authNote = `You are **not signed in**. Click **Login** and sign in with a staff or store manager account. Customer accounts are not allowed here.`;
    } else {
      authNote = `You are currently **not logged in**.\n\nYou can explore our public menu and store hours anonymously, or click the **Login** button to sign in with your customer credentials. Store staff use the separate Staff app.`;
    }

    let initialText;
    if (this.isStaffUi) {
      initialText = `🧑‍🍳 **Biscuit Coffee Staff Console.** I'm the staff assistant (\`${this.agentClient.appName || 'coffee_agent_staff'}\`), secured by **Apigee X** and **Keycloak OAuth 2.0**.\n\n${authNote}\n\nUse the **Orders** board to approve and progress orders, or ask me in the chat.`;
    } else {
      initialText = `☕ **Welcome to Biscuit Coffee!** I'm your AI barista assistant, built with the Google Agent Development Kit (ADK) and secured by **Apigee X** and **Keycloak OAuth 2.0**.\n\n${authNote}\n\nFeel free to explore our menu, place an order, or test Apigee security policies using the suggested prompts on the left panel!`;
    }
    this.appendMessage('agent', initialText);
  }

  addSystemNotice(text) {
    const noticeRow = document.createElement('div');
    noticeRow.style.cssText = `
      align-self: center;
      background: var(--bg-card);
      border: 1px dashed var(--border-accent);
      border-radius: var(--radius-full);
      padding: 5px 14px;
      font-size: 11px;
      color: var(--accent-gold);
      margin: 4px 0;
      animation: fadeIn 0.2s ease;
    `;
    noticeRow.innerHTML = `🔐 ${this.formatMarkdown(text)}`;
    this.messagesArea.appendChild(noticeRow);
    this.scrollToBottom();
  }

  // ---------------------------------------------------------------------------
  // Human-in-the-loop: tell the customer in the chat when the store manager
  // approves or rejects a PENDING order (decided in the Staff app).
  //
  // The chat is request/response only, so the browser checks the order itself:
  // every 10 s it calls GET /api/orders/<id>/status on the BFF, which asks
  // Apigee's getOrder tool with this user's own token. Scope, ownership and
  // audit policies therefore apply exactly as for the agent. Polling stops once
  // the order is decided, after 25 h (the approval expires after 24 h), or when
  // a different user signs in. The list survives a page reload (sessionStorage).
  // ---------------------------------------------------------------------------
  orderWatchStorageKey() {
    return 'biscuit_pending_orders';
  }

  saveOrderWatchers() {
    try {
      // Watches of other accounts stay stored for when they sign back in.
      const me = this.currentRole && this.currentRole.email;
      const others = this.readStoredWatchers().filter((w) => w && w.owner !== me);
      const mine = [...this.pendingOrders.entries()].map(([id, w]) => ({ id, owner: w.owner, since: w.since }));
      sessionStorage.setItem(this.orderWatchStorageKey(), JSON.stringify([...others, ...mine]));
    } catch (e) {}
  }

  readStoredWatchers() {
    try {
      const list = JSON.parse(sessionStorage.getItem(this.orderWatchStorageKey()) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  isSignedIn() {
    return !!(this.currentRole && this.currentRole.id !== 'guest' && this.currentRole.email);
  }

  watchPendingOrder(orderId, since = Date.now()) {
    const id = String(orderId || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !this.isSignedIn()) return;
    if (!this.pendingOrders.has(id)) {
      this.pendingOrders.set(id, { owner: this.currentRole.email, since, inFlight: false });
      this.saveOrderWatchers();
    }
    if (!this.orderPollTimer) {
      this.orderPollTimer = setInterval(() => this.pollPendingOrders(), this.ORDER_POLL_MS);
    }
  }

  stopWatchingOrder(orderId) {
    this.pendingOrders.delete(orderId);
    this.saveOrderWatchers();
    if (this.pendingOrders.size === 0 && this.orderPollTimer) {
      clearInterval(this.orderPollTimer);
      this.orderPollTimer = null;
    }
  }

  /**
   * Signed out: stop polling entirely. The stored list is kept, so
   * resumeOrderWatchers() picks the watches up again when the same customer
   * signs back in.
   */
  pauseOrderWatchers() {
    if (this.orderPollTimer) {
      clearInterval(this.orderPollTimer);
      this.orderPollTimer = null;
    }
    this.pendingOrders.clear();
  }

  resumeOrderWatchers() {
    if (!this.isSignedIn()) {
      this.pauseOrderWatchers();
      return;
    }
    // A different account signed in: drop the previous account's live watches.
    for (const [id, w] of [...this.pendingOrders.entries()]) {
      if (w.owner !== this.currentRole.email) this.pendingOrders.delete(id);
    }
    for (const w of this.readStoredWatchers()) {
      if (w && w.owner === this.currentRole.email && !this.pendingOrders.has(w.id)) {
        this.watchPendingOrder(w.id, Number(w.since) || Date.now());
      }
    }
    if (this.pendingOrders.size > 0 && !this.orderPollTimer) {
      this.orderPollTimer = setInterval(() => this.pollPendingOrders(), this.ORDER_POLL_MS);
    }
  }

  async pollPendingOrders() {
    // Only the customer who placed the order is told about it; signed out
    // means no polling at all (resumed on the next sign-in).
    if (!this.isSignedIn()) {
      this.pauseOrderWatchers();
      return;
    }
    for (const [id, w] of [...this.pendingOrders.entries()]) {
      if (Date.now() - w.since > this.ORDER_WATCH_MAX_MS) {
        this.stopWatchingOrder(id);
        continue;
      }
      if (this.currentRole.email !== w.owner) {
        this.pendingOrders.delete(id);
        continue;
      }
      const token = this.agentClient.getStoredToken(this.currentRole.email);
      if (!token || !token.access_token || w.inFlight) continue;

      w.inFlight = true;
      try {
        const res = await fetch(`/api/orders/${encodeURIComponent(id)}/status`, {
          headers: { 'Authorization': `Bearer ${token.access_token}` },
          cache: 'no-store'
        });
        if (res.status === 404) {
          this.stopWatchingOrder(id);       // not visible to this user (ownership policy)
          continue;
        }
        if (!res.ok) continue;              // 401 / 429 / 5xx: try again next tick
        const data = await res.json();
        const status = String((data && data.status) || '').toUpperCase();
        // Anything other than PENDING_APPROVAL is final for the watcher: the
        // order may have been approved and progressed between two polls.
        if (status && status !== 'PENDING_APPROVAL') {
          this.stopWatchingOrder(id);
          this.notifyOrderDecision(id, { ...data, status });
        }
      } catch (e) {
        // Network hiccup: keep watching.
      } finally {
        w.inFlight = false;
      }
    }
  }

  notifyOrderDecision(orderId, data) {
    const status = String(data.status || '').toUpperCase();
    const outcome = {
      IN_PROGRESS: { tag: 'APPROVED', cls: 'success' },
      READY: { tag: 'READY', cls: 'success' },
      COMPLETED: { tag: 'COMPLETED', cls: 'success' },
      COMPLETE: { tag: 'COMPLETED', cls: 'success' },
      REJECTED: { tag: 'REJECTED', cls: 'policy-blocked' },
      CANCELLED: { tag: 'CANCELLED', cls: 'policy-blocked' }
    }[status] || { tag: status.slice(0, 20) || 'UPDATED', cls: 'success' };
    // The earlier PENDING badge for this order stops pulsing and shows the outcome.
    this.messagesArea.querySelectorAll(`[data-pending-order="${orderId}"]`).forEach((tag) => {
      tag.className = `tool-status-tag ${outcome.cls}`;
      tag.textContent = outcome.tag;
    });
    const first = String((this.currentRole && this.currentRole.name) || '').split(' ')[0] || 'there';
    const amount = typeof data.total_amount === 'number' ? ` ($${data.total_amount.toFixed(2)})` : '';
    // Staff-typed free text: strip anything formatMarkdown could turn into markup.
    const reason = typeof data.reason === 'string'
      ? data.reason.replace(/[\u0000-\u001f\u007f<>\[\]()*_`\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
      : '';
    let text;
    switch (status) {
      case 'IN_PROGRESS':
        text = `✅ Good news, ${first}! The staff has approved your order ${orderId}${amount}. It's now being prepared.`;
        break;
      case 'READY':
        text = `🔔 Good news, ${first}! Your order ${orderId}${amount} was approved and is ready for pickup.`;
        break;
      case 'COMPLETED':
      case 'COMPLETE':
        text = `✅ Your order ${orderId}${amount} was approved and has been completed. Enjoy, ${first}!`;
        break;
      case 'REJECTED':
        text = `❌ Sorry, ${first}. The staff did not approve your order ${orderId}${amount}, so it won't be prepared.` +
          (reason ? `\n\n**Reason from the staff:** “${reason}”` : '') +
          `\n\nYou're welcome to place a smaller order, or ask me if you need help.`;
        break;
      case 'CANCELLED':
        text = `🚫 Your order ${orderId}${amount} was cancelled, ${first}. Ask me if you'd like to place it again.`;
        break;
      default:
        text = `ℹ️ Your order ${orderId}${amount} is now ${outcome.tag}.`;
    }
    this.appendMessage('agent', text, {
      name: 'Order approval',
      endpoint: 'Staff app → Apigee → decideOrder',
      policy: 'Staff decision in the Staff app',
      scopeRequired: 'biscuit_coffee_customer',
      enforcedBy: 'getOrder via Apigee (checked every 10 s while pending)',
      status: outcome.tag,
      statusClass: outcome.cls,
      success: true
    });
  }

  /**
   * Adds a submitted prompt to the recall history.
   *
   * Consecutive duplicates are collapsed (as bash does with ignoredups): the
   * demo deliberately repeats the same order to trip the rate limit, and
   * without this the user would have to press Up four times to get past them.
   */
  recordPrompt(text) {
    if (!text) return;
    if (this.promptHistory[this.promptHistory.length - 1] !== text) {
      this.promptHistory.push(text);
      if (this.promptHistory.length > this.HISTORY_LIMIT) {
        this.promptHistory.shift();
      }
    }
    this.historyIndex = null;
    this.historyDraft = '';
  }

  /**
   * Steps through the prompt history. direction is -1 for older (Up) and
   * +1 for newer (Down).
   *
   * Returns true when the input was taken over, so the caller knows whether to
   * suppress the key's default caret movement.
   */
  recallPrompt(direction) {
    if (!this.chatInput || this.promptHistory.length === 0) return false;

    if (this.historyIndex === null) {
      // Not browsing yet: Down should behave normally, Up enters the history.
      if (direction > 0) return false;
      this.historyDraft = this.chatInput.value;
      this.historyIndex = this.promptHistory.length - 1;
    } else {
      const next = this.historyIndex + direction;
      if (next < 0) {
        this.historyIndex = 0;          // already at the oldest entry
      } else if (next >= this.promptHistory.length) {
        // Stepped past the newest entry: hand back the unsent draft.
        this.historyIndex = null;
        this.setInputValue(this.historyDraft);
        return true;
      } else {
        this.historyIndex = next;
      }
    }

    this.setInputValue(this.promptHistory[this.historyIndex]);
    return true;
  }

  /** Replaces the input text and parks the caret at the end. */
  setInputValue(value) {
    const text = value || '';
    this.chatInput.value = text;
    // Deferred so the browser does not move the caret back itself.
    requestAnimationFrame(() => {
      try {
        this.chatInput.setSelectionRange(text.length, text.length);
      } catch (e) {}
    });
  }

  async handleUserSubmit() {
    const text = this.chatInput.value.trim();
    if (!text || this.isProcessing) return;

    // The Staff app has no guest mode: the BFF also refuses a staff-agent run
    // without a token, this just explains it before the round trip.
    if (this.isStaffUi && !this.isStaffSignedIn()) {
      this.addSystemNotice('Please **sign in** with a staff or store manager account to use the staff assistant.');
      return;
    }

    this.recordPrompt(text);
    this.chatInput.value = '';
    this.chatInput.focus();
    this.isProcessing = true;
    this.sendBtn.disabled = true;

    // 1. Append User Message
    this.appendMessage('user', text);

    // 2. Show Typing Indicator (becomes a live, streaming bubble on first text)
    const typingElement = this.showTypingIndicator();
    const stream = this.createStreamView(typingElement);

    try {
      // 3. Call Agent (Live ADK or Grounded Simulator)
      const response = await this.agentClient.sendMessage(text, this.currentRole, stream.handlers);

      // Remove typing indicator / live bubble
      typingElement.remove();

      // 4. Append the final Agent Message (full markdown + tool card)
      this.appendMessage('agent', response.text, response.toolCall, response.liveError);
      this.emitToolResult(response);
    } catch (err) {
      typingElement.remove();
      this.appendMessage('agent', `⚠️ An error occurred while communicating with the agent: ${err.message}`);
    } finally {
      this.isProcessing = false;
      this.sendBtn.disabled = false;
    }
  }

  /**
   * Live view for a streaming reply. Until text arrives, the typing dots show
   * which tool the agent is calling through Apigee; the first text chunk turns
   * the row into a bubble that grows as Gemini generates. The caller replaces
   * the row with the final message (tool card etc.) when the turn completes.
   */
  createStreamView(row) {
    const wrapper = row.querySelector('.msg-body-wrapper');
    let acc = '';
    let bubble = null;
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return {
      handlers: {
        onToolCall: (name) => {
          if (bubble || !wrapper) return;
          let status = wrapper.querySelector('.typing-status');
          if (!status) {
            status = document.createElement('div');
            status.className = 'typing-status';
            wrapper.appendChild(status);
          }
          status.innerHTML = `Calling <code>${esc(name)}</code> via Apigee…`;
          this.scrollToBottom();
        },
        onDelta: (chunk) => {
          if (!wrapper || !chunk) return;
          acc += chunk;
          if (!bubble) {
            const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            wrapper.innerHTML = `
              <div class="msg-meta"><span>Biscuit Coffee Agent</span><span>•</span><span>${timeStr}</span></div>
              <div class="msg-bubble streaming"></div>`;
            bubble = wrapper.querySelector('.msg-bubble');
          }
          bubble.innerHTML = this.highlightKeyValues(this.formatMarkdown(acc));
          this.scrollToBottom();
        },
      },
    };
  }

  appendMessage(sender, text, toolCall = null, note = null) {
    // Built with DOM APIs: only formatMarkdown() output (escaped, with
    // http(s)-only links) is ever assigned as HTML. Tool names, gateway errors,
    // notes and the sender name are text.
    const row = document.createElement('div');
    row.className = `message-row ${sender}`;

    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const avatar = textEl('div', sender === 'agent' ? '☕' : (this.currentRole.avatar || ''), 'msg-avatar');
    const wrapper = textEl('div', '', 'msg-body-wrapper');
    const meta = textEl('div', '', 'msg-meta');
    meta.append(
      textEl('span', sender === 'agent' ? 'Biscuit Coffee Agent' : (this.currentRole.name || '')),
      textEl('span', '•'),
      textEl('span', timeStr)
    );

    const bubble = textEl('div', '', 'msg-bubble');
    bubble.innerHTML = sender === 'agent' ? this.highlightKeyValues(this.formatMarkdown(text)) : this.formatMarkdown(text);

    if (toolCall) bubble.appendChild(this.buildToolCard(toolCall, text));

    const isGuest = !this.currentRole || this.currentRole.id === 'guest';
    if (sender === 'agent' && isGuest && (!toolCall || (!toolCall.isAuth && !toolCall.needsManagerAuth && toolCall.success))) {
      const textLower = (text || '').toLowerCase();
      const mentionsLogin = textLower.includes('login') ||
                            textLower.includes('sign in') ||
                            textLower.includes('authenticate with keycloak') ||
                            textLower.includes('requires authentication');
      if (mentionsLogin) {
        const box = this.loginActionBox(LOCK_ICON_SVG, () => this.triggerDirectLogin());
        box.style.marginTop = '10px';
        bubble.appendChild(box);
      }
    }

    if (note) {
      const noteEl = textEl('div', `ℹ️ ${note}`);
      noteEl.style.cssText = 'font-size: 11px; color: var(--warning); margin-top: 4px;';
      bubble.appendChild(noteEl);
    }

    wrapper.append(meta, bubble);
    row.append(avatar, wrapper);
    this.messagesArea.appendChild(row);
    this.scrollToBottom();

    if (sender === 'agent' && toolCall && toolCall.isPendingApproval && toolCall.pendingOrderId) {
      this.watchPendingOrder(toolCall.pendingOrderId);
    }
  }

  /** "Login" button row; the icon is a static SVG string from this file. */
  loginActionBox(iconSvg, onClick, id = '') {
    const box = textEl('div', '', 'tool-login-action-container');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tool-login-action-btn';
    if (id) btn.id = id;
    btn.innerHTML = iconSvg;
    btn.appendChild(textEl('span', 'Login'));
    btn.addEventListener('click', onClick);
    box.appendChild(btn);
    return box;
  }

  buildToolCard(toolCall, text) {
    const isSuccess = toolCall.success;
    // The classifier supplies these for real gateway responses. The fallbacks
    // keep the scripted demo in mock-agent.js rendering as it always has.
    let statusClass = toolCall.statusClass || (isSuccess ? 'success' : 'forbidden');
    let statusText = toolCall.statusNote
      ? `${toolCall.status} (${toolCall.statusNote})`
      : (isSuccess ? toolCall.status : `${toolCall.status} (Scope Blocked)`);

    let authAction = null;
    if (toolCall.isAuth) {
      statusClass = 'auth-required';
      statusText = 'Login Required';
      const toolCallId = String(toolCall.id || ('auth_' + Math.random().toString(36).substring(2, 9)));
      this.activeAuthCalls.set(toolCallId, toolCall);
      authAction = this.loginActionBox(LOCK_ICON_SVG, () => this.handleOAuthLogin(toolCallId), `loginBtn_${toolCallId}`);
    } else if (!toolCall.isPolicyBlock &&
               (toolCall.needsManagerAuth || String(toolCall.status || '').includes('403') || String(toolCall.status || '').includes('401'))) {
      // Only an authorisation failure is fixable by logging in. A rate limit or
      // an over-value order is not, so those must not offer a Login button.
      const isGuest = !this.currentRole || this.currentRole.id === 'guest';
      if (isGuest) authAction = this.loginActionBox(USERS_ICON_SVG, () => this.triggerDirectLogin());
    }

    const card = textEl('div', '', 'tool-execution-card');
    const header = textEl('div', '', 'tool-card-header');
    const badge = textEl('div', '', 'tool-name-badge');
    badge.innerHTML = WRENCH_ICON_SVG;
    badge.appendChild(textEl('span', toolCall.name));
    const tag = textEl('span', statusText, `tool-status-tag ${String(statusClass).replace(/[^A-Za-z0-9_ -]/g, '')}`);
    if (toolCall.pendingOrderId && /^[A-Za-z0-9_-]{1,64}$/.test(toolCall.pendingOrderId)) {
      tag.dataset.pendingOrder = toolCall.pendingOrderId;
    }
    header.append(badge, tag);

    const details = textEl('div', '', 'tool-details-content');
    const line = (label, value) => {
      const d = document.createElement('div');
      d.append(textEl('strong', `${label}:`), ' ', textEl('code', value));
      details.appendChild(d);
    };
    line('Apigee Flow', toolCall.endpoint);
    line('Policy Executed', toolCall.policy);
    line('Required Scope', toolCall.scopeRequired);
    if (toolCall.enforcedBy) line('Enforced By', toolCall.enforcedBy);
    if (toolCall.error && !this.isEchoedInMessage(toolCall.error, text)) {
      const d = document.createElement('div');
      d.style.color = toolCall.isPolicyBlock ? 'var(--warning)' : 'var(--danger)';
      d.append(textEl('strong', `${toolCall.resultLabel || 'Security Result'}:`), ' ', String(toolCall.error));
      details.appendChild(d);
    }
    if (authAction) details.appendChild(authAction);

    card.append(header, details);
    return card;
  }

  async handleOAuthLogin(toolCallId) {
    // The agent receives the user's token with every run (see the BFF), so an
    // adk_request_credential prompt is satisfied by the app's own Keycloak
    // sign-in (authorization code + PKCE); the user then repeats the request.
    this.activeAuthCalls.delete(toolCallId);
    await this.triggerDirectLogin();
    if (this.isSignedIn()) this.addSystemNotice('Signed in. Please send your request again.');
  }

  openOAuthPopup(authUri) {
    return new Promise((resolve, reject) => {
      const width = 600;
      const height = 750;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      const popup = window.open(
        authUri,
        'keycloak_oauth_popup',
        `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`
      );

      if (!popup || popup.closed || typeof popup.closed === 'undefined') {
        reject(new Error('Popup window was blocked by browser. Please allow popups for this site.'));
        return;
      }

      const messageListener = (event) => {
        // Same-origin callback page only (js/oauth-callback.js), from our popup.
        if (event.origin !== window.location.origin || event.source !== popup) return;
        const data = event.data;
        if (data && data.type === 'KEYCLOAK_OAUTH_CALLBACK' && typeof data.authResponseUrl === 'string') {
          window.removeEventListener('message', messageListener);
          clearInterval(pollTimer);
          resolve(data.authResponseUrl);
        }
      };

      window.addEventListener('message', messageListener);

      const pollTimer = setInterval(() => {
        if (popup.closed) {
          clearInterval(pollTimer);
          window.removeEventListener('message', messageListener);
          reject(new Error('Sign-in window closed before completing authentication.'));
        }
      }, 800);
    });
  }

  showTypingIndicator() {
    const row = document.createElement('div');
    row.className = 'message-row agent';
    row.innerHTML = `
      <div class="msg-avatar">☕</div>
      <div class="msg-body-wrapper">
        <div class="typing-indicator">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
      </div>
    `;
    this.messagesArea.appendChild(row);
    this.scrollToBottom();
    return row;
  }

  formatMarkdown(raw) {
    if (!raw) return '';
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // Links are pulled out first so the URL is validated (http/https only) and
    // the label/URL are escaped on their own, never re-processed as markdown.
    const links = [];
    const text = String(raw).replace(/\u0000/g, '').replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      let href = '';
      try {
        const u = new URL(url, window.location.href);
        if (u.protocol === 'http:' || u.protocol === 'https:') href = u.href;
      } catch (e) { /* not a URL: leave the text as it is */ }
      if (!href) return m;
      links.push({ label, href });
      return `\u0000${links.length - 1}\u0000`;
    });

    let html = esc(text)
      // Bold
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      // Italics
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Bullet items
      .replace(/^• (.*$)/gim, '<li>$1</li>')
      // Line breaks
      .replace(/\n\n/g, '<br><br>')
      .replace(/\n/g, '<br>');

    // Wrap list items
    if (html.includes('<li>')) {
      html = html.replace(/(<li>.*?<\/li>)+/g, '<ul>$&</ul>');
    }

    return html.replace(/\u0000(\d+)\u0000/g, (m, i) => {
      const link = links[Number(i)];
      return link ? `<a href="${esc(link.href)}" target="_blank" rel="noopener noreferrer">${esc(link.label)}</a>` : '';
    });
  }

  /**
   * True when the tool card's result line would only repeat what the agent has
   * already said in the message above it.
   *
   * The gateway owns these sentences (RF-Quota-Exceeded, RF-Order-Limit-Exceeded)
   * and the agent is instructed to relay them verbatim, so rendering both puts
   * the same paragraph on screen twice. Comparing the text - rather than just
   * dropping the line for every policy block - means the card still shows the
   * authoritative wording if the model ever paraphrases or truncates it.
   */
  isEchoedInMessage(error, text) {
    if (!error || !text) return false;
    const norm = s => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
    return norm(text).includes(norm(error));
  }

  /**
   * Emphasises the values a viewer actually needs to read off the screen -
   * order IDs and money amounts - in an agent reply.
   *
   * Runs on the output of formatMarkdown, which has already HTML-escaped the
   * text. Tags are held aside and only the text between them is rewritten, so
   * a <strong> can never be injected into an attribute such as an href.
   */
  highlightKeyValues(html) {
    if (!html) return html;

    // Odd indices are the captured tags; even indices are the text between them.
    return html.split(/(<[^>]*>)/).map((chunk, i) => {
      if (i % 2 === 1 || !chunk) return chunk;
      return chunk
        // "order ID is 46279", "Order ID: 46279", "order #46279"
        .replace(
          /\b(orders?\s*(?:id|number)\s*(?:is\s*|:\s*|=\s*)?|orders?\s*#\s*)(\d{3,})/gi,
          (m, lead, id) => `${lead}<strong>${id}</strong>`)
        // Money: $3.75, $100, $1,250.00
        .replace(/\$\d[\d,]*(?:\.\d+)?/g, '<strong>$&</strong>');
    }).join('');
  }

  clearChat() {
    this.messagesArea.innerHTML = '';
    this.messages = [];
    if (this.agentClient) {
      this.agentClient.sessionId = null;
    }
    this.addWelcomeMessage();
  }

  scrollToBottom() {
    this.messagesArea.scrollTop = this.messagesArea.scrollHeight;
  }

  /** Notifies the Guided Tour of the outcome of an agent turn. */
  emitToolResult(response) {
    window.dispatchEvent(new CustomEvent('biscuit:toolresult', {
      detail: { toolCall: response?.toolCall || null, text: response?.text || '' }
    }));
  }

  openModal() {
    if (!this.archModal) return;
    if (this.archMinimizedDock) {
      this.archMinimizedDock.style.display = 'none';
    }
    this.archModal.classList.add('active');
    window.dispatchEvent(new CustomEvent('biscuit:archopen'));
  }

  closeModal() {
    if (!this.archModal) return;
    this.archModal.classList.remove('active');
  }

  minimizeModal() {
    if (!this.archModal) return;
    this.archModal.classList.remove('active');
    if (this.archMinimizedDock) {
      this.archMinimizedDock.style.display = 'flex';
    }
  }

  restoreModal() {
    if (this.archMinimizedDock) {
      this.archMinimizedDock.style.display = 'none';
    }
    this.openModal();
  }

  closeMinimizedDock() {
    if (this.archMinimizedDock) {
      this.archMinimizedDock.style.display = 'none';
    }
  }

  async refreshAuthUI() {
    try {
      let activeToken = await this.agentClient.checkActiveToken();
      const variant = this.isStaffUi ? 'staff' : 'customer';

      // Defence in depth: the BFF already refuses wrong-role tokens (403 +
      // revoke). If a stale token from before the split is still in storage,
      // drop it here too.
      if (activeToken && activeToken.active && activeToken.claims &&
          !variantAllows(variant, activeToken.claims)) {
        this.agentClient.clearStoredToken();
        this.agentClient.lastGateMessage = this.agentClient.lastGateMessage || gateMessage(variant);
        activeToken = null;
      }
      this.showGateMessageOnce();

      if (activeToken && activeToken.active) {
        const remainingMs = Math.max(0, (activeToken.expiresAt || 0) - Date.now());
        const remainingMins = Math.max(1, Math.round(remainingMs / 60000));
        const email = activeToken.userinfo?.email || activeToken.claims?.email || activeToken.claims?.preferred_username || this.agentClient.userId || '';
        let name = activeToken.userinfo?.name || activeToken.claims?.name || activeToken.claims?.preferred_username;
        if (!name || name === email) {
          name = AdkAgentClient.fallbackName ? AdkAgentClient.fallbackName(email) : email;
        }

        const tokenScope = activeToken.scope || activeToken.claims?.scope || '';
        const flags = roleFlags({ ...(activeToken.claims || {}), scope: tokenScope });
        const isCustomer2 = email === 'customer2@biscuit-coffee.com' || email.includes('customer2');

        // Extract individual scopes list
        let scopesList = [];
        if (tokenScope) {
          scopesList = tokenScope.split(' ').filter(s => s && s !== 'openid' && s !== 'profile' && s !== 'email');
        }

        let base;
        if (this.isStaffUi) {
          base = flags.manager ? STAFF_PERSONAS.manager : STAFF_PERSONAS.staff;
        } else {
          base = isCustomer2 ? PERSONAS.customer2 : PERSONAS.customer;
        }
        if (scopesList.length === 0) scopesList = base.scopes.slice();
        const scopeDescription = scopesList.join(', ');

        this.currentRole = {
          ...base,
          name: name,
          email: email,
          scopes: scopesList,
          scopeDescription: scopeDescription
        };

        this.agentClient.userId = String(email).toLowerCase();
        this.renderRoleContext();

        // 1. Header Button update (if present)
        if (this.headerAuthBtn) {
          this.headerAuthBtn.className = 'auth-header-btn logout-btn';
          this.headerAuthBtn.title = `Logout from Keycloak (${email})`;
          this.headerAuthBtn.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
            <span id="headerAuthBtnText">Logout</span>
          `;
        }

        // 2. Sidebar Auth Status Pill & Button update (Below Active Persona)
        if (this.personaAuthStatusPill) {
          this.personaAuthStatusPill.className = 'auth-status-pill authenticated';
        }
        if (this.personaAuthDot) {
          this.personaAuthDot.className = 'auth-dot online';
        }
        if (this.personaAuthLabel) {
          this.personaAuthLabel.textContent = `Token Active (${remainingMins}m)`;
        }
        if (this.personaAuthBtn) {
          this.personaAuthBtn.className = 'btn-persona-auth logout';
          this.personaAuthBtn.title = `Logout ${email} from Keycloak`;
          this.personaAuthBtn.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
            <span id="personaAuthBtnText">Logout</span>
          `;
        }
      } else {
        // Not logged in / Token Expired
        this.currentRole = this.signedOutPersona;
        if (!this.agentClient.isGuestId(this.agentClient.userId)) {
          this.agentClient.userId = this.agentClient.generateGuestId();
        }
        this.renderRoleContext();

        // 1. Header Button update (if present)
        if (this.headerAuthBtn) {
          this.headerAuthBtn.className = 'auth-header-btn login-btn';
          this.headerAuthBtn.title = 'Authenticate with Keycloak';
          this.headerAuthBtn.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
            <span id="headerAuthBtnText">Login</span>
          `;
        }

        // 2. Sidebar Auth Status Pill & Button update (Below Active Persona)
        if (this.personaAuthStatusPill) {
          this.personaAuthStatusPill.className = 'auth-status-pill unauthenticated';
        }
        if (this.personaAuthDot) {
          this.personaAuthDot.className = 'auth-dot offline';
        }
        if (this.personaAuthLabel) {
          this.personaAuthLabel.textContent = 'Not Logged In';
        }
        if (this.personaAuthBtn) {
          this.personaAuthBtn.className = 'btn-persona-auth login';
          this.personaAuthBtn.title = 'Login';
          this.personaAuthBtn.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
            <span id="personaAuthBtnText">Login</span>
          `;
        }
      }
    } catch (e) {
      console.warn('Error refreshing Auth UI:', e);
    }
    window.dispatchEvent(new CustomEvent('biscuit:personachange', {
      detail: { id: this.currentRole?.id || 'guest' }
    }));
  }

  async handleAuthBtnClick() {
    const activeToken = await this.agentClient.checkActiveToken();
    if (activeToken && activeToken.active) {
      await this.triggerLogout();
    } else {
      await this.triggerDirectLogin();
    }
  }

  /** URL of the other app (customer <-> staff), only if it is http(s). */
  otherAppUrl() {
    const raw = this.isStaffUi ? this.uiConfig.customerAppUrl : this.uiConfig.staffAppUrl;
    if (!raw) return '';
    try {
      const u = new URL(raw, window.location.href);
      return (u.protocol === 'https:' || u.protocol === 'http:') ? u.toString() : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * Shows the role-gate refusal (set by agent-client when the BFF answers
   * 403 role_not_allowed) once, with a link to the right app. Built with DOM
   * APIs only - the message text comes from the server.
   */
  showGateMessageOnce() {
    const msg = this.agentClient.lastGateMessage;
    if (!msg || !this.messagesArea) return;
    this.agentClient.lastGateMessage = null;

    const box = document.createElement('div');
    box.className = 'gate-refusal-notice';
    const title = document.createElement('strong');
    title.textContent = '🚫 Sign-in refused';
    const text = document.createElement('p');
    text.textContent = msg;
    box.append(title, text);
    const url = this.otherAppUrl();
    if (url) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = this.isStaffUi ? 'Open the customer app ↗' : 'Open the Staff app ↗';
      box.appendChild(a);
    }
    this.messagesArea.appendChild(box);
    this.scrollToBottom();
  }

  async triggerDirectLogin() {
    const currentOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
    const currentPath = typeof window !== 'undefined' ? window.location.pathname : '/';
    const redirectUri = `${currentOrigin}${currentPath}`;
    // Random state (CSRF) + PKCE S256; both checked when the popup reports back.
    const pending = await beginAuthRequest();

    const cfg = this.uiConfig || {};
    const authEndpoint = cfg.keycloakAuthEndpoint ||
      'https://keycloak.YOUR_KEYCLOAK_IP.nip.io/realms/apigee-demo/protocol/openid-connect/auth';
    const params = new URLSearchParams({
      client_id: cfg.keycloakClientId || (this.isStaffUi ? 'biscuit-coffee-staff' : 'biscuit-coffee-agent'),
      response_type: 'code',
      scope: cfg.loginScope || (this.isStaffUi
        ? 'openid biscuit_coffee_staff biscuit_coffee_manager'
        : 'openid biscuit_coffee_customer'),
      redirect_uri: redirectUri,
      state: pending.state,
      code_challenge: pending.codeChallenge,
      code_challenge_method: 'S256',
      // Always show the Keycloak form, even with an existing SSO session.
      prompt: 'login'
    });
    const authUrl = `${authEndpoint}?${params.toString()}`;

    if (this.headerAuthBtn) {
      this.headerAuthBtn.innerHTML = `
        <svg class="spin-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
        <span>Connecting...</span>
      `;
    }
    if (this.personaAuthBtn) {
      this.personaAuthBtn.innerHTML = `
        <svg class="spin-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
        <span>Opening Keycloak...</span>
      `;
    }

    try {
      const authResponseUrl = await this.openOAuthPopup(authUrl);
      const { code, codeVerifier } = completeAuthRequest(authResponseUrl, pending);

      await this.agentClient.exchangeAuthCode(code, redirectUri, codeVerifier);
      await this.refreshAuthUI();
      this.resumeOrderWatchers();

      this.addSystemNotice(`✅ Successfully signed in to Keycloak as **${this.currentRole.name}** (\`${this.currentRole.email}\`).`);
    } catch (err) {
      console.error('Direct Keycloak login error:', err);
      if (!this.agentClient.lastGateMessage) {
        this.addSystemNotice(`⚠️ Keycloak sign-in notice: ${err.message || err}`);
      }
      await this.refreshAuthUI();
    }
  }

  async triggerLogout() {
    if (this.headerAuthBtn) {
      this.headerAuthBtn.innerHTML = `
        <svg class="spin-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
        <span>Logging out...</span>
      `;
    }
    if (this.personaAuthBtn) {
      this.personaAuthBtn.innerHTML = `
        <svg class="spin-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
        <span>Revoking...</span>
      `;
    }

    try {
      const prevName = this.currentRole.name;
      const prevEmail = this.currentRole.email;
      this.pauseOrderWatchers();
      await this.agentClient.logoutKeycloak();
      this.currentRole = this.signedOutPersona;

      const noticeWho = prevName && prevName !== 'Not Logged In' && prevName !== 'Not signed in' ? ` for **${prevName}** (\`${prevEmail}\`)` : '';
      this.addSystemNotice(`🚪 Logged out from Keycloak. Session and tokens${noticeWho} have been revoked.`);
    } catch (err) {
      console.warn('Logout notice:', err);
    } finally {
      await this.refreshAuthUI();
      this.resumeOrderWatchers();
    }
  }
}

// Bootstrap on DOM ready
async function loadUiConfig() {
  try {
    const res = await fetch('/api/ui-config', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cfg = await res.json();
    if (cfg && (cfg.variant === 'staff' || cfg.variant === 'customer')) return cfg;
  } catch (e) {
    console.warn('ui-config unavailable, defaulting to the customer app:', e.message || e);
  }
  return { variant: 'customer', appName: 'coffee_agent_prod', guestAllowed: true };
}

document.addEventListener('DOMContentLoaded', async () => {
  const uiConfig = await loadUiConfig();
  const isStaff = uiConfig.variant === 'staff';
  // Drives the data-variant-only CSS in css/staff.css.
  document.body.dataset.uiVariant = uiConfig.variant;
  if (isStaff) {
    document.title = 'Biscuit Coffee Staff Console';
    const brand = document.querySelector('.brand-title span');
    if (brand) brand.textContent = 'Biscuit Coffee Staff Console';
  }

  window.coffeeApp = new App(uiConfig);

  // Header link to the other app (customer <-> staff); hidden when unset.
  const otherLink = document.getElementById('otherAppLink');
  const otherUrl = window.coffeeApp.otherAppUrl();
  if (otherLink && otherUrl) {
    otherLink.href = otherUrl;
    const label = isStaff ? 'Customer app' : 'Staff console';
    const labelEl = document.getElementById('otherAppLinkText');
    if (labelEl) labelEl.textContent = label;
    otherLink.title = `Open the ${label} in a new tab`;
    otherLink.hidden = false;
  }
  // Settings drawer authenticates to the BFF with the signed-in user's token;
  // checkActiveToken() refreshes it first when it is close to expiry.
  new SettingsPanel(async () => {
    const t = await window.coffeeApp.agentClient.checkActiveToken();
    return t && t.active && t.access_token ? t.access_token : null;
  });

  const tourBtn = document.getElementById('headerTourBtn');
  if (isStaff) {
    // Staff console: orders board, employees, store ops (+ staff chat).
    window.staffConsole = new StaffConsole(window.coffeeApp);
    if (tourBtn) tourBtn.hidden = true;
    return;
  }

  // Interactive Guided Tour: auto-shows the chooser on first visit (or with
  // ?tour=1 / ?tour=<missionId>) and can be reopened from the header.
  window.biscuitTour = new GuidedTour(window.coffeeApp);
  if (tourBtn) tourBtn.addEventListener('click', () => window.biscuitTour.open());
});
