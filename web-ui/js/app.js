/**
 * Main Web UI Application Logic
 * Biscuit Coffee Shop - Apigee + ADK Agent Showcase
 */

import { AdkAgentClient } from './agent-client.js';

// User Personas & Scopes
export const PERSONAS = {
  customer: {
    id: 'customer',
    name: 'John Smith',
    roleName: 'Customer',
    email: 'customer@biscuit-coffee.com',
    avatar: '👤',
    scopes: ['biscuit_coffee_customer'],
    scopeDescription: 'biscuit_coffee_customer',
    badgeClass: 'customer',
    summary: 'Standard customer account. Can view menu, place orders, and check rewards.'
  },
  manager: {
    id: 'manager',
    name: 'Alice (Manager)',
    roleName: 'Store Manager',
    email: 'manager@biscuit-coffee.com',
    avatar: '👔',
    scopes: ['biscuit_coffee_customer', 'biscuit_coffee_manager'],
    scopeDescription: 'biscuit_coffee_customer, biscuit_coffee_manager',
    badgeClass: 'manager',
    summary: 'Elevated store supervisor account. Full customer capabilities plus staff & employee directory access.'
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
    icon: '🥐',
    text: "I'd like to order a Latte and a warm Biscuit",
    label: "Place an Order",
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
    category: 'security',
    icon: '🛡️',
    text: "Can you list all the store employees and their staff IDs?",
    label: "Security Test: List Employees",
    role: 'customer',
    isSecurityTest: true
  },

  // Store Manager
  {
    category: 'manager',
    icon: '👥',
    text: "List all store employees, their contact emails and shifts",
    label: "Staff Directory (200 OK)",
    role: 'manager',
    isManagerOnly: true
  },
  {
    category: 'manager_orders',
    icon: '📋',
    text: "List all orders in the store",
    label: "All Store Orders",
    role: 'manager',
    isManagerOnly: true
  }
];

class App {
  constructor() {
    this.currentRole = GUEST_PERSONA;
    this.agentClient = new AdkAgentClient({
      appName: 'coffee_agent_prod',
      userId: 'guest@biscuit-coffee.com'
    });

    this.messages = [];
    this.isProcessing = false;
    this.activeAuthCalls = new Map();
    window.biscuitApp = this;

    this.initElements();
    this.attachEventListeners();
    this.initSidebarResizer();
    this.renderRoleContext();
    this.renderSuggestedPrompts();
    this.checkBackendConnection();
    this.refreshAuthUI();
    setInterval(() => this.refreshAuthUI(), 30000);

    // Initial greeting message
    this.addWelcomeMessage();
  }

  initElements() {
    // Role switcher tabs
    this.customerTabBtn = document.getElementById('roleCustomerBtn');
    this.managerTabBtn = document.getElementById('roleManagerBtn');

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
    this.managerSpecBox = document.getElementById('managerSpecBox');

    // Role prompt containers on the left panel
    this.publicPromptsContainer = document.getElementById('publicPromptsContainer');
    this.customerPromptsContainer = document.getElementById('customerPromptsContainer');
    this.managerPromptsContainer = document.getElementById('managerPromptsContainer');
    this.promptChipsContainer = document.getElementById('promptChipsContainer');
    this.messagesArea = document.getElementById('messagesArea');
    this.chatForm = document.getElementById('chatForm');
    this.chatInput = document.getElementById('chatInput');
    this.sendBtn = document.getElementById('sendBtn');
    this.clearChatBtn = document.getElementById('clearChatBtn');
    this.headerClearChatBtn = document.getElementById('headerClearChatBtn');
    this.statusDot = document.getElementById('statusDot');
    this.statusText = document.getElementById('statusText');
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

    // Dev-UI Toggle
    this.modeLiveBtn = document.getElementById('modeLiveBtn');
    this.modeDevUiBtn = document.getElementById('modeDevUiBtn');
    this.iframeContainer = document.getElementById('iframeContainer');
    this.chatLayoutArea = document.getElementById('chatLayoutArea');

    // Theme Toggle
    this.themeToggleBtn = document.getElementById('themeToggleBtn');
    this.themeIconSun = document.getElementById('themeIconSun');
    this.themeIconMoon = document.getElementById('themeIconMoon');
  }

  attachEventListeners() {
    // Role switching (if switcher tabs are present)
    if (this.customerTabBtn) {
      this.customerTabBtn.addEventListener('click', () => this.switchRole(PERSONAS.customer));
    }
    if (this.managerTabBtn) {
      this.managerTabBtn.addEventListener('click', () => this.switchRole(PERSONAS.manager));
    }

    // Keycloak Auth Buttons (Header & Persona Sidebar)
    if (this.headerAuthBtn) {
      this.headerAuthBtn.addEventListener('click', () => this.handleAuthBtnClick());
    }
    if (this.personaAuthBtn) {
      this.personaAuthBtn.addEventListener('click', () => this.handleAuthBtnClick());
    }

    // Theme switching
    if (this.themeToggleBtn) {
      this.themeToggleBtn.addEventListener('click', () => this.toggleTheme());
    }

    // Chat form submit
    this.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleUserSubmit();
    });

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

    // Mode Selection (if buttons exist)
    if (this.modeLiveBtn) {
      this.modeLiveBtn.addEventListener('click', () => this.setMode('auto'));
    }
    if (this.modeDevUiBtn) {
      this.modeDevUiBtn.addEventListener('click', () => this.toggleDevUiIframe());
    }

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
    const html = document.documentElement;
    const currentTheme = html.getAttribute('data-theme') || 'light';
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    html.setAttribute('data-theme', newTheme);

    if (newTheme === 'dark') {
      this.themeIconSun.style.display = 'none';
      this.themeIconMoon.style.display = 'block';
    } else {
      this.themeIconSun.style.display = 'block';
      this.themeIconMoon.style.display = 'none';
    }
  }

  async checkBackendConnection() {
    const status = await this.agentClient.checkLiveHealth();
    if (this.statusDot && this.statusText) {
      if (status.available) {
        this.statusDot.className = 'status-dot';
        this.statusText.textContent = `ADK Web Live (Port 8000)`;
      } else {
        this.statusDot.className = 'status-dot simulated';
        this.statusText.textContent = '';
      }
    }
  }

  setMode(mode) {
    this.agentClient.setMode(mode);
    if (this.modeLiveBtn) this.modeLiveBtn.classList.toggle('active', mode === 'auto');
    if (this.modeDevUiBtn) this.modeDevUiBtn.classList.remove('active');
    if (this.iframeContainer) this.iframeContainer.classList.remove('active');
    if (this.chatLayoutArea) this.chatLayoutArea.style.display = 'flex';
  }

  toggleDevUiIframe() {
    if (!this.iframeContainer) return;
    const isActive = this.iframeContainer.classList.toggle('active');
    if (this.modeDevUiBtn) this.modeDevUiBtn.classList.toggle('active', isActive);
    if (isActive) {
      if (this.modeLiveBtn) this.modeLiveBtn.classList.remove('active');
      if (this.chatLayoutArea) this.chatLayoutArea.style.display = 'none';
    } else {
      if (this.chatLayoutArea) this.chatLayoutArea.style.display = 'flex';
      this.setMode('auto');
    }
  }

  async switchRole(persona) {
    if (this.currentRole.id === persona.id) return;
    this.currentRole = persona;
    this.agentClient.setRole(persona);

    this.renderRoleContext();
    this.renderSuggestedPrompts();
    await this.refreshAuthUI();

    const activeToken = await this.agentClient.checkActiveToken(persona.email);
    const statusNote = activeToken && activeToken.active ? 'Token **Active**' : '**Not Logged In**';

    // Notify user in chat
    this.addSystemNotice(`Switched target persona to **${persona.name}** (\`${persona.email}\`) with scope **${persona.scopeDescription}** — ${statusNote}.`);
  }

  renderRoleContext() {
    const isGuest = this.currentRole.id === 'guest';
    const isCustomer = this.currentRole.id === 'customer';
    const isManager = this.currentRole.id === 'manager';

    // Tabs (if present)
    if (this.customerTabBtn) this.customerTabBtn.classList.toggle('active', isCustomer);
    if (this.managerTabBtn) this.managerTabBtn.classList.toggle('active', isManager);

    // Persona Card
    if (isGuest) {
      this.personaCard.className = 'current-persona-card unauthenticated';
      this.personaAvatar.textContent = '🔒';
      this.personaName.textContent = 'Not Logged In';
      this.personaEmail.textContent = 'No active Keycloak session';
      this.personaScopeTag.textContent = '🔑 Scopes: None (Unauthenticated)';
    } else {
      this.personaCard.className = `current-persona-card ${isCustomer ? 'customer-active' : 'manager-active'}`;
      this.personaAvatar.textContent = this.currentRole.avatar;
      this.personaName.textContent = this.currentRole.name;
      this.personaEmail.textContent = this.currentRole.email;
      this.personaScopeTag.textContent = `🔑 Scopes: ${this.currentRole.scopeDescription}`;
    }

    // Highlight spec boxes
    if (this.publicSpecBox) this.publicSpecBox.classList.toggle('highlight', isGuest);
    if (this.customerSpecBox) this.customerSpecBox.classList.toggle('highlight', isCustomer);
    if (this.managerSpecBox) this.managerSpecBox.classList.toggle('highlight', isManager);

    // Scope footer note
    if (this.scopeFooterText) {
      this.scopeFooterText.textContent = isGuest
        ? 'Active Scope: None (Unauthenticated) • Public Tools Only'
        : `Active Scope: ${this.currentRole.scopeDescription} • Apigee Proxy Auth`;
    }
  }

  renderSuggestedPrompts() {
    if (this.publicPromptsContainer) this.publicPromptsContainer.innerHTML = '';
    if (this.customerPromptsContainer) this.customerPromptsContainer.innerHTML = '';
    if (this.managerPromptsContainer) this.managerPromptsContainer.innerHTML = '';
    if (this.promptChipsContainer) this.promptChipsContainer.innerHTML = '';

    SUGGESTED_PROMPTS.forEach(item => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'spec-prompt-chip';

      if (item.isSecurityTest) {
        chip.classList.add('security-test');
      } else if (item.isManagerOnly) {
        chip.classList.add('manager-only');
      }

      chip.innerHTML = `<span>${item.icon}</span> <span>${item.label}</span>`;
      chip.title = item.text;

      chip.addEventListener('click', () => {
        this.chatInput.value = item.text;
        this.chatInput.focus();
      });

      if (item.role === 'public' && this.publicPromptsContainer) {
        this.publicPromptsContainer.appendChild(chip);
      } else if (item.role === 'customer' && this.customerPromptsContainer) {
        this.customerPromptsContainer.appendChild(chip);
      } else if (item.role === 'manager' && this.managerPromptsContainer) {
        this.managerPromptsContainer.appendChild(chip);
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
    } else {
      authNote = `You are currently **not logged in**.\n\nYou can explore our public menu and store hours anonymously, or click the **Login** button to sign in with your customer or store manager credentials.`;
    }

    const initialText = `☕ **Welcome to Biscuit Coffee!** I'm your AI barista assistant, built with the Google Agent Development Kit (ADK) and secured by **Apigee X** and **Keycloak OAuth 2.0**.\n\n${authNote}\n\nFeel free to explore our menu, place an order, or test Apigee security policies using the suggested prompts on the left panel!`;
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

  async handleUserSubmit() {
    const text = this.chatInput.value.trim();
    if (!text || this.isProcessing) return;

    this.chatInput.value = '';
    this.chatInput.focus();
    this.isProcessing = true;
    this.sendBtn.disabled = true;

    // 1. Append User Message
    this.appendMessage('user', text);

    // 2. Show Typing Indicator
    const typingElement = this.showTypingIndicator();

    try {
      // 3. Call Agent (Live ADK or Grounded Simulator)
      const response = await this.agentClient.sendMessage(text, this.currentRole);

      // Remove typing indicator
      typingElement.remove();

      // 4. Append Agent Message
      this.appendMessage('agent', response.text, response.toolCall, response.liveError);
    } catch (err) {
      typingElement.remove();
      this.appendMessage('agent', `⚠️ An error occurred while communicating with the agent: ${err.message}`);
    } finally {
      this.isProcessing = false;
      this.sendBtn.disabled = false;
    }
  }

  appendMessage(sender, text, toolCall = null, note = null) {
    const row = document.createElement('div');
    row.className = `message-row ${sender}`;

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let avatarSymbol = sender === 'agent' ? '☕' : this.currentRole.avatar;
    let senderName = sender === 'agent' ? 'Biscuit Coffee Agent' : this.currentRole.name;

    let toolCallHtml = '';
    if (toolCall) {
      const isSuccess = toolCall.success;
      let statusClass = isSuccess ? 'success' : 'forbidden';
      let statusText = isSuccess ? toolCall.status : `${toolCall.status} (Scope Blocked)`;

      let authActionHtml = '';
      if (toolCall.isAuth) {
        statusClass = 'auth-required';
        statusText = 'Login Required';
        const toolCallId = toolCall.id || ('auth_' + Math.random().toString(36).substring(2, 9));
        this.activeAuthCalls.set(toolCallId, toolCall);

        authActionHtml = `
          <div class="tool-login-action-container">
            <button type="button" class="tool-login-action-btn" id="loginBtn_${toolCallId}" onclick="window.biscuitApp.handleOAuthLogin('${toolCallId}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
              <span>Login</span>
            </button>
          </div>
        `;
      } else if (toolCall.needsManagerAuth || !toolCall.success || toolCall.status.includes('403')) {
        const isGuest = !this.currentRole || this.currentRole.id === 'guest';
        if (isGuest) {
          authActionHtml = `
            <div class="tool-login-action-container">
              <button type="button" class="tool-login-action-btn" onclick="window.biscuitApp.triggerDirectLogin()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
                <span>Login</span>
              </button>
            </div>
          `;
        }
      }

      toolCallHtml = `
        <div class="tool-execution-card">
          <div class="tool-card-header">
            <div class="tool-name-badge">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
              <span>${toolCall.name}</span>
            </div>
            <span class="tool-status-tag ${statusClass}">${statusText}</span>
          </div>
          <div class="tool-details-content">
            <div><strong>Apigee Flow:</strong> <code>${toolCall.endpoint}</code></div>
            <div><strong>Policy Executed:</strong> <code>${toolCall.policy}</code></div>
            <div><strong>Required Scope:</strong> <code>${toolCall.scopeRequired}</code></div>
            ${toolCall.error ? `<div style="color: var(--danger)"><strong>Security Result:</strong> ${toolCall.error}</div>` : ''}
            ${authActionHtml}
          </div>
        </div>
      `;
    }

    let inlineLoginHtml = '';
    const isGuest = !this.currentRole || this.currentRole.id === 'guest';
    if (sender === 'agent' && isGuest && (!toolCall || (!toolCall.isAuth && !toolCall.needsManagerAuth && toolCall.success))) {
      const textLower = (text || '').toLowerCase();
      const mentionsLogin = textLower.includes('login') ||
                            textLower.includes('sign in') ||
                            textLower.includes('authenticate with keycloak') ||
                            textLower.includes('requires authentication');

      if (mentionsLogin) {
        inlineLoginHtml = `
          <div class="tool-login-action-container" style="margin-top: 10px;">
            <button type="button" class="tool-login-action-btn" onclick="window.biscuitApp.triggerDirectLogin()">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
              <span>Login</span>
            </button>
          </div>
        `;
      }
    }

    let noteHtml = '';
    if (note) {
      noteHtml = `<div style="font-size: 11px; color: var(--warning); margin-top: 4px;">ℹ️ ${note}</div>`;
    }

    row.innerHTML = `
      <div class="msg-avatar">${avatarSymbol}</div>
      <div class="msg-body-wrapper">
        <div class="msg-meta">
          <span>${senderName}</span>
          <span>•</span>
          <span>${timeStr}</span>
        </div>
        <div class="msg-bubble">
          ${this.formatMarkdown(text)}
          ${toolCallHtml}
          ${inlineLoginHtml}
          ${noteHtml}
        </div>
      </div>
    `;

    this.messagesArea.appendChild(row);
    this.scrollToBottom();
  }

  async handleOAuthLogin(toolCallId) {
    const toolCall = this.activeAuthCalls.get(toolCallId);
    if (!toolCall || !toolCall.authUri) {
      console.error('No authUri found for tool call:', toolCallId);
      return;
    }

    const btn = document.getElementById(`loginBtn_${toolCallId}`);
    if (btn) {
      btn.classList.add('logging-in');
      btn.innerHTML = `
        <svg class="spin-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
        <span>Waiting for Keycloak Sign-in...</span>
      `;
    }

    try {
      // 1. Open Keycloak 3-legged OAuth popup
      const authResponseUrl = await this.openOAuthPopup(toolCall.authUri);

      // 2. Update button status to authenticated
      if (btn) {
        btn.classList.remove('logging-in');
        btn.classList.add('authenticated');
        btn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
          <span>Authenticated! Resuming Agent...</span>
        `;
      }

      // 3. Show typing indicator
      const typingElement = this.showTypingIndicator();

      // 4. Send token authorization code response to ADK
      const result = await this.agentClient.sendOAuthResponse(
        toolCall.rawFunctionCall,
        authResponseUrl,
        toolCall.redirectUri
      );

      // 5. Remove typing indicator
      typingElement.remove();

      // 6. Append agent's real response
      this.appendMessage('agent', result.text, result.toolCall, result.liveError);

      // 7. Refresh Auth UI to show active token
      await this.refreshAuthUI();
    } catch (err) {
      console.error('Keycloak OAuth login failed:', err);
      if (btn) {
        btn.classList.remove('logging-in');
        btn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
          <span>Retry Login</span>
        `;
      }
      this.appendMessage('agent', `⚠️ OAuth notice: ${err.message || err}`);
    }
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
        reject(new Error('Popup window was blocked by browser. Please allow popups for localhost.'));
        return;
      }

      const messageListener = (event) => {
        if (event.origin !== window.location.origin) return;
        const data = event.data;
        if (data && data.authResponseUrl) {
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
    let html = raw
      // HTML escaping
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Markdown links [text](url)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
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

    return html;
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

  openModal() {
    if (!this.archModal) return;
    if (this.archMinimizedDock) {
      this.archMinimizedDock.style.display = 'none';
    }
    this.archModal.classList.add('active');
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
      const activeToken = await this.agentClient.checkActiveToken();

      if (activeToken && activeToken.active) {
        const remainingMs = Math.max(0, (activeToken.expiresAt || 0) - Date.now());
        const remainingMins = Math.max(1, Math.round(remainingMs / 60000));
        const email = activeToken.userinfo?.email || activeToken.claims?.email || activeToken.claims?.preferred_username || this.agentClient.userId || 'customer@biscuit-coffee.com';
        let name = activeToken.userinfo?.name || activeToken.claims?.name || activeToken.claims?.preferred_username;
        if (!name || name === email) {
          name = email.includes('manager') ? 'Alice (Manager)' : 'John Smith';
        }

        const tokenScope = activeToken.scope || activeToken.claims?.scope || '';
        const realmRoles = activeToken.claims?.realm_access?.roles || [];

        // Dynamically assign active persona based on authenticated token scopes/claims
        const isManager = tokenScope.includes('biscuit_coffee_manager') ||
                          email.includes('manager') ||
                          realmRoles.includes('biscuit_coffee_manager');

        // Extract individual scopes list
        let scopesList = [];
        if (tokenScope) {
          scopesList = tokenScope.split(' ').filter(s => s && s !== 'openid' && s !== 'profile' && s !== 'email');
        }
        if (scopesList.length === 0) {
          scopesList = isManager ? ['biscuit_coffee_customer', 'biscuit_coffee_manager'] : ['biscuit_coffee_customer'];
        }
        const scopeDescription = scopesList.join(', ');

        if (isManager) {
          this.currentRole = {
            ...PERSONAS.manager,
            name: name,
            email: email,
            scopes: scopesList,
            scopeDescription: scopeDescription
          };
        } else {
          this.currentRole = {
            ...PERSONAS.customer,
            name: name,
            email: email,
            scopes: scopesList,
            scopeDescription: scopeDescription
          };
        }

        this.agentClient.userId = email;
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
        this.currentRole = GUEST_PERSONA;
        if (!this.agentClient.userId || !this.agentClient.userId.startsWith('guest')) {
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
  }

  async handleAuthBtnClick() {
    const activeToken = await this.agentClient.checkActiveToken();
    if (activeToken && activeToken.active) {
      await this.triggerLogout();
    } else {
      await this.triggerDirectLogin();
    }
  }

  async triggerDirectLogin() {
    const currentOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
    const currentPath = typeof window !== 'undefined' ? window.location.pathname : '/';
    const redirectUri = `${currentOrigin}${currentPath}`;
    const state = 'state_' + Math.random().toString(36).substring(2, 12);

    const authEndpoint = 'https://keycloak.YOUR_KEYCLOAK_IP.nip.io/realms/apigee-demo/protocol/openid-connect/auth';
    const params = new URLSearchParams({
      client_id: 'biscuit-coffee-agent',
      response_type: 'code',
      scope: 'openid biscuit_coffee_customer biscuit_coffee_manager',
      redirect_uri: redirectUri,
      state: state,
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
      const u = new URL(authResponseUrl);
      const code = u.searchParams.get('code');
      if (!code) {
        throw new Error('Keycloak completed without providing an authorization code.');
      }

      await this.agentClient.exchangeAuthCode(code, redirectUri);
      await this.refreshAuthUI();

      this.addSystemNotice(`✅ Successfully signed in to Keycloak as **${this.currentRole.name}** (\`${this.currentRole.email}\`).`);
    } catch (err) {
      console.error('Direct Keycloak login error:', err);
      this.addSystemNotice(`⚠️ Keycloak sign-in notice: ${err.message || err}`);
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
      await this.agentClient.logoutKeycloak();
      this.currentRole = GUEST_PERSONA;

      const noticeWho = prevName && prevName !== 'Not Logged In' ? ` for **${prevName}** (\`${prevEmail}\`)` : '';
      this.addSystemNotice(`🚪 Logged out from Keycloak. Session and tokens${noticeWho} have been revoked.`);
    } catch (err) {
      console.warn('Logout notice:', err);
    } finally {
      await this.refreshAuthUI();
    }
  }
}

// Bootstrap on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.coffeeApp = new App();
});
