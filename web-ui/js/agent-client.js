/**
 * ADK Web Agent Client
 * Manages communication with the live Google ADK Web backend (default: http://localhost:8000),
 * session handling, and graceful fallback to offline simulator.
 */

import { simulateAgentResponse } from './mock-agent.js';

export class AdkAgentClient {
  /** Display name for demo accounts whose token carries no name claim. */
  static fallbackName(email) {
    const e = String(email || '');
    if (e.includes('manager')) return 'Alice (Manager)';
    if (e.startsWith('staff')) return 'Sam Barista';
    if (e.includes('customer2')) return 'Michael Bosh';
    if (e.includes('customer')) return 'John Smith';
    return e;
  }

  generateGuestId() {
    return 'guest_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  }

  constructor(config = {}) {
    // If served from server.py (or any HTTP/HTTPS host), baseUrl defaults to relative '' which proxies to ADK
    const defaultHost = (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) ? '' : 'http://localhost:8000';
    this.baseUrl = config.baseUrl !== undefined ? config.baseUrl : defaultHost;
    this.appName = config.appName || 'coffee_agent_prod';
    this.userId = config.userId || this.generateGuestId();
    this.sessionId = null;
    this.sessionUserId = null;
    this.isLiveAvailable = false;
    this.mode = 'auto'; // 'auto', 'live', or 'simulate'
  }

  setRole(role) {
    this.userId = role.email;
    this.sessionId = null; // Reset session for new persona
    this.sessionUserId = null;
  }

  setMode(mode) {
    this.mode = mode;
  }

  /**
   * Reads whatever is in storage without judging it.
   *
   * Kept separate from getStoredToken because the refresh path still needs the
   * record after the access token has expired - that is precisely when it has
   * work to do.
   */
  readStoredTokenRaw(userId = null) {
    try {
      const effectiveUser = userId || this.userId;
      if (!effectiveUser || effectiveUser.startsWith('guest') || effectiveUser.includes('guest@')) {
        return null; // Guests never have stored tokens
      }

      let raw = null;
      if (effectiveUser) {
        raw = localStorage.getItem(`biscuit_auth_${effectiveUser}`);
      }
      if (!raw) {
        raw = localStorage.getItem('biscuit_auth_active_session');
      }
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data.access_token || !data.expiresAt) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  /** True when the access token has expired or is about to. */
  isExpiringSoon(data, skewMs = 60000) {
    return !!(data && data.expiresAt) && (data.expiresAt - Date.now()) <= skewMs;
  }

  getStoredToken(userId = null) {
    const data = this.readStoredTokenRaw(userId);
    if (!data) return null;
    if (data.expiresAt <= Date.now()) {
      // Only discard the record outright when nothing could revive it. Clearing
      // unconditionally used to throw away the refresh token as well, which is
      // why an idle demo had to log in again every 5 minutes.
      if (!data.refresh_token) this.clearStoredToken(userId);
      return null;
    }
    return data;
  }

  saveStoredToken(userId, tokenData) {
    try {
      if (userId) {
        localStorage.setItem(`biscuit_auth_${userId}`, JSON.stringify(tokenData));
      }
      localStorage.setItem('biscuit_auth_active_session', JSON.stringify(tokenData));
    } catch (e) {
      console.warn('Could not save token to localStorage:', e);
    }
  }

  clearStoredToken(userId = null) {
    try {
      if (userId) localStorage.removeItem(`biscuit_auth_${userId}`);
      localStorage.removeItem('biscuit_auth_active_session');
      localStorage.removeItem('biscuit_auth_customer@biscuit-coffee.com');
      localStorage.removeItem('biscuit_auth_customer2@biscuit-coffee.com');
      localStorage.removeItem('biscuit_auth_manager@biscuit-coffee.com');
      if (this.userId) localStorage.removeItem(`biscuit_auth_${this.userId}`);
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith('biscuit_auth_')) {
          localStorage.removeItem(key);
        }
      }
    } catch (e) {}
  }

  async checkActiveToken(userId = null) {
    let tokenData = this.getStoredToken(userId);

    // Renew ahead of expiry - and recover just after it - using the refresh
    // token. app.js calls this every 30s, so with a 5 minute access token the
    // renewal always lands long before anything breaks. Without this the demo
    // silently logs itself out after five idle minutes.
    const raw = this.readStoredTokenRaw(userId);
    if (raw && (!tokenData || this.isExpiringSoon(raw))) {
      const refreshed = await this.refreshAccessToken(userId);
      if (refreshed) tokenData = refreshed;
    }

    if (!tokenData) return null;

    // 1. Check expiration based on stored expiresAt
    if (tokenData.expiresAt && tokenData.expiresAt <= Date.now()) {
      this.clearStoredToken(userId);
      return null;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${this.baseUrl}/api/oauth/userinfo`, {
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const userinfo = await res.json();
        return {
          ...tokenData,
          userinfo: { ...tokenData.userinfo, ...userinfo },
          active: true
        };
      } else if (res.status === 401) {
        // Token explicitly revoked or expired upstream
        this.clearStoredToken(userId);
        return null;
      } else if (res.status === 403) {
        // The BFF's role gate refused this user for this app variant (e.g. a
        // store manager in the customer app). Drop the token; app.js shows why.
        const body = await res.json().catch(() => ({}));
        if (body && body.error === 'role_not_allowed') {
          this.lastGateMessage = body.message || 'This account cannot use this app.';
          this.clearStoredToken(userId);
          return null;
        }
      }
      // Other non-401 statuses: do NOT wipe a valid unexpired local token
    } catch (e) {
      // Offline fallback: keep token active if unexpired
    }

    return {
      ...tokenData,
      active: true
    };
  }

  /**
   * Turns a raw Keycloak token response into the record the UI stores.
   *
   * Shared by the initial authorization_code exchange and by refresh, so the
   * two can never drift apart in how they read claims, scopes or the display
   * name.
   */
  buildTokenData(tokens, previous = null) {
    const expiresAt = Date.now() + ((tokens.expires_in || 300) * 1000);

    // Parse JWT claims safely
    let claims = {};
    try {
      const payloadBase64 = tokens.access_token.split('.')[1];
      claims = JSON.parse(atob(payloadBase64.replace(/-/g, '+').replace(/_/g, '/')));
    } catch (e) {}

    let idClaims = {};
    if (tokens.id_token) {
      try {
        const idPayloadBase64 = tokens.id_token.split('.')[1];
        idClaims = JSON.parse(atob(idPayloadBase64.replace(/-/g, '+').replace(/_/g, '/')));
      } catch (e) {}
    }

    const targetEmail = claims.email || idClaims.email || claims.preferred_username || idClaims.preferred_username || previous?.userinfo?.email || 'customer@biscuit-coffee.com';
    let targetName = claims.name || idClaims.name || claims.preferred_username || idClaims.preferred_username || targetEmail;
    if (targetName === targetEmail) targetName = AdkAgentClient.fallbackName(targetEmail);

    // Determine scopes from tokens.scope, claims.scope, or realm_access roles
    let tokenScopes = tokens.scope || claims.scope || '';
    const realmRoles = claims.realm_access?.roles || [];
    if (!tokenScopes) {
      if (realmRoles.includes('biscuit_coffee_manager') || realmRoles.includes('manager')) {
        tokenScopes = 'biscuit_coffee_staff biscuit_coffee_manager';
      } else if (realmRoles.includes('staff')) {
        tokenScopes = 'biscuit_coffee_staff';
      } else {
        tokenScopes = 'biscuit_coffee_customer';
      }
    }

    return {
      access_token: tokens.access_token,
      id_token: tokens.id_token || previous?.id_token,
      // Keycloak normally rotates the refresh token; keep the old one if not.
      refresh_token: tokens.refresh_token || previous?.refresh_token,
      token_type: tokens.token_type || 'Bearer',
      scope: tokenScopes,
      expiresAt: expiresAt,
      claims: claims,
      userinfo: {
        email: targetEmail,
        preferred_username: claims.preferred_username || idClaims.preferred_username || targetEmail,
        name: targetName
      }
    };
  }

  async exchangeAuthCode(code, redirectUri) {
    const res = await fetch(`${this.baseUrl}/api/oauth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirect_uri: redirectUri })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (err && err.error === 'role_not_allowed') this.lastGateMessage = err.message;
      throw new Error(err.message || err.error_description || err.error || `Keycloak token exchange failed (HTTP ${res.status})`);
    }

    const tokens = await res.json();
    const tokenData = this.buildTokenData(tokens);

    this.userId = tokenData.userinfo.email;
    this.saveStoredToken(this.userId, tokenData);

    // Trigger instant UI refresh across the app
    if (typeof window !== 'undefined' && window.biscuitApp && typeof window.biscuitApp.refreshAuthUI === 'function') {
      window.biscuitApp.refreshAuthUI().catch(() => {});
    }

    return tokenData;
  }

  /**
   * Trades the refresh token for a new access token.
   *
   * Returns the new record, or null when the session is genuinely over (the
   * refresh token has passed its own 30 minute idle timeout, or was revoked by
   * a logout) - only then is the stored record discarded.
   */
  async refreshAccessToken(userId = null) {
    const stored = this.readStoredTokenRaw(userId);
    if (!stored || !stored.refresh_token) return null;

    // The 30s UI poll and an in-flight send can both land here at once.
    // Verified against this realm: reuse is permitted (Revoke Refresh Token is
    // off), so a duplicate would not fail - but it would waste a round trip and
    // race two writes to localStorage, leaving the older token stored last.
    if (this._refreshInFlight) return this._refreshInFlight;

    this._refreshInFlight = (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/api/oauth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: stored.refresh_token })
        });

        if (!res.ok) {
          if (res.status === 403) {
            const err = await res.json().catch(() => ({}));
            if (err && err.error === 'role_not_allowed') this.lastGateMessage = err.message;
          }
          this.clearStoredToken(userId);
          return null;
        }

        const tokens = await res.json();
        if (!tokens.access_token) {
          this.clearStoredToken(userId);
          return null;
        }

        const tokenData = this.buildTokenData(tokens, stored);
        this.userId = tokenData.userinfo.email;
        this.saveStoredToken(this.userId, tokenData);
        return tokenData;
      } catch (e) {
        // A transport failure is not proof the session ended, so leave the
        // stored record alone and let the next attempt try again.
        console.warn('Token refresh failed:', e);
        return null;
      } finally {
        this._refreshInFlight = null;
      }
    })();

    return this._refreshInFlight;
  }

  /**
   * Returns a usable token, renewing it first if it is expired or nearly so.
   */
  async ensureFreshToken(userId = null) {
    const stored = this.readStoredTokenRaw(userId);
    if (!stored) return null;
    if (!this.isExpiringSoon(stored)) return stored;
    const refreshed = await this.refreshAccessToken(userId);
    return refreshed || this.getStoredToken(userId);
  }

  async logoutKeycloak(userId = null) {
    // Raw read: the access token may already have expired, but the refresh
    // token is what Keycloak needs in order to actually kill the session.
    const tokenData = this.readStoredTokenRaw(userId);
    const refreshToken = tokenData?.refresh_token;

    // 1. Call server logout to revoke Keycloak session and flush ADK cache
    try {
      await fetch(`${this.baseUrl}/api/oauth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken })
      });
    } catch (e) {
      console.warn('Failed to call server logout:', e);
    }

    // 2. Clear stored tokens
    this.clearStoredToken(userId);

    // 3. Delete ADK session on server if exists
    if (this.sessionId && this.userId) {
      try {
        await fetch(`${this.baseUrl}/apps/${this.appName}/users/${encodeURIComponent(this.userId)}/sessions/${this.sessionId}`, {
          method: 'DELETE'
        });
      } catch (e) {}
    }

    this.sessionId = null;
    this.sessionUserId = null;
    this.userId = this.generateGuestId();
    return { success: true };
  }

  async checkLiveHealth() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1800);
      const res = await fetch(`${this.baseUrl}/list-apps`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const apps = await res.json();
        this.isLiveAvailable = true;
        return { available: true, apps };
      }
    } catch (e) {
      // Offline or network error
    }
    this.isLiveAvailable = false;
    return { available: false, apps: [] };
  }

  async ensureSession(forceNew = false) {
    if (!forceNew && this.sessionId && this.sessionUserId === this.userId) {
      return this.sessionId;
    }

    if (this.sessionUserId && this.sessionUserId !== this.userId) {
      this.sessionId = null;
    }

    try {
      const res = await fetch(`${this.baseUrl}/apps/${this.appName}/users/${encodeURIComponent(this.userId)}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      if (res.ok) {
        const session = await res.json();
        this.sessionId = session.id || session.session_id;
        this.sessionUserId = this.userId;
        return this.sessionId;
      }
    } catch (e) {
      console.warn('Could not create remote ADK session:', e);
    }

    // Fallback local session ID
    this.sessionId = 'local-sess-' + Date.now();
    this.sessionUserId = this.userId;
    return this.sessionId;
  }

  /**
   * Sends one user turn to the agent.
   * @param {object} [handlers] optional streaming callbacks:
   *   onDelta(textChunk) - reply text as Gemini generates it
   *   onToolCall(name)   - the agent is calling an Apigee tool
   * The resolved value is the same {text, toolCall} shape as before, built from
   * the complete (non-partial) events, so tool cards and the tour are unchanged.
   */
  async sendMessage(text, currentRole, handlers = null) {
    // If user explicitly forces simulation or live backend is unreachable
    if (this.mode === 'simulate') {
      return await simulateAgentResponse(text, currentRole);
    }

    if (this.mode === 'auto') {
      const health = await this.checkLiveHealth();
      if (!health.available) {
        return await simulateAgentResponse(text, currentRole);
      }
    }

    // Live mode attempt
    try {
      await this.ensureSession();

      const isGuest = !this.userId || this.userId.startsWith('guest') || this.userId.includes('guest@');
      // Renew here too: the 30s poll could be up to 30s stale, and this token
      // is about to be handed to the agent for a call through Apigee.
      const activeToken = isGuest ? null : await this.ensureFreshToken(this.userId);
      const userEmail = isGuest ? this.userId : (activeToken?.userinfo?.email || this.userId);
      const userName = isGuest ? '' : (activeToken?.userinfo?.name || AdkAgentClient.fallbackName(userEmail));

      const runPayload = {
        appName: this.appName,
        userId: this.userId,
        sessionId: this.sessionId,
        state_delta: {
          user_email: userEmail,
          user_name: userName,
          is_authenticated: !isGuest,
          active_scope: isGuest ? '' : (activeToken?.scope || ''),
          access_token: isGuest ? '' : (activeToken?.access_token || '')
        },
        newMessage: {
          role: 'user',
          parts: [{ text: text }]
        }
      };

      let run = await this.postRun(runPayload, handlers);

      if (!run.ok && run.status === 404 && run.errDetail.includes('Session not found')) {
        console.warn('Session not found on ADK server, auto-creating a new session and retrying...');
        this.sessionId = null;
        this.sessionUserId = null;
        await this.ensureSession(true);
        runPayload.sessionId = this.sessionId;
        runPayload.userId = this.userId;
        run = await this.postRun(runPayload, handlers);
      }

      if (!run.ok) {
        console.error(`ADK Server responded with HTTP ${run.status}:`, run.errDetail);
        throw new Error(`ADK Server responded with HTTP ${run.status}: ${run.errDetail}`);
      }

      let parsed = this.parseAdkEvents(run.events);
      if (run.streamedText && parsed.text === 'Response completed by ADK agent.') {
        parsed.text = run.streamedText; // stream ended without an aggregated text event
      }

      // If ADK requested credentials and the user is already authenticated with Keycloak,
      // seamlessly auto-fulfill the request with the active access token without prompting again.
      if (parsed.toolCall && parsed.toolCall.isAuth) {
        const storedToken = this.getStoredToken(this.userId);
        if (storedToken && storedToken.access_token && (!storedToken.expiresAt || storedToken.expiresAt > Date.now())) {
          console.log('Auto-fulfilling adk_request_credential using active stored Keycloak token...');
          return await this.sendStoredTokenResponse(parsed.toolCall.rawFunctionCall, storedToken);
        }
      }

      return parsed;
    } catch (err) {
      console.warn('ADK live invocation error, falling back to simulator:', err);
      const simResult = await simulateAgentResponse(text, currentRole);
      simResult.liveError = `ADK Live Server notice: ${err.message} (showing simulated output)`;
      return simResult;
    }
  }

  async readError(res) {
    try {
      const errJson = await res.json();
      return typeof errJson === 'object' ? JSON.stringify(errJson) : String(errJson);
    } catch (e) {
      return await res.text().catch(() => '');
    }
  }

  /**
   * Runs one agent turn. Prefers /run_sse (streaming) when handlers are given.
   * Falls back to /run ONLY if the streaming request could not be sent at all:
   * once ADK has accepted a turn, re-sending it could execute a tool twice
   * (e.g. place the same order again).
   * Resolves to { ok, status, events, errDetail, streamedText }.
   */
  async postRun(payload, handlers) {
    const canStream = !!handlers && typeof ReadableStream !== 'undefined' && typeof TextDecoder !== 'undefined';
    if (canStream) {
      let res = null;
      try {
        res = await fetch(`${this.baseUrl}/run_sse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ ...payload, streaming: true })
        });
      } catch (e) {
        console.warn('Streaming request failed to start, falling back to /run:', e);
      }
      if (res) {
        if (!res.ok) return { ok: false, status: res.status, errDetail: await this.readError(res) };
        const { events, streamedText } = await this.readSseEvents(res, handlers);
        return { ok: true, status: res.status, events, streamedText };
      }
    }

    const res = await fetch(`${this.baseUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) return { ok: false, status: res.status, errDetail: await this.readError(res) };
    return { ok: true, status: res.status, events: await res.json() };
  }

  /**
   * Reads ADK's SSE stream. Partial events carry incremental reply text and are
   * only used for live rendering; complete events are collected and later fed
   * to parseAdkEvents() exactly as /run's JSON array would be.
   */
  async readSseEvents(res, handlers = {}) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let streamedText = '';
    let buffer = '';

    const handleBlock = (block) => {
      const data = block.split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) return;
      let ev;
      try { ev = JSON.parse(data); } catch (e) { return; }
      // ADK's event_generator reports a mid-run failure as {"error": "..."}.
      if (ev && ev.error && !ev.author && !ev.content) throw new Error(`ADK stream error: ${ev.error}`);
      const parts = ev?.content?.parts || [];
      if (ev.partial) {
        for (const p of parts) {
          if (p.text && !p.thought) {
            streamedText += p.text;
            handlers.onDelta?.(p.text);
          }
        }
        return;
      }
      events.push(ev);
      for (const p of parts) {
        const fc = p.functionCall || p.function_call;
        if (fc && fc.name && fc.name !== 'adk_request_credential') handlers.onToolCall?.(fc.name);
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        handleBlock(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleBlock(buffer);
    return { events, streamedText };
  }

  async sendStoredTokenResponse(rawFunctionCall, tokenData) {
    await this.ensureSession();

    const rawArgs = rawFunctionCall?.args || {};
    let authConfig = rawArgs.authConfig || rawArgs.auth_config || rawArgs;
    authConfig = structuredClone(authConfig);

    authConfig.exchangedAuthCredential = {
      authType: 'oauth2',
      oauth2: {
        accessToken: tokenData.access_token,
        tokenType: tokenData.token_type || 'Bearer',
        refreshToken: tokenData.refresh_token || undefined,
        idToken: tokenData.id_token || undefined
      }
    };

    const resumeSessionId = this.sessionId;
    const resumeUserId = this.sessionUserId || this.userId;

    const runPayload = {
      appName: this.appName,
      userId: resumeUserId,
      sessionId: resumeSessionId,
      newMessage: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: rawFunctionCall.id,
              name: rawFunctionCall.name,
              response: authConfig
            }
          }
        ]
      }
    };

    const res = await fetch(`${this.baseUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(runPayload)
    });

    if (!res.ok) {
      let errDetail = '';
      try {
        const errJson = await res.json();
        errDetail = typeof errJson === 'object' ? JSON.stringify(errJson) : String(errJson);
      } catch (e) {
        errDetail = await res.text().catch(() => '');
      }
      console.error(`ADK Server responded with HTTP ${res.status}:`, errDetail);
      throw new Error(`ADK Server responded with HTTP ${res.status}: ${errDetail}`);
    }

    const events = await res.json();
    return this.parseAdkEvents(events);
  }

  async sendOAuthResponse(rawFunctionCall, authResponseUrl, redirectUri) {
    await this.ensureSession();

    const rawArgs = rawFunctionCall?.args || {};
    let authConfig = rawArgs.authConfig || rawArgs.auth_config || rawArgs;
    authConfig = structuredClone(authConfig);

    if (!authConfig.exchangedAuthCredential) {
      authConfig.exchangedAuthCredential = {};
    }
    if (!authConfig.exchangedAuthCredential.oauth2) {
      authConfig.exchangedAuthCredential.oauth2 = {};
    }
    authConfig.exchangedAuthCredential.authType = 'oauth2';
    authConfig.exchangedAuthCredential.oauth2.authResponseUri = authResponseUrl;
    authConfig.exchangedAuthCredential.oauth2.redirectUri = redirectUri;

    // Cache the token locally so the UI updates to Logged In state
    try {
      const u = new URL(authResponseUrl);
      const code = u.searchParams.get('code');
      if (code) {
        const tokenData = await this.exchangeAuthCode(code, redirectUri);
        if (tokenData && tokenData.access_token) {
          authConfig.exchangedAuthCredential.authType = 'oauth2';
          authConfig.exchangedAuthCredential.oauth2.accessToken = tokenData.access_token;
          authConfig.exchangedAuthCredential.oauth2.tokenType = tokenData.token_type || 'Bearer';
          if (tokenData.refresh_token) authConfig.exchangedAuthCredential.oauth2.refreshToken = tokenData.refresh_token;
          if (tokenData.id_token) authConfig.exchangedAuthCredential.oauth2.idToken = tokenData.id_token;
        }
      }
    } catch (e) {
      console.warn('Could not cache token from OAuth response:', e);
    }

    const resumeSessionId = this.sessionId;
    const resumeUserId = this.sessionUserId || this.userId;

    const activeToken = this.getStoredToken(this.userId);
    const userEmail = activeToken?.userinfo?.email || this.userId;
    const userName = activeToken?.userinfo?.name || AdkAgentClient.fallbackName(userEmail);

    const runPayload = {
      appName: this.appName,
      userId: resumeUserId,
      sessionId: resumeSessionId,
      state_delta: {
        user_email: userEmail,
        user_name: userName
      },
      newMessage: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: rawFunctionCall.id,
              name: rawFunctionCall.name,
              response: authConfig
            }
          }
        ]
      }
    };

    const res = await fetch(`${this.baseUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(runPayload)
    });

    if (!res.ok) {
      let errDetail = '';
      try {
        const errJson = await res.json();
        errDetail = typeof errJson === 'object' ? JSON.stringify(errJson) : String(errJson);
      } catch (e) {
        errDetail = await res.text().catch(() => '');
      }
      console.error(`ADK Server responded with HTTP ${res.status}:`, errDetail);
      throw new Error(`ADK Server responded with HTTP ${res.status}: ${errDetail}`);
    }

    const events = await res.json();
    return this.parseAdkEvents(events);
  }

  /**
   * Works out what Apigee actually did with a tool call.
   *
   * This exists because the card used to report "200 OK" unconditionally: it was
   * built from the functionCall (the request) before any response had arrived,
   * so a request the gateway had deliberately rejected still rendered green,
   * directly contradicting the agent's own refusal text next to it.
   *
   * Each branch keys on the most structural signal available rather than on the
   * customer-facing sentence, because that wording is owned by the Apigee
   * policies and is expected to be edited.
   */
  classifyToolResult(toolName, response) {
    const respStr = typeof response === 'object'
      ? JSON.stringify(response)
      : String(response || '');

    // A CallToolResult carries the backing proxy's body through as text.
    let innerText = '';
    if (response && Array.isArray(response.content)) {
      innerText = response.content
        .map(c => (c && typeof c.text === 'string') ? c.text : '')
        .join('\n');
    }
    const errorText = (response && typeof response.error === 'string')
      ? response.error
      : '';

    // --- Business policy: maximum order value -------------------------------
    // `order_limit_exceeded` is a machine-readable code emitted by
    // RF-Order-Limit-Exceeded on Biscuit-Coffee-Shop, so this detection does not
    // depend on the customer-facing sentence.
    if (innerText.includes('order_limit_exceeded') || respStr.includes('order_limit_exceeded')) {
      let message = '';
      try {
        message = (JSON.parse(innerText) || {}).message || '';
      } catch (e) {
        message = '';
      }
      return {
        status: '422 Unprocessable Entity',
        statusNote: 'Order Value Policy',
        statusClass: 'policy-blocked',
        success: false,
        isPolicyBlock: true,
        endpoint: 'Apigee → Biscuit-Coffee-Shop → POST /orders',
        policy: 'JS-CheckOrderValue → RF-Order-Limit-Exceeded',
        enforcedBy: 'maxOrderAmount attribute on the placeOrder API Product operation',
        // The caller was authorised; it is the order value that was refused.
        scopeRequired: 'biscuit_coffee_customer',
        resultLabel: 'Policy Result',
        error: message || 'Order value exceeds the maximum accepted online.'
      };
    }

    // --- Object-level authorisation: order ownership (BOLA) ------------------
    // `order_not_found` is emitted by RF-Order-Not-Found on Biscuit-Coffee-Shop
    // for every ownership denial, so this keys on the code rather than on the
    // sentence.
    //
    // Note the card deliberately says nothing about WHY the order was refused.
    // The gateway returns the same 404 whether the order does not exist or
    // simply is not this customer's, so that the API cannot be used to discover
    // which order IDs are real; labelling one case differently here would put
    // that oracle straight back. The real reason is available to the operator
    // in the X-Debug-Reason response header and in a trace.
    if (innerText.includes('order_not_found') || respStr.includes('order_not_found')) {
      let message = '';
      try {
        message = (JSON.parse(innerText) || {}).message || '';
      } catch (e) {
        message = '';
      }
      const isCancel = /cancel/i.test(toolName || '');
      return {
        status: '404 Not Found',
        statusNote: 'Ownership Policy',
        statusClass: 'policy-blocked',
        success: false,
        isPolicyBlock: true,
        endpoint: `Apigee → Biscuit-Coffee-Shop → ${isCancel ? 'DELETE' : 'GET'} /orders/{order_id}`,
        // Reads are checked on the way out, deletes on the way in - a delete
        // cannot be undone, so it pays for a pre-flight lookup that a read
        // gets for free from its own response.
        policy: isCancel
          ? 'JS-OwnershipFlags → SC-GetOrderOwner → JS-OwnershipLookup → RF-Order-Not-Found'
          : 'JS-OwnershipFlags → JS-OwnershipResponse → RF-Order-Not-Found',
        enforcedBy: 'enforceOrderOwnership attribute on the biscuit-coffee-agent API Product',
        // The caller was authenticated and correctly scoped; it is the specific
        // object they asked for that is not theirs.
        scopeRequired: 'biscuit_coffee_customer',
        resultLabel: 'Policy Result',
        error: message || 'That order is not available on this account.'
      };
    }

    // --- Business policy: per-tool rate limit --------------------------------
    // The agent's transport shim only lets a response body survive a non-2xx
    // status for HTTP 429 (POLICY_FAULT_STATUSES in tools.py). Every other
    // gateway failure collapses into a TaskGroup/connection error instead, so a
    // clean "MCP tool execution failed" can only have come from the quota policy.
    const isTransportCrash = /TaskGroup|connection lost|ConnectionError/i.test(errorText);
    if (errorText && errorText.includes('MCP tool execution failed') && !isTransportCrash) {
      return {
        status: '429 Too Many Requests',
        statusNote: 'Rate Limit Policy',
        statusClass: 'policy-blocked',
        success: false,
        isPolicyBlock: true,
        endpoint: `Apigee → mcp-proxy-prod → tools/call/${toolName || 'placeOrder'}`,
        policy: 'QU-ProductQuota → RF-Quota-Exceeded',
        enforcedBy: 'API Product quota on the placeOrder operation (3 requests / 1 minute)',
        // The caller was authorised; it is the request rate that was refused.
        scopeRequired: 'biscuit_coffee_customer',
        resultLabel: 'Policy Result',
        error: errorText.replace(/^MCP tool execution failed:\s*/, '')
      };
    }

    // --- Security: missing OAuth scope --------------------------------------
    const isInsufficientScope = respStr.includes('insufficient_scope') ||
                                respStr.includes('Failed to Resolve Variable') ||
                                respStr.includes('does not have the required permissions');
    if (isInsufficientScope) {
      return {
        status: '403 Forbidden',
        statusNote: 'Scope Blocked',
        statusClass: 'forbidden',
        success: false,
        needsManagerAuth: true,
        isForbidden: true,
        policy: 'OAuth Scope & Policy Evaluation',
        scopeRequired: 'biscuit_coffee_manager',
        resultLabel: 'Security Result',
        error: 'Missing required scope: biscuit_coffee_manager (Manager role required)'
      };
    }

    // --- Anything else the tool flagged as an error --------------------------
    if (response && response.isError === true) {
      return {
        status: 'Tool Error',
        statusClass: 'forbidden',
        success: false,
        resultLabel: 'Result',
        error: (innerText || respStr).slice(0, 200)
      };
    }

    // --- Human-in-the-loop: order accepted but waiting for manager approval ---
    // AM-OrderConfirmation adds a machine-readable `status`; the sentence is
    // owned by Apigee and may change, so it is not parsed here.
    if (toolName === 'placeOrder' && innerText) {
      let body = null;
      try {
        body = JSON.parse(innerText);
      } catch (e) {
        body = null;
      }
      if (body && body.order_id && body.status === 'PENDING_APPROVAL') {
        return {
          status: 'PENDING',
          statusClass: 'pending',
          success: true,
          isPendingApproval: true,
          pendingOrderId: String(body.order_id),
          endpoint: 'Apigee → Biscuit-Coffee-Shop → POST /orders',
          policy: 'JS-CheckOrderValue → PENDING_APPROVAL (staff approval in Staff app)',
          enforcedBy: 'approvalThreshold attribute on the placeOrder API Product operation',
          scopeRequired: 'biscuit_coffee_customer'
        };
      }
    }

    return { status: '200 OK', statusClass: 'success', success: true };
  }

  parseAdkEvents(events) {
    let combinedText = '';
    let relayText = '';
    let authCall = null;
    const calls = [];
    const byId = new Map();

    if (Array.isArray(events)) {
      for (const ev of events) {
        if (ev.content && ev.content.parts) {
          for (const p of ev.content.parts) {
            if (p.text) {
              combinedText += p.text;
            }

            const fc = p.functionCall || p.function_call || p.tool_call;
            if (fc) {
              if (fc.name === 'adk_request_credential') {
                const rawAuthUri = fc.args?.authConfig?.exchangedAuthCredential?.oauth2?.authUri
                  || fc.args?.exchangedAuthCredential?.oauth2?.authUri
                  || fc.args?.authConfig?.exchangedAuthCredential?.authUri
                  || fc.args?.auth_config?.exchanged_auth_credential?.oauth2?.auth_uri;

                const currentOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
                const currentPath = typeof window !== 'undefined' ? window.location.pathname : '/';
                const redirectUri = `${currentOrigin}${currentPath}`;

                let finalAuthUri = rawAuthUri;
                if (rawAuthUri) {
                  try {
                    const u = new URL(rawAuthUri);
                    u.searchParams.set('redirect_uri', redirectUri);
                    finalAuthUri = u.toString();
                  } catch (e) {
                    console.warn('Failed to attach redirect_uri to authUri:', e);
                  }
                }

                authCall = {
                  id: fc.id || `auth_${Date.now()}`,
                  name: 'adk_request_credential (Keycloak OAuth 2.0)',
                  endpoint: 'Keycloak OIDC Authorization Server',
                  policy: '3-Legged OAuth Consent Flow',
                  scopeRequired: 'biscuit_coffee_customer, biscuit_coffee_manager',
                  status: 'Login Required',
                  success: true,
                  isAuth: true,
                  authUri: finalAuthUri,
                  redirectUri: redirectUri,
                  rawFunctionCall: fc
                };
              } else {
                // Record the call as pending. The status is filled in from the
                // matching functionResponse below - never assumed here.
                const call = {
                  id: fc.id || `tool_${Date.now()}_${calls.length}`,
                  name: fc.name || 'mcp_proxy_tool',
                  endpoint: 'Apigee MCP Proxy',
                  policy: 'OAuth Scope & Policy Evaluation',
                  scopeRequired: 'biscuit_coffee_*',
                  status: 'Pending',
                  statusClass: 'success',
                  success: true,
                  args: fc.args
                };
                calls.push(call);
                if (fc.id) byId.set(fc.id, call);
              }
            }

            const fr = p.functionResponse || p.function_response;
            if (fr && fr.name !== 'adk_request_credential') {
              // Attach to the call this is answering. Falling back to the most
              // recent call keeps older ADK payloads (which omit ids) working.
              let call = (fr.id && byId.get(fr.id)) || null;
              if (!call) {
                call = [...calls].reverse().find(c => c.name === fr.name) || null;
              }
              if (!call) {
                call = {
                  id: fr.id || `resp_${Date.now()}_${calls.length}`,
                  name: fr.name || 'Apigee Tool Execution',
                  endpoint: 'Apigee MCP Proxy',
                  policy: 'OAuth Scope & Policy Evaluation',
                  scopeRequired: 'biscuit_coffee_customer'
                };
                calls.push(call);
              }
              Object.assign(call, this.classifyToolResult(fr.name, fr.response), {
                response: fr.response
              });
              // The agent ended the turn with Apigee's own sentence (no second
              // model call); it becomes the reply text below.
              if (fr.response && typeof fr.response.relay_message === 'string') {
                relayText = fr.response.relay_message;
              }
            }
          }
        }
      }
    }

    // A turn often contains several tool calls (getMenu, then placeOrder).
    // Surface whichever one the gateway actually blocked - that is the whole
    // point of the card - and otherwise the last call made.
    const blocked = calls.find(c => c.success === false);
    const pending = calls.find(c => c.isPendingApproval);
    const toolCall = authCall || blocked || pending || calls[calls.length - 1] || null;

    if (toolCall && toolCall.isAuth) {
      combinedText = `🔒 **Keycloak Authentication Required**\n\nThe AI Agent requires 3-legged OAuth authorization to execute tools on the Biscuit Coffee Apigee Gateway.\n\nPlease click the **Login** button below to authenticate.\n\n• **Customer 1 (John Smith)**: \`customer@biscuit-coffee.com\` (password: \`ilovecoffee\`)\n• **Customer 2 (Michael Bosh)**: \`customer2@biscuit-coffee.com\` (password: \`ilovecoffee\`)`;
    } else if (!combinedText && relayText) {
      combinedText = relayText;
    } else if (!combinedText) {
      combinedText = 'Response completed by ADK agent.';
    }

    return {
      text: combinedText,
      toolCall: toolCall
    };
  }
}
