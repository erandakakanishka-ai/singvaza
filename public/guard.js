/* SingVaza entry consent and Cloudflare Turnstile integration. */
(() => {
  'use strict';
  if (window.SingVazaGuard) return;

  // Increase this version whenever /terms is materially updated; returning
  // visitors will then be asked to accept the updated terms again.
  const TERMS_VERSION = '2026-10-22';
  const TERMS_STORAGE_KEY = 'singvaza_terms_accepted';
  const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  let termsAcceptedInMemory = false;
  let config = null;
  let overlay = null;
  let entryWidget = null;
  let entryToken = '';
  let scriptPromise = null;
  let gateGeneration = 0;
  let restorePage = null;
  let previouslyFocused = null;
  let resolveReady;
  let initialReady = false;
  let refreshPromise = null;
  let resolveRefresh = null;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const auth = { generation: 0, widget: null, token: '', container: null, onChange: null };

  function acceptedTerms() {
    if (termsAcceptedInMemory) return true;
    try {
      const saved = JSON.parse(localStorage.getItem(TERMS_STORAGE_KEY) || 'null');
      return Boolean(saved && saved.version === TERMS_VERSION && saved.acceptedAt);
    } catch (_) { return false; }
  }

  function saveTermsAcceptance() {
    termsAcceptedInMemory = true;
    try {
      localStorage.setItem(TERMS_STORAGE_KEY, JSON.stringify({ version: TERMS_VERSION, acceptedAt: new Date().toISOString() }));
    } catch (_) {
      // Storage can be disabled (for example in private browsing). The visitor
      // can still continue, but will be asked again on a future visit.
    }
  }

  function loadTurnstile() {
    if (window.turnstile && typeof window.turnstile.render === 'function') return Promise.resolve(window.turnstile);
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_URL;
      script.async = true;
      script.defer = true;
      let settled = false;
      const timer = window.setTimeout(() => finish(false), 15000);
      function finish(success) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (success && window.turnstile && typeof window.turnstile.render === 'function') {
          resolve(window.turnstile);
        } else {
          script.remove();
          reject(new Error('The Cloudflare security check could not load.'));
        }
      }
      script.onload = () => finish(true);
      script.onerror = () => finish(false);
      document.head.appendChild(script);
    }).catch((error) => { scriptPromise = null; throw error; });
    return scriptPromise;
  }

  function makeOverlay() {
    if (overlay) return overlay;
    const el = document.createElement('div');
    el.className = 'sv-gate';
    el.id = 'svEntryGate';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'svGateTitle');
    el.setAttribute('aria-describedby', 'svGateDescription');
    el.innerHTML = `
      <div class="sv-gate-card" tabindex="-1">
        <div class="sv-gate-brand">
          <img class="sv-gate-logo" src="/assets/logo.png" alt="" />
          <div class="sv-gate-wordmark">SING<span>VAZA</span></div>
        </div>
        <div class="sv-gate-eyebrow">A safer space to create</div>
        <h1 class="sv-gate-title" id="svGateTitle">Welcome to SingVaza</h1>
        <p class="sv-gate-description" id="svGateDescription">Please review our terms and complete the security check before entering the studio.</p>
        <label class="sv-terms-box" id="svTermsBox" hidden>
          <input type="checkbox" id="svTermsAgree" />
          <span>I have read and agree to the <a href="/terms" target="_blank" rel="noopener noreferrer">Terms &amp; Conditions</a>. Read our <a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.</span>
        </label>
        <div id="svEntryCheck" hidden>
          <p class="sv-check-label">Verify you are human</p>
          <div class="sv-turnstile" id="svEntryWidget"></div>
        </div>
        <p class="sv-status" id="svEntryStatus" role="status" aria-live="polite">Preparing the security check…</p>
        <button type="button" class="sv-gate-retry" id="svEntryRetry" hidden>Try again</button>
        <button type="button" class="sv-gate-primary" id="svEntryContinue" disabled>Continue to SingVaza</button>
        <p class="sv-gate-foot">Security check by Cloudflare. Your terms choice is saved in this browser.</p>
        <a class="sv-gate-exit" href="about:blank">Leave website</a>
      </div>`;
    document.body.appendChild(el);
    overlay = el;

    el.querySelector('#svTermsAgree').addEventListener('change', updateContinue);
    el.querySelector('#svEntryContinue').addEventListener('click', submitEntry);
    el.querySelector('#svEntryRetry').addEventListener('click', () => { startGate(); });
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab' || el.hidden) return;
      const items = Array.from(el.querySelectorAll('a[href], input:not([disabled]), button:not([disabled]), iframe'))
        .filter((node) => node.getClientRects().length > 0);
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    });
    return el;
  }

  function showOverlay() {
    const el = makeOverlay();
    el.hidden = false;
    if (!restorePage) {
      previouslyFocused = document.activeElement;
      const oldOverflow = document.body.style.overflow;
      const altered = [];
      for (const child of Array.from(document.body.children)) {
        if (child !== el && 'inert' in child) {
          altered.push([child, child.inert]);
          child.inert = true;
        }
      }
      document.body.style.overflow = 'hidden';
      el.querySelector('.sv-gate-card').focus();
      restorePage = () => {
        document.body.style.overflow = oldOverflow;
        for (const [child, wasInert] of altered) child.inert = wasInert;
      };
    }
  }

  function closeOverlay() {
    if (overlay) overlay.hidden = true;
    if (restorePage) { restorePage(); restorePage = null; }
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      try { previouslyFocused.focus(); } catch (_) {}
    }
    if (!initialReady) { initialReady = true; resolveReady(); }
    if (resolveRefresh) {
      const done = resolveRefresh;
      resolveRefresh = null;
      refreshPromise = null;
      done();
    }
  }

  function setEntryStatus(message, error = false) {
    if (!overlay) return;
    const status = overlay.querySelector('#svEntryStatus');
    status.textContent = message || '';
    status.classList.toggle('is-error', error);
    overlay.querySelector('#svEntryRetry').hidden = !error;
  }

  function updateContinue() {
    if (!overlay) return;
    const agreed = acceptedTerms() || overlay.querySelector('#svTermsAgree').checked;
    const verified = Boolean(config && (config.entryVerified || entryToken));
    overlay.querySelector('#svEntryContinue').disabled = !(agreed && verified);
  }

  function removeEntryWidget() {
    if (entryWidget !== null && window.turnstile && typeof window.turnstile.remove === 'function') {
      try { window.turnstile.remove(entryWidget); } catch (_) {}
    }
    entryWidget = null;
    entryToken = '';
    const mount = overlay && overlay.querySelector('#svEntryWidget');
    if (mount) mount.innerHTML = '';
  }

  async function startGate() {
    showOverlay();
    const generation = ++gateGeneration;
    removeEntryWidget();
    config = null;
    overlay.querySelector('#svEntryCheck').hidden = true;
    overlay.querySelector('#svTermsBox').hidden = acceptedTerms();
    overlay.querySelector('#svEntryContinue').disabled = true;
    setEntryStatus('Preparing the security check…');

    try {
      const response = await fetch('/api/security/status', { cache: 'no-store', credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));
      if (generation !== gateGeneration) return;
      if (!response.ok || !data.siteKey) throw new Error(data.error || 'The security check is temporarily unavailable.');
      config = { siteKey: data.siteKey, entryVerified: Boolean(data.entryVerified) };

      if (config.entryVerified && acceptedTerms()) { closeOverlay(); return; }
      const needTerms = !acceptedTerms();
      overlay.querySelector('#svTermsBox').hidden = !needTerms;
      overlay.querySelector('#svGateDescription').textContent = needTerms
        ? 'Please review our terms and complete any security check before entering the studio.'
        : 'Please complete the Cloudflare security check before entering the studio.';
      overlay.querySelector('#svEntryContinue').textContent = needTerms ? 'Agree & continue' : 'Continue to SingVaza';

      if (config.entryVerified) {
        setEntryStatus('');
        updateContinue();
        const checkbox = overlay.querySelector('#svTermsAgree');
        if (needTerms) checkbox.focus();
        return;
      }

      overlay.querySelector('#svEntryCheck').hidden = false;
      setEntryStatus('Loading Cloudflare security check…');
      const turnstile = await loadTurnstile();
      if (generation !== gateGeneration) return;
      const entryMount = overlay.querySelector('#svEntryWidget');
      entryWidget = turnstile.render(entryMount, {
        sitekey: config.siteKey,
        action: 'site_entry',
        theme: 'dark',
        size: entryMount.clientWidth < 300 ? 'compact' : 'flexible',
        callback: (token) => {
          if (generation !== gateGeneration) return;
          entryToken = token;
          setEntryStatus('Security check complete.');
          updateContinue();
        },
        'expired-callback': () => {
          if (generation !== gateGeneration) return;
          entryToken = '';
          setEntryStatus('Security check expired. Please try again.', true);
          updateContinue();
        },
        'error-callback': () => {
          if (generation !== gateGeneration) return true;
          entryToken = '';
          setEntryStatus('Security check could not load. Please try again.', true);
          updateContinue();
          return true;
        },
      });
      if (needTerms) overlay.querySelector('#svTermsAgree').focus();
      updateContinue();
    } catch (error) {
      if (generation !== gateGeneration) return;
      setEntryStatus(error && error.message ? error.message : 'Security check is temporarily unavailable.', true);
      updateContinue();
    }
  }

  async function submitEntry() {
    if (!config || !overlay) return;
    const mustAgree = !acceptedTerms();
    if (mustAgree && !overlay.querySelector('#svTermsAgree').checked) return;
    const button = overlay.querySelector('#svEntryContinue');
    if (!config.entryVerified) {
      if (!entryToken) return;
      const token = entryToken;
      entryToken = '';
      button.disabled = true;
      setEntryStatus('Verifying with Cloudflare…');
      try {
        const response = await fetch('/api/security/entry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ turnstileToken: token }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || 'Security check failed. Please try again.');
        config.entryVerified = true;
      } catch (error) {
        setEntryStatus(error && error.message ? error.message : 'Security check failed. Please try again.', true);
        if (entryWidget !== null && window.turnstile) {
          try { window.turnstile.reset(entryWidget); } catch (_) {}
        }
        updateContinue();
        return;
      }
    }
    if (mustAgree) saveTermsAcceptance();
    removeEntryWidget();
    closeOverlay();
  }

  function unmountAuth() {
    auth.generation += 1;
    if (auth.widget !== null && window.turnstile && typeof window.turnstile.remove === 'function') {
      try { window.turnstile.remove(auth.widget); } catch (_) {}
    }
    if (auth.container) auth.container.innerHTML = '';
    auth.widget = null;
    auth.token = '';
    auth.container = null;
    auth.onChange = null;
  }

  async function mountAuth(container, onChange) {
    unmountAuth();
    const generation = auth.generation;
    auth.container = container;
    auth.onChange = onChange;
    if (!container) throw new Error('Security check is unavailable.');
    if (onChange) onChange('', 'Loading Cloudflare security check…');
    await ready;
    const turnstile = await loadTurnstile();
    if (generation !== auth.generation) return;
    if (!config || !config.siteKey) throw new Error('Security check is not configured.');
    auth.widget = turnstile.render(container, {
      sitekey: config.siteKey,
      action: 'auth',
      theme: 'dark',
      size: container.clientWidth < 300 ? 'compact' : 'flexible',
      callback: (token) => {
        if (generation !== auth.generation) return;
        auth.token = token;
        if (auth.onChange) auth.onChange(token, 'Security check complete.');
      },
      'expired-callback': () => {
        if (generation !== auth.generation) return;
        auth.token = '';
        if (auth.onChange) auth.onChange('', 'Security check expired. Please try again.', true);
      },
      'error-callback': () => {
        if (generation !== auth.generation) return true;
        auth.token = '';
        if (auth.onChange) auth.onChange('', 'Security check could not load. Please try again.', true);
        return true;
      },
    });
  }

  function takeAuthToken() {
    const token = auth.token;
    auth.token = '';
    if (auth.onChange) auth.onChange('', token ? 'Checking your sign-in…' : 'Complete the security check first.');
    return token;
  }

  function resetAuth() {
    auth.token = '';
    if (auth.onChange) auth.onChange('', 'Please complete a new security check.');
    if (auth.widget !== null && window.turnstile) {
      try { window.turnstile.reset(auth.widget); return; } catch (_) {}
    }
    if (auth.container && auth.onChange) mountAuth(auth.container, auth.onChange).catch(() => {});
  }

  function recheck() {
    if (!refreshPromise) {
      refreshPromise = new Promise((resolve) => { resolveRefresh = resolve; });
      startGate();
    }
    return refreshPromise;
  }

  // A visitor may keep a studio tab open longer than the 12-hour session.
  // If it expires, complete the entry challenge again and retry once without
  // losing the user's form input or current mix.
  async function guardedFetch(input, options) {
    const response = await fetch(input, options);
    if (response.status !== 403) return response;
    let detail;
    try { detail = await response.clone().json(); } catch (_) { return response; }
    if (detail?.code !== 'ENTRY_REQUIRED') return response;
    await recheck();
    return fetch(input, options);
  }

  window.SingVazaGuard = { ready, mountAuth, unmountAuth, takeAuthToken, resetAuth, recheck, fetch: guardedFetch };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startGate, { once: true });
  else startGate();
})();
