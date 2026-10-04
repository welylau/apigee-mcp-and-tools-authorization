/**
 * Guided Tour engine - welcome chooser, spotlight + coachmark, mission
 * progress, completion detection and "What just happened?" explainer.
 *
 * Integration contract (emitted by app.js):
 *   window 'biscuit:toolresult'    detail { toolCall, text }   after each agent reply to a user prompt
 *   window 'biscuit:personachange' detail { id }               after auth state refresh
 *   window 'biscuit:archopen'                                  architecture modal opened
 * Prompt chips carry data-prompt-id="<role>-<category>".
 */
import { MISSIONS, statusCode } from './tour-missions.js';

const STORE_KEY = 'biscuitTour.v1';
const HIDE_WELCOME_KEY = 'biscuitTour.hideWelcome';
const SEEN_KEY = 'biscuitTour.seenThisSession';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const resolve = (v, ...args) => (typeof v === 'function' ? v(...args) : v);
const CLOSE_BTN = '<button type="button" class="tour-close" data-act="dismiss" title="Close (Esc)" aria-label="Close tour">×</button>';
const PERSONA_LABEL = { guest: 'Guest (logged out)', customer: 'Customer (John)', customer2: 'Customer 2 (Michael)' };

export class GuidedTour {
  constructor(app) {
    this.app = app;
    this.state = this.load();
    this.hint = '';
    this.mode = 'idle'; // idle | step | explainer
    this.build();
    this.bind();

    const params = new URLSearchParams(window.location.search);
    const forced = params.get('tour');
    if (forced && forced !== '0') {
      const idx = MISSIONS.findIndex((m) => m.id === forced);
      if (idx >= 0) this.start(idx); else this.showWelcome();
    } else if (this.state.active) {
      this.showStep(); // resume an in-progress tour after reload / OAuth redirect
    } else if (!localStorage.getItem(HIDE_WELCOME_KEY) && !sessionStorage.getItem(SEEN_KEY)) {
      this.showWelcome();
    }
  }

  // ------------------------------------------------------------------ state
  load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return { active: !!s.active, mission: s.mission || 0, step: s.step || 0, completed: s.completed || [], ctx: s.ctx || {} };
    } catch { return { active: false, mission: 0, step: 0, completed: [], ctx: {} }; }
  }
  save() { localStorage.setItem(STORE_KEY, JSON.stringify(this.state)); }
  get mission() { return MISSIONS[this.state.mission]; }
  get step() { return this.mission?.steps[this.state.step]; }
  get persona() { return this.app.currentRole?.id || 'guest'; }

  // ------------------------------------------------------------------ DOM
  build() {
    const root = document.createElement('div');
    root.className = 'tour-root';
    root.innerHTML = `
      <div class="tour-welcome-backdrop" id="tourWelcome" hidden>
        <div class="tour-welcome" role="dialog" aria-modal="true" aria-labelledby="tourWelcomeTitle">
          <div class="tour-welcome-icon">☕</div>
          <h2 id="tourWelcomeTitle">Welcome to Biscuit Coffee Assistant</h2>
          <p class="tour-welcome-sub">See how Apigee secures AI agents and MCP tools with Keycloak OAuth 2.0</p>
          <div class="tour-choice-grid">
            <button type="button" class="tour-choice selected" data-choice="tour">
              <span class="tour-choice-badge">Recommended</span>
              <span class="tour-choice-icon">🗺️</span>
              <span class="tour-choice-title">Guided Tour</span>
              <span class="tour-choice-meta">${MISSIONS.filter((m) => !m.bonus).length} short missions · about 12 min</span>
              <ul class="tour-choice-list">
                <li>Public vs logged-in access</li>
                <li>Least-privilege tools and order approval</li>
                <li>Order limits and rate limits</li>
                <li>Audit logs in Cloud Logging</li>
              </ul>
            </button>
            <button type="button" class="tour-choice" data-choice="explore">
              <span class="tour-choice-icon">🧭</span>
              <span class="tour-choice-title">Explore on my own</span>
              <span class="tour-choice-meta">Go straight to the chat and suggested prompts. You can start the tour later from the header.</span>
            </button>
          </div>
          <div class="tour-welcome-footer">
            <label class="tour-check"><input type="checkbox" id="tourHideWelcome"> Don't show this again</label>
            <div class="tour-welcome-actions">
              <button type="button" class="tour-btn tour-btn-text" id="tourResumeBtn" hidden></button>
              <button type="button" class="tour-btn tour-btn-text" id="tourSkipBtn">Skip</button>
              <button type="button" class="tour-btn tour-btn-primary" id="tourStartBtn">Start Guided Tour</button>
            </div>
          </div>
        </div>
      </div>

      <div class="tour-dim" id="tourDim" hidden><i></i><i></i><i></i><i></i></div>
      <div class="tour-spotlight" id="tourSpotlight" hidden></div>

      <div class="tour-stepper" id="tourStepper" hidden>
        <button type="button" class="tour-stepper-list" id="tourChecklistBtn" title="Show all missions">☰ Missions</button>
        <div class="tour-dots" id="tourDots"></div>
        <span class="tour-stepper-label" id="tourStepperLabel"></span>
        <button type="button" class="tour-btn tour-btn-text tour-exit" id="tourExitBtn">Exit tour</button>
      </div>

      <div class="tour-checklist" id="tourChecklist" hidden></div>

      <div class="tour-pop" id="tourPop" role="dialog" aria-live="polite" hidden></div>

      <aside class="tour-explainer" id="tourExplainer" aria-live="polite" hidden></aside>
    `;
    document.body.appendChild(root);
    const $ = (id) => root.querySelector(`#${id}`);
    Object.assign(this, {
      root, welcome: $('tourWelcome'), spot: $('tourSpotlight'), dim: $('tourDim'), stepper: $('tourStepper'),
      dots: $('tourDots'), stepperLabel: $('tourStepperLabel'), checklist: $('tourChecklist'),
      pop: $('tourPop'), explainer: $('tourExplainer'),
    });

    // Welcome wiring
    let choice = 'tour';
    root.querySelectorAll('.tour-choice').forEach((btn) => btn.addEventListener('click', () => {
      choice = btn.dataset.choice;
      root.querySelectorAll('.tour-choice').forEach((b) => b.classList.toggle('selected', b === btn));
      $('tourStartBtn').textContent = choice === 'tour' ? 'Start Guided Tour' : 'Start exploring';
    }));
    const closeWelcome = () => {
      if ($('tourHideWelcome').checked) localStorage.setItem(HIDE_WELCOME_KEY, '1');
      sessionStorage.setItem(SEEN_KEY, '1');
      this.welcome.hidden = true;
    };
    $('tourStartBtn').addEventListener('click', () => {
      closeWelcome();
      if (choice === 'tour') this.start(0, true); else this.exit(false);
    });
    $('tourSkipBtn').addEventListener('click', () => { closeWelcome(); this.exit(false); });
    $('tourResumeBtn').addEventListener('click', () => { closeWelcome(); this.start(this.state.mission); });
    $('tourExitBtn').addEventListener('click', () => this.exit(true));
    $('tourChecklistBtn').addEventListener('click', () => this.toggleChecklist());
  }

  bind() {
    window.addEventListener('biscuit:toolresult', (e) => this.onToolResult(e.detail || {}));
    window.addEventListener('biscuit:personachange', () => this.onPersonaChange());
    window.addEventListener('biscuit:archopen', () => this.onEvent('biscuit:archopen'));
    document.addEventListener('click', (e) => {
      const s = this.step;
      if (this.mode !== 'step' || !s?.done?.click) return;
      if (e.target.closest(s.done.click)) setTimeout(() => this.completeStep(), 300);
    }, true);
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // One Esc closes one layer: checklist first, then app layers, then the tour pop-up.
      if (!this.checklist.hidden) { this.toggleChecklist(false); e.stopImmediatePropagation(); return; }
      const appLayerOpen = this.app.archModal?.classList.contains('active')
        || document.getElementById('settingsOpenBtn')?.getAttribute('aria-expanded') === 'true';
      if (appLayerOpen || !this.welcome.hidden) return;
      if (['step', 'explainer', 'finished'].includes(this.mode)) this.dismiss();
    }, true);

    let raf = 0;
    const reflow = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => this.position()); };
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, true);
    // Sidebar content and drawers move around; keep the spotlight glued on.
    // The ticker only runs while a step / explainer is on screen (ensureTicker).
    this.ticker = 0;
  }

  /** Start the 300 ms layout ticker; it stops itself once the tour is idle. */
  ensureTicker() {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      if (!['step', 'explainer', 'finished'].includes(this.mode)) {
        clearInterval(this.ticker);
        this.ticker = 0;
        return;
      }
      this.syncDrawerState();
      if (this.mode === 'step') this.position();
    }, 300);
  }

  // ------------------------------------------------------------------ flow
  showWelcome() {
    const resume = this.root.querySelector('#tourResumeBtn');
    const canResume = this.state.completed.length > 0 && this.state.mission < MISSIONS.length;
    resume.hidden = !canResume;
    if (canResume) resume.textContent = `Resume (Mission ${this.state.mission + 1})`;
    this.hideOverlays();
    this.welcome.hidden = false;
  }

  /** Public: (re)open the chooser, e.g. from the header button. */
  open() { this.showWelcome(); }

  start(missionIdx = 0, fresh = false) {
    if (fresh) this.state = { active: true, mission: 0, step: 0, completed: [], ctx: {} };
    this.state.active = true;
    this.state.mission = Math.max(0, Math.min(missionIdx, MISSIONS.length - 1));
    this.state.step = 0;
    this.save();
    this.showStep();
  }

  exit(confirmed) {
    this.state.active = false;
    this.save();
    this.mode = 'idle';
    this.closeArch();
    this.hideOverlays();
    if (confirmed) this.app.addSystemNotice?.('🗺️ Guided Tour paused. Reopen it any time from **Guided Tour** in the header.');
  }

  hideOverlays() {
    [this.dim, this.spot, this.stepper, this.checklist, this.pop, this.explainer].forEach((el) => { el.hidden = true; });
  }

  showStep({ fromBack = false } = {}) {
    const s = this.step;
    if (!s) return this.finish();
    if (!fromBack && s.skipIf && s.skipIf(this.state.ctx, this)) return this.completeStep(true);
    // Login and chat steps happen in the main UI: get the Settings drawer out of the way.
    if (s.kind === 'persona' || s.kind === 'prompt') this.closeSettings();
    this.mode = 'step';
    this.ensureTicker();
    this.hint = '';
    this.promptStaged = false;
    this.explainer.hidden = true;
    this.renderStepper();
    this.renderPop();
    const sel = resolve(s.target, this);
    const el = sel && document.querySelector(sel);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'auto' });
    // Persona steps may already be satisfied (e.g. resumed while logged in).
    // Not when the user stepped back on purpose, or Back would bounce forward again.
    if (!fromBack && s.done?.persona && s.done.persona.includes(this.persona)) {
      const key = `${this.state.mission}:${this.state.step}`;
      setTimeout(() => { if (`${this.state.mission}:${this.state.step}` === key) this.completeStep(); }, 600);
    }
    setTimeout(() => this.position(), 350);
  }

  completeStep(silent = false) {
    if (this.mode !== 'step' && !silent) return;
    const m = this.mission;
    if (this.state.step < m.steps.length - 1) {
      this.state.step += 1;
      this.save();
      return this.showStep();
    }
    if (!this.state.completed.includes(m.id)) this.state.completed.push(m.id);
    this.save();
    this.showExplainer();
  }

  nextMission() {
    this.closeArch();
    if (this.state.mission >= MISSIONS.length - 1) return this.finish();
    this.state.mission += 1;
    this.state.step = 0;
    this.save();
    this.showStep();
  }

  /** Close the architecture diagram modal if it's still open (it would block the UI). */
  closeArch() {
    if (this.app.archModal?.classList.contains('active')) this.app.closeModal?.();
  }

  /** Close the Settings drawer if it's open (it covers the login button and chat). */
  closeSettings() {
    if (document.getElementById('settingsOpenBtn')?.getAttribute('aria-expanded') === 'true') {
      document.getElementById('settingsCloseBtn')?.click();
    }
  }

  finish() {
    this.state.active = false;
    this.state.mission = MISSIONS.length;
    this.save();
    this.mode = 'idle';
    this.hideOverlays();
    const done = this.state.completed.length;
    this.explainer.innerHTML = `${CLOSE_BTN}
      <div class="tour-exp-head"><span class="tour-exp-kicker">Guided Tour</span><h3>🎉 Tour complete</h3></div>
      <p class="tour-exp-text">You finished <b>${done}</b> of ${MISSIONS.length} missions. You've seen Apigee:</p>
      <ul class="tour-exp-summary">
        <li>Turn MCP requests into REST calls for existing APIs</li>
        <li>Pass the user's Keycloak identity through the agent</li>
        <li>Expose only the tools in each app's API Product, and block other users' orders (404)</li>
        <li>Enforce order-value limits (422) and per-tool quotas (429)</li>
        <li>Send an audit trail to Cloud Logging</li>
      </ul>
      <div class="tour-exp-actions">
        <button type="button" class="tour-btn tour-btn-text" data-act="restart">Restart tour</button>
        <button type="button" class="tour-btn tour-btn-primary" data-act="close">Continue exploring</button>
      </div>`;
    this.mode = 'finished';
    this.ensureTicker();
    this.explainer.hidden = false;
    this.explainer.querySelector('[data-act="restart"]').onclick = () => this.start(0, true);
    this.explainer.querySelectorAll('[data-act="close"], [data-act="dismiss"]').forEach((b) => {
      b.onclick = () => { this.explainer.hidden = true; this.mode = 'idle'; };
    });
  }

  // ------------------------------------------------------------------ events
  onToolResult({ toolCall, text }) {
    if (!this.state.active) return;
    const s = this.step;
    if (this.mode !== 'step' || !s) { this.save(); return; }
    if (s.onResult) s.onResult(toolCall, text, this.state.ctx);
    this.save();
    if (s.done?.tool) {
      if (s.done.tool(toolCall, text, this.state.ctx)) return this.completeStep();
      const code = statusCode(toolCall);
      const got = toolCall ? `<b>${esc(toolCall.status)}</b>${toolCall.name ? ` from <code>${esc(toolCall.name)}</code>` : ''}` : 'a reply with no tool call';
      let advice = 'Try again. Agents sometimes word things differently, so you can resend the prompt.';
      if (s.requires && !s.requires.includes(this.persona)) {
        advice = `You're signed in as <b>${esc(PERSONA_LABEL[this.persona])}</b>, but this step needs <b>${s.requires.map((p) => esc(PERSONA_LABEL[p])).join(' or ')}</b>.`;
      } else if (this.mission.id === 'rate-limit' && code === 200) {
        advice = 'That order was accepted. Send it again to use up the quota.';
      }
      this.hint = `Got ${got}. ${advice}`;
      this.renderPop();
      this.position();
    }
  }

  onPersonaChange() {
    if (this.mode !== 'step') return;
    const s = this.step;
    if (s?.done?.persona && s.done.persona.includes(this.persona)) return this.completeStep();
    this.renderPop();
    this.position();
  }

  onEvent(name) {
    if (this.mode === 'step' && this.step?.done?.event === name) this.completeStep();
  }

  // ------------------------------------------------------------------ render
  renderStepper() {
    const main = MISSIONS.filter((m) => !m.bonus);
    this.dots.innerHTML = MISSIONS.map((m, i) => {
      const cls = this.state.completed.includes(m.id) ? 'done' : (i === this.state.mission ? 'current' : '');
      const label = m.bonus ? '★' : i + 1;
      return `${i ? '<span class="tour-dot-line"></span>' : ''}<button type="button" class="tour-dot ${cls} ${m.bonus ? 'bonus' : ''}" data-idx="${i}" title="${esc(m.title)}">${cls === 'done' ? '✓' : label}</button>`;
    }).join('');
    this.dots.querySelectorAll('.tour-dot').forEach((d) => d.addEventListener('click', () => this.start(Number(d.dataset.idx))));
    const m = this.mission;
    this.stepperLabel.textContent = m.bonus ? 'Guided Tour · Bonus mission' : `Guided Tour · Mission ${this.state.mission + 1}/${main.length}`;
    const header = document.querySelector('header');
    if (header) this.stepper.style.top = `${Math.round(header.getBoundingClientRect().bottom) + 6}px`;
    this.stepper.hidden = false;
  }

  toggleChecklist(force) {
    const show = force ?? this.checklist.hidden;
    if (!show) { this.checklist.hidden = true; return; }
    const doneCount = this.state.completed.length;
    const pct = Math.round((doneCount / MISSIONS.length) * 100);
    this.checklist.innerHTML = `
      <div class="tour-cl-head">
        <div class="tour-ring" style="--pct:${pct}"><span>${doneCount}/${MISSIONS.length}</span></div>
        <div><div class="tour-cl-title">Mission checklist</div><div class="tour-cl-sub">Click a mission to jump to it</div></div>
      </div>
      <ol class="tour-cl-list">
        ${MISSIONS.map((m, i) => {
          const st = this.state.completed.includes(m.id) ? 'done' : (i === this.state.mission ? 'current' : 'todo');
          return `<li class="${st}" data-idx="${i}"><span class="tour-cl-mark">${st === 'done' ? '✓' : (m.bonus ? '★' : i + 1)}</span>
            <span class="tour-cl-name">${esc(m.title)}</span><span class="tour-cl-badge">${esc(m.badge)}</span></li>`;
        }).join('')}
      </ol>`;
    this.checklist.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
      this.toggleChecklist(false);
      this.start(Number(li.dataset.idx));
    }));
    this.checklist.hidden = false;
  }

  renderPop() {
    const s = this.step, m = this.mission, ctx = this.state.ctx;
    if (!s) return;
    const multi = m.steps.length > 1;
    const kicker = `${m.bonus ? 'BONUS MISSION' : `MISSION ${this.state.mission + 1} OF ${MISSIONS.filter((x) => !x.bonus).length}`}${multi ? ` · STEP ${this.state.step + 1}/${m.steps.length}` : ''}`;
    const wrongPersona = s.requires && !s.requires.includes(this.persona);
    const creds = (s.credentials || []).map((c) => `
      <div class="tour-cred">
        <div class="tour-cred-label">${esc(c.label)}</div>
        <div class="tour-cred-row"><span class="tour-cred-key">Username (Email)</span><code>${esc(c.user)}</code><button type="button" class="tour-copy" data-copy="${esc(c.user)}">Copy</button></div>
        <div class="tour-cred-row"><span class="tour-cred-key">Password</span><code>${esc(c.pass)}</code><button type="button" class="tour-copy" data-copy="${esc(c.pass)}">Copy</button></div>
      </div>`).join('');
    const credsHowTo = creds ? `
      <ol class="tour-cred-howto">
        <li>Click <b>${esc(resolve(s.action?.label, this) || 'Login')}</b> below. A Keycloak sign-in window pops up.</li>
        <li>Copy the <b>Username (Email)</b> and <b>Password</b> below and paste them into that pop-up window.</li>
        <li>Click <b>Sign In</b>. The pop-up closes and you're logged in.</li>
      </ol>` : '';

    let primary = '';
    if (s.kind === 'prompt' && this.promptStaged) primary = '<button type="button" class="tour-btn tour-btn-primary" data-act="send">Send ↵</button>';
    else if (s.kind === 'prompt') primary = '<button type="button" class="tour-btn tour-btn-primary" data-act="prompt">Use this prompt</button>';
    else if (s.action) primary = `<button type="button" class="tour-btn tour-btn-primary" data-act="action">${esc(resolve(s.action.label, this))}</button>`;

    // Body/progress templates contain the missions' own markup; any context
    // value they interpolate (order ids from tool results, storage) is escaped.
    const safeCtx = Object.fromEntries(Object.entries(ctx || {}).map(([k, v]) =>
      [k, (typeof v === 'string' || typeof v === 'number') ? esc(v) : v]));

    this.pop.innerHTML = `${CLOSE_BTN}
      <span class="tour-pop-arrow"></span>
      <div class="tour-pop-kicker">${kicker}</div>
      <h3 class="tour-pop-title">${esc(s.title)}</h3>
      <div class="tour-pop-body">${resolve(s.body, safeCtx)}</div>
      ${s.kind === 'prompt' ? `<div class="tour-prompt-preview">“${esc(resolve(s.prompt, ctx))}”</div>` : ''}
      ${creds ? `${credsHowTo}<div class="tour-creds">${creds}</div>` : ''}
      ${s.expect ? `<div class="tour-expect">Expected: <b>${esc(s.expect)}</b></div>` : ''}
      ${s.progress ? `<div class="tour-progress">${s.progress(safeCtx)}</div>` : ''}
      ${wrongPersona ? `<div class="tour-warn">This step needs <b>${s.requires.map((p) => esc(PERSONA_LABEL[p])).join(' or ')}</b>. You're signed in as <b>${esc(PERSONA_LABEL[this.persona])}</b>.
          <button type="button" class="tour-btn tour-btn-small" data-act="auth">${this.persona === 'guest' ? 'Log in' : 'Log out'}</button></div>` : ''}
      ${this.hint ? `<div class="tour-hint">${this.hint}</div>` : ''}
      <div class="tour-pop-actions">
        <button type="button" class="tour-btn tour-btn-text" data-act="back" ${this.state.mission === 0 && this.state.step === 0 ? 'disabled' : ''}>Back</button>
        <button type="button" class="tour-btn tour-btn-text" data-act="skip">Skip</button>
        ${primary}
      </div>`;
    this.pop.hidden = false;

    const on = (act, fn) => { const b = this.pop.querySelector(`[data-act="${act}"]`); if (b) b.onclick = fn; };
    on('prompt', () => {
      const text = resolve(s.prompt, ctx);
      if (this.app.setInputValue) this.app.setInputValue(text); else this.app.chatInput.value = text;
      this.app.chatInput.focus();
      this.hint = 'Prompt is in the chat box. Press <kbd>Enter</kbd> or <b>Send</b>.';
      this.promptStaged = true;
      this.renderPop(); this.position();
    });
    on('send', () => {
      const form = this.app.chatForm;
      if (!form || !this.app.chatInput?.value.trim()) return;
      if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event('submit', { cancelable: true }));
    });
    on('action', () => s.action.run(this));
    on('auth', () => this.app.handleAuthBtnClick());
    on('skip', () => this.completeStep());
    on('back', () => this.back());
    on('dismiss', () => this.dismiss());
    this.pop.querySelectorAll('.tour-copy').forEach((b) => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { b.textContent = 'Select & copy'; }
      setTimeout(() => { b.textContent = 'Copy'; }, 1500);
    }));
  }

  back() {
    // Walk backwards, skipping steps that would auto-skip (otherwise Back lands on
    // a skipped step and immediately bounces forward to where we started).
    const ctx = this.state.ctx;
    let mi = this.state.mission, si = this.state.step - 1;
    for (;;) {
      if (si < 0) {
        if (mi === 0) return;
        mi -= 1;
        si = MISSIONS[mi].steps.length - 1;
      }
      const st = MISSIONS[mi].steps[si];
      if (!(st.skipIf && st.skipIf(ctx, this))) break;
      si -= 1;
    }
    this.state.mission = mi;
    this.state.step = si;
    this.save();
    this.showStep({ fromBack: true });
  }

  showExplainer() {
    const m = this.mission, ex = m.explainer || {};
    this.mode = 'explainer';
    this.ensureTicker();
    this.spot.hidden = true; this.dim.hidden = true;
    this.pop.hidden = true;
    this.renderStepper();
    const next = MISSIONS[this.state.mission + 1];
    const icon = { ok: '✓', fail: '✕', skip: '–' };
    this.explainer.innerHTML = `${CLOSE_BTN}
      <div class="tour-exp-head"><span class="tour-exp-kicker">What just happened?</span><h3>${esc(ex.title || m.title)}</h3></div>
      <ol class="tour-flow">
        ${(ex.flow || []).map((f, i) => `<li class="${f.state}"><span class="tour-flow-n">${icon[f.state] || i + 1}</span><span>${esc(f.text)}</span></li>`).join('')}
      </ol>
      ${ex.note ? `<p class="tour-exp-note">${ex.note}</p>` : ''}
      <div class="tour-exp-done">Mission complete!</div>
      <div class="tour-exp-actions">
        ${next?.bonus ? '<button type="button" class="tour-btn tour-btn-text" data-act="finish">Finish tour</button>' : '<button type="button" class="tour-btn tour-btn-text" data-act="later">Pause</button>'}
        <button type="button" class="tour-btn tour-btn-primary" data-act="next">${next ? `${next.bonus ? 'Bonus' : 'Next'}: ${esc(next.title.replace(/^Bonus:\s*/, ''))}` : 'Finish tour'}</button>
      </div>`;
    this.explainer.hidden = false;
    this.avoidArchHeader();
    const on = (act, fn) => { const b = this.explainer.querySelector(`[data-act="${act}"]`); if (b) b.onclick = fn; };
    on('next', () => { this.explainer.hidden = true; this.nextMission(); });
    on('finish', () => this.finish());
    on('later', () => this.dismiss());
    on('dismiss', () => this.dismiss());
  }

  /**
   * Close the current tour pop-up (× button or Esc). Progress is kept, so the
   * tour can be resumed from the header's Guided Tour button.
   */
  dismiss() {
    if (this.mode === 'step') return this.exit(true);
    if (this.mode === 'explainer') {
      // Mission already done: resume at the next one.
      this.state.mission = Math.min(this.state.mission + 1, MISSIONS.length - 1);
      this.state.step = 0;
      return this.exit(true);
    }
    if (this.mode === 'finished') { this.explainer.hidden = true; this.mode = 'idle'; }
  }

  // ------------------------------------------------------------------ layout
  /** The stepper sits over the Settings drawer tabs; move it to the bottom while the drawer is open. */
  syncDrawerState() {
    const open = document.getElementById('settingsOpenBtn')?.getAttribute('aria-expanded') === 'true';
    this.root.classList.toggle('tour-drawer-open', open);
    this.avoidArchHeader();
  }

  /** Push the explainer below the architecture modal's header so its × / minimize stay clickable. */
  avoidArchHeader() {
    const ex = this.explainer;
    if (ex.hidden) return;
    const actions = this.app.archModal?.classList.contains('active')
      && this.app.archModal.querySelector('.modal-header-actions');
    const a = actions && actions.getBoundingClientRect();
    const e = ex.getBoundingClientRect();
    const overlaps = a && a.width > 0 && a.right > e.left && a.left < e.right;
    const top = overlaps ? `${Math.max(112, Math.round(a.bottom) + 12)}px` : '';
    if (ex.style.top !== top) {
      ex.style.top = top;
      ex.style.maxHeight = top ? `calc(100vh - ${top} - 18px)` : '';
    }
  }

  position() {
    if (this.mode !== 'step' || this.pop.hidden) return;
    const staged = this.promptStaged && this.app.chatInput;
    const sel = resolve(this.step?.target, this);
    // Dynamic targets (e.g. Settings button -> Audit Entries tab): refresh the coachmark text/button.
    const stepKey = `${this.state.mission}:${this.state.step}`;
    if (this.lastTarget && this.lastTarget.key === stepKey && this.lastTarget.sel !== sel) this.renderPop();
    this.lastTarget = { key: stepKey, sel };
    this.syncDrawerState();
    const isVisible = (rect) => rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0
      && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    // Always use the whole chat box (input + send button) for consistent placement.
    const box = (e) => (e && e === this.app.chatInput ? (e.closest('.input-box-wrapper') || e) : e);
    const targetEl = box(sel ? document.querySelector(sel) : null);
    // Once the prompt is in the chat box, spotlight the box so the user presses Send,
    // but keep the pop-up next to the prompt chip it came from (if that's on screen).
    const el = staged ? box(this.app.chatInput) : targetEl;
    const r = el?.getBoundingClientRect();
    const visible = isVisible(r);
    const tr = targetEl?.getBoundingClientRect();
    const ar = isVisible(tr) ? tr : r; // rect the pop-up is placed against

    const pw = this.pop.offsetWidth, ph = this.pop.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight, gap = 16, pad = 12;
    this.pop.classList.remove('place-right', 'place-left', 'place-bottom', 'place-top', 'place-center');

    if (!visible) {
      this.spot.hidden = true; this.dim.hidden = true;
      this.pop.classList.add('place-center');
      this.pop.style.left = `${(vw - pw) / 2}px`;
      this.pop.style.top = `${Math.max(80, (vh - ph) / 2)}px`;
      return;
    }

    const p = 6;
    Object.assign(this.spot.style, { left: `${r.left - p}px`, top: `${r.top - p}px`, width: `${r.width + p * 2}px`, height: `${r.height + p * 2}px` });
    this.spot.hidden = false;
    if (staged) {
      // No shade while the user is expected to type/press Enter - keep the UI fully usable.
      this.dim.hidden = true;
    } else {
      // Four dim panels around the target (box-shadow dimming is unreliable).
      const t = Math.max(0, r.top - p), b = Math.min(vh, r.bottom + p);
      const l = Math.max(0, r.left - p), rt = Math.min(vw, r.right + p);
      const [dTop, dBottom, dLeft, dRight] = this.dim.children;
      Object.assign(dTop.style, { left: '0px', top: '0px', width: `${vw}px`, height: `${t}px` });
      Object.assign(dBottom.style, { left: '0px', top: `${b}px`, width: `${vw}px`, height: `${Math.max(0, vh - b)}px` });
      Object.assign(dLeft.style, { left: '0px', top: `${t}px`, width: `${l}px`, height: `${Math.max(0, b - t)}px` });
      Object.assign(dRight.style, { left: `${rt}px`, top: `${t}px`, width: `${Math.max(0, vw - rt)}px`, height: `${Math.max(0, b - t)}px` });
      this.dim.hidden = false;
    }

    let place, left, top;
    const a = ar;
    if (a.right + gap + pw < vw - pad) { place = 'right'; left = a.right + gap; top = a.top + a.height / 2 - ph / 2; }
    else if (a.left - gap - pw > pad) { place = 'left'; left = a.left - gap - pw; top = a.top + a.height / 2 - ph / 2; }
    else if (a.bottom + gap + ph < vh - pad) { place = 'bottom'; top = a.bottom + gap; left = a.left + a.width / 2 - pw / 2; }
    else { place = 'top'; top = a.top - gap - ph; left = a.left + a.width / 2 - pw / 2; }

    left = Math.max(pad, Math.min(left, vw - pw - pad));
    top = Math.max(pad, Math.min(top, vh - ph - pad));
    this.pop.classList.add(`place-${place}`);
    this.pop.style.left = `${left}px`;
    this.pop.style.top = `${top}px`;
    // Keep the arrow pointing at the target even after clamping.
    const arrow = this.pop.querySelector('.tour-pop-arrow');
    if (arrow) {
      if (place === 'right' || place === 'left') {
        arrow.style.top = `${Math.max(16, Math.min(ph - 16, a.top + a.height / 2 - top))}px`; arrow.style.left = '';
      } else {
        arrow.style.left = `${Math.max(16, Math.min(pw - 16, a.left + a.width / 2 - left))}px`; arrow.style.top = '';
      }
    }
  }
}
