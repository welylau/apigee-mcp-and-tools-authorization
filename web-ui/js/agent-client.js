/**
 * ADK Web Agent Client
 * Manages communication with the live Google ADK Web backend (default: http://localhost:8000),
 * session handling, and graceful fallback to offline simulator.
 */

import { simulateAgentResponse } from './mock-agent.js';

export class AdkAgentClient {
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

  getStoredToken(userId = null) {
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
      if (data.expiresAt <= Date.now()) {
        this.clearStoredToken();
        return null;
      }
      return data;
    } catch (e) {
      return null;
    }
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
    const tokenData = this.getStoredToken(userId);
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
      }
      // If 403 or other non-401 status, do NOT wipe valid unexpired local token
    } catch (e) {
      // Offline fallback: keep token active if unexpired
    }

    return {
      ...tokenData,
      active: true
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
      throw new Error(err.error_description || err.error || `Keycloak token exchange failed (HTTP ${res.status})`);
    }

    const tokens = await res.json();
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

    const targetEmail = claims.email || idClaims.email || claims.preferred_username || idClaims.preferred_username || 'customer@biscuit-coffee.com';
    let targetName = claims.name || idClaims.name || claims.preferred_username || idClaims.preferred_username || targetEmail;
    if (targetEmail.includes('manager') && targetName === targetEmail) {
      targetName = 'Alice (Manager)';
    } else if (targetEmail.includes('customer') && targetName === targetEmail) {
      targetName = 'John Smith';
    }

    // Determine scopes from tokens.scope, claims.scope, or realm_access roles
    let tokenScopes = tokens.scope || claims.scope || '';
    const realmRoles = claims.realm_access?.roles || [];
    if (!tokenScopes) {
      if (realmRoles.includes('biscuit_coffee_manager') || targetEmail.includes('manager')) {
        tokenScopes = 'biscuit_coffee_customer biscuit_coffee_manager';
      } else {
        tokenScopes = 'biscuit_coffee_customer';
      }
    }

    const tokenData = {
      access_token: tokens.access_token,
      id_token: tokens.id_token,
      refresh_token: tokens.refresh_token,
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

    this.userId = targetEmail;
    this.saveStoredToken(targetEmail, tokenData);

    // Trigger instant UI refresh across the app
    if (typeof window !== 'undefined' && window.biscuitApp && typeof window.biscuitApp.refreshAuthUI === 'function') {
      window.biscuitApp.refreshAuthUI().catch(() => {});
    }

    return tokenData;
  }

  async logoutKeycloak(userId = null) {
    const tokenData = this.getStoredToken(userId);
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

  async sendMessage(text, currentRole) {
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
      const activeToken = isGuest ? null : this.getStoredToken(this.userId);
      const userEmail = isGuest ? this.userId : (activeToken?.userinfo?.email || this.userId);
      const userName = isGuest ? '' : (activeToken?.userinfo?.name || (userEmail.includes('manager') ? 'Alice (Manager)' : 'John Smith'));

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

        if (res.status === 404 && errDetail.includes('Session not found')) {
          console.warn('Session not found on ADK server, auto-creating a new session and retrying...');
          this.sessionId = null;
          this.sessionUserId = null;
          await this.ensureSession(true);
          runPayload.sessionId = this.sessionId;
          runPayload.userId = this.userId;
          const retryRes = await fetch(`${this.baseUrl}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(runPayload)
          });
          if (retryRes.ok) {
            const retryEvents = await retryRes.json();
            let parsed = this.parseAdkEvents(retryEvents);
            if (parsed.toolCall && parsed.toolCall.isAuth) {
              const activeToken = this.getStoredToken(this.userId);
              if (activeToken && activeToken.access_token && (!activeToken.expiresAt || activeToken.expiresAt > Date.now())) {
                return await this.sendStoredTokenResponse(parsed.toolCall.rawFunctionCall, activeToken);
              }
            }
            return parsed;
          }
        }

        console.error(`ADK Server responded with HTTP ${res.status}:`, errDetail);
        throw new Error(`ADK Server responded with HTTP ${res.status}: ${errDetail}`);
      }

      const events = await res.json();
      let parsed = this.parseAdkEvents(events);

      // If ADK requested credentials and the user is already authenticated with Keycloak,
      // seamlessly auto-fulfill the request with the active access token without prompting again.
      if (parsed.toolCall && parsed.toolCall.isAuth) {
        const activeToken = this.getStoredToken(this.userId);
        if (activeToken && activeToken.access_token && (!activeToken.expiresAt || activeToken.expiresAt > Date.now())) {
          console.log('Auto-fulfilling adk_request_credential using active stored Keycloak token...');
          return await this.sendStoredTokenResponse(parsed.toolCall.rawFunctionCall, activeToken);
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
    const userName = activeToken?.userinfo?.name || (userEmail.includes('manager') ? 'Alice (Manager)' : (userEmail.includes('customer') ? 'John Smith' : ''));

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

  parseAdkEvents(events) {
    let combinedText = '';
    let toolCall = null;

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

                toolCall = {
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
                toolCall = {
                  id: fc.id || `tool_${Date.now()}`,
                  name: fc.name || 'mcp_proxy_tool',
                  endpoint: `Apigee MCP Proxy`,
                  policy: 'OAuth Scope & Policy Evaluation',
                  scopeRequired: 'biscuit_coffee_*',
                  status: '200 OK',
                  success: true,
                  args: fc.args
                };
              }
            }

            const fr = p.functionResponse || p.function_response;
            if (fr && fr.name !== 'adk_request_credential' && !toolCall) {
              const respStr = typeof fr.response === 'object' ? JSON.stringify(fr.response) : String(fr.response || '');
              const isInsufficientScope = respStr.includes('insufficient_scope') ||
                                          respStr.includes('Failed to Resolve Variable') ||
                                          respStr.includes('does not have the required permissions') ||
                                          fr.response?.result?.isError === true;
              const isManagerReq = (fr.name && fr.name.includes('Employee')) || isInsufficientScope;

              toolCall = {
                id: fr.id || `resp_${Date.now()}`,
                name: fr.name || 'Apigee Tool Execution',
                endpoint: 'Apigee MCP Proxy',
                policy: 'OAuth Scope & Policy Evaluation',
                scopeRequired: isManagerReq ? 'biscuit_coffee_manager' : 'biscuit_coffee_customer',
                status: isInsufficientScope ? '403 Forbidden' : '200 OK',
                success: !isInsufficientScope,
                isForbidden: isInsufficientScope,
                needsManagerAuth: isInsufficientScope,
                error: isInsufficientScope ? 'Missing required scope: biscuit_coffee_manager (Manager role required)' : null,
                response: fr.response
              };
            }
          }
        }
      }
    }

    if (toolCall && toolCall.isAuth) {
      combinedText = `🔒 **Keycloak Authentication Required**\n\nThe AI Agent requires 3-legged OAuth authorization to execute tools on the Biscuit Coffee Apigee Gateway.\n\nPlease click the **Login** button below to authenticate.\n\n• **Customer Persona**: \`customer@biscuit-coffee.com\` (password: \`ilovecoffee\`)\n• **Store Manager**: \`manager@biscuit-coffee.com\` (password: \`ilovecoffee\`)`;
    } else if (!combinedText) {
      combinedText = 'Response completed by ADK agent.';
    }

    return {
      text: combinedText,
      toolCall: toolCall
    };
  }
}
