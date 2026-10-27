import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Start the documented local Pages preview before running this suite.
const base = process.env.SINGVAZA_TEST_URL || 'http://localhost:8788';
let browser;
const dummyWidget = `
  (() => {
    let nextId = 0;
    const widgets = new Map();
    function paint(record) {
      record.element.innerHTML = '';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Complete test security check';
      button.setAttribute('data-test-captcha', record.options.action);
      button.addEventListener('click', () => record.options.callback('XXXX.DUMMY.TOKEN.XXXX'));
      record.element.appendChild(button);
    }
    window.turnstile = {
      render(element, options) {
        if (typeof element === 'string') element = document.querySelector(element);
        const id = ++nextId;
        const record = { element, options };
        widgets.set(id, record);
        paint(record);
        return id;
      },
      reset(id) { if (widgets.has(id)) paint(widgets.get(id)); },
      remove(id) { const record = widgets.get(id); if (record) record.element.innerHTML = ''; widgets.delete(id); },
    };
  })();
`;

before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
after(async () => { await browser?.close(); });

async function newPage(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...opts });
  await context.route('https://challenges.cloudflare.com/turnstile/v0/api.js?*', (route) => route.fulfill({
    status: 200, contentType: 'application/javascript', body: dummyWidget,
  }));
  return { context, page: await context.newPage() };
}

async function enter(page) {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('#svEntryWidget [data-test-captcha="site_entry"]').waitFor();
  await page.locator('#svEntryWidget [data-test-captcha="site_entry"]').click();
  if (await page.locator('#svTermsBox').isVisible()) await page.locator('#svTermsAgree').check();
  await page.locator('#svEntryContinue').click();
  await page.waitForFunction(() => document.getElementById('svEntryGate')?.hidden === true);
}

test('entry requires both explicit agreement and verification, and remembers terms per browser', async () => {
  const { context, page } = await newPage();
  try {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    const gate = page.locator('#svEntryGate');
    await page.locator('#svEntryWidget [data-test-captcha="site_entry"]').waitFor();
    assert.equal(await gate.isVisible(), true);
    assert.equal(await page.locator('#svTermsAgree').isChecked(), false);
    assert.equal(await page.locator('#svEntryContinue').isDisabled(), true);
    await page.locator('#svEntryWidget [data-test-captcha="site_entry"]').click();
    assert.equal(await page.locator('#svEntryContinue').isDisabled(), true, 'verification alone must not imply consent');
    await page.locator('#svTermsAgree').check();
    assert.equal(await page.locator('#svEntryContinue').isEnabled(), true);
    await page.locator('#svEntryContinue').click();
    await page.waitForFunction(() => document.getElementById('svEntryGate')?.hidden === true);
    const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('singvaza_terms_accepted')));
    assert.equal(stored.version, '2026-10-27');
    assert.ok(stored.acceptedAt);
    assert.ok((await context.cookies()).some((cookie) => cookie.name === '__Host-sv_entry' && cookie.httpOnly && cookie.secure));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('svEntryGate')?.hidden === true);
    await context.clearCookies();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#svEntryWidget [data-test-captcha="site_entry"]').waitFor();
    assert.equal(await page.locator('#svTermsBox').isHidden(), true, 'consent persists after the session ends');
    await page.locator('#svEntryWidget [data-test-captcha="site_entry"]').click();
    await page.locator('#svEntryContinue').click();
    await page.waitForFunction(() => document.getElementById('svEntryGate')?.hidden === true);

    await page.evaluate(() => localStorage.setItem('singvaza_terms_accepted', JSON.stringify({ version: 'old', acceptedAt: '2020-01-01' })));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#svTermsAgree').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#svEntryCheck').isHidden(), true, 'a valid session does not need a second entry challenge');
    await page.locator('#svTermsAgree').check();
    await page.locator('#svEntryContinue').click();
    await page.waitForFunction(() => document.getElementById('svEntryGate')?.hidden === true);
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('singvaza_terms_accepted'))).version, '2026-10-27');
  } finally { await context.close(); }
});

test('email sign-in and sign-up require a separate challenge, including after failed attempts', async () => {
  const { context, page } = await newPage();
  try {
    await enter(page);
    await page.locator('#authTriggerBtn').click();
    const authCheck = page.locator('#authTurnstileMount [data-test-captcha="auth"]');
    await authCheck.waitFor();
    assert.equal(await page.locator('#authCredentialFields').isHidden(), true);
    await authCheck.click();
    assert.equal(await page.locator('#authCredentialFields').isVisible(), true);
    await page.locator('#tabLoginBtn').click();
    await page.locator('#authEmail').fill('does-not-exist@example.com');
    await page.locator('#authPassword').fill('test-password');
    const failedRequest = page.waitForResponse((response) => response.url().endsWith('/api/auth/login'));
    await page.locator('#authSubmitBtn').click();
    const failed = await failedRequest;
    assert.equal(failed.status(), 401);
    assert.equal(failed.request().postDataJSON().turnstileToken, 'XXXX.DUMMY.TOKEN.XXXX');
    await page.locator('#authCredentialFields').waitFor({ state: 'hidden' });
    await authCheck.waitFor({ state: 'visible' });
    await authCheck.click();
    await page.locator('#tabRegBtn').click();
    await page.locator('#authName').fill('Browser Test');
    await page.locator('#authEmail').fill(`sv-test-${Date.now()}@example.com`);
    await page.locator('#authPassword').fill('test-password');
    const registerRequest = page.waitForResponse((response) => response.url().endsWith('/api/auth/register'));
    await page.locator('#authSubmitBtn').click();
    const registered = await registerRequest;
    assert.equal(registered.status(), 200);
    assert.equal(registered.request().postDataJSON().turnstileToken, 'XXXX.DUMMY.TOKEN.XXXX');
    assert.equal((await registered.json()).ok, true);
    await page.locator('#authModal').waitFor({ state: 'hidden' });
  } finally { await context.close(); }
});

test('Google sign-in submits its own fresh challenge to the backend', async () => {
  const { context, page } = await newPage();
  try {
    await page.addInitScript(() => {
      window.google = { accounts: { id: {
        initialize(options) { window.__testGoogleCallback = options.callback; },
        renderButton(mount) {
          const button = document.createElement('button');
          button.type = 'button'; button.id = 'testGoogleSignIn'; button.textContent = 'Test Google sign-in';
          button.onclick = () => window.__testGoogleCallback({ credential: 'test-google-credential' });
          mount.replaceChildren(button);
        },
      } } };
    });
    await page.route('**/api/state', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ authenticated: false, projects: [], googleClientId: 'test-client-id' }),
    }));
    let captured = null;
    await page.route('**/api/auth/google', (route) => {
      captured = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, token: 'test-token', user: { display_name: 'Google Test', email: 'google-test@example.com' },
      }) });
    });
    await enter(page);
    await page.locator('#authTriggerBtn').click();
    await page.locator('#authTurnstileMount [data-test-captcha="auth"]').click();
    await page.locator('#testGoogleSignIn').click();
    await page.locator('#authModal').waitFor({ state: 'hidden' });
    assert.equal(captured.credential, 'test-google-credential');
    assert.equal(captured.turnstileToken, 'XXXX.DUMMY.TOKEN.XXXX');
  } finally { await context.close(); }
});

test('entry gate appears on public pages while terms and privacy remain readable', async () => {
  const { context, page } = await newPage({ viewport: { width: 320, height: 568 } });
  try {
    for (const path of ['/about', '/contact', '/blog', '/tools']) {
      await page.goto(base + path, { waitUntil: 'domcontentloaded' });
      await page.locator('#svEntryWidget [data-test-captcha="site_entry"]').waitFor();
      assert.equal(await page.locator('#svEntryGate').isVisible(), true, path);
    }
    for (const path of ['/terms', '/privacy']) {
      await page.goto(base + path, { waitUntil: 'domcontentloaded' });
      assert.equal(await page.locator('#svEntryGate').count(), 0, path);
    }
  } finally { await context.close(); }
});

test('expired entry session prompts again and safely retries the original request', async () => {
  const { context, page } = await newPage();
  try {
    await enter(page);
    await context.clearCookies();
    let calls = 0;
    page.on('request', (request) => { if (request.url().endsWith('/api/contact')) calls += 1; });
    const pending = page.evaluate(async () => {
      const res = await window.SingVazaGuard.fetch('/api/contact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Preview Test', email: 'test@example.com', subject: 'Test', message: 'Preview message' }),
      });
      return { status: res.status, body: await res.json() };
    });
    await page.locator('#svEntryWidget [data-test-captcha="site_entry"]').waitFor();
    assert.equal(await page.locator('#svTermsBox').isHidden(), true, 'already accepted terms should not be requested again');
    await page.locator('#svEntryWidget [data-test-captcha="site_entry"]').click();
    await page.locator('#svEntryContinue').click();
    const result = await pending;
    assert.equal(result.status, 200);
    assert.equal(result.body.received, true);
    assert.equal(calls, 2, 'request should be retried exactly once');
  } finally { await context.close(); }
});

test('a failed account deletion does not claim success or sign the user out', async () => {
  const { context, page } = await newPage();
  try {
    await enter(page);
    await page.locator('#authTriggerBtn').click();
    await page.locator('#authTurnstileMount [data-test-captcha="auth"]').click();
    await page.locator('#tabRegBtn').click();
    await page.locator('#authName').fill('Preview Tester');
    await page.locator('#authEmail').fill(`delete-${Date.now()}@example.com`);
    await page.locator('#authPassword').fill('not-a-real-password');
    await page.locator('#authSubmitBtn').click();
    await page.waitForFunction(() => Boolean(localStorage.getItem('singvaza_token')));
    await page.evaluate(() => App.openAuthModal());
    await page.route('**/api/auth/account', (route) => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Deletion unavailable.' }),
    }));
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Delete Account & Cloud Data' }).click();
    await page.locator('#toast').getByText('Deletion unavailable.').waitFor();
    assert.equal(await page.evaluate(() => Boolean(localStorage.getItem('singvaza_token'))), true);
    assert.equal(await page.locator('#authModal').evaluate((el) => el.classList.contains('open')), true);
  } finally { await context.close(); }
});

test('Google button appears if its client configuration arrives after the auth check', async () => {
  const { context, page } = await newPage();
  let releaseState;
  const stateGate = new Promise((resolve) => { releaseState = resolve; });
  try {
    await page.addInitScript(() => {
      window.google = { accounts: { id: {
        initialize() {},
        renderButton(mount) {
          const button = document.createElement('button');
          button.id = 'lateGoogleButton'; button.type = 'button'; button.textContent = 'Google';
          mount.replaceChildren(button);
        },
      } } };
    });
    await page.route('**/api/state', async (route) => {
      await stateGate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        authenticated: false, projects: [], googleClientId: 'late-google-client',
      }) });
    });
    await page.route('**/api/public-config', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await enter(page);
    await page.locator('#authTriggerBtn').click();
    await page.locator('#authTurnstileMount [data-test-captcha="auth"]').click();
    assert.equal(await page.locator('#authCredentialFields').isVisible(), true);
    assert.equal(await page.locator('#lateGoogleButton').count(), 0);
    releaseState();
    await page.locator('#lateGoogleButton').waitFor({ state: 'visible' });
  } finally {
    releaseState();
    await context.close();
  }
});
