import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function bundleModule(path) {
  const out = await build({ entryPoints: [path], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}
const security = await bundleModule('src/security.ts');
const worker = (await bundleModule('src/worker.ts')).default;
const origin = 'https://singvaza.pages.dev';
const env = { TURNSTILE_SITE_KEY: 'real-site-key', TURNSTILE_SECRET_KEY: 'example-real-secret' };
const request = (path, opts = {}) => new Request(origin + path, opts);

function mockVerify(t, result) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}

async function completeEntry(t) {
  const calls = mockVerify(t, { success: true, hostname: 'singvaza.pages.dev', action: 'site_entry' });
  const res = await security.handleSecurityRoute(request('/api/security/entry', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnstileToken: 'valid-entry-token' }),
  }), env);
  assert.equal(res.status, 200);
  assert.equal(calls[0].secret, env.TURNSTILE_SECRET_KEY);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-sv_entry=/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.doesNotMatch(setCookie, /Max-Age/);
  return setCookie.split(';')[0];
}

test('configuration fails closed when keys are missing or dummy keys are used in production', async () => {
  const missing = await security.handleSecurityRoute(request('/api/security/status'), {});
  assert.equal(missing.status, 503);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  const prodTest = await security.handleSecurityRoute(request('/api/security/status'), {
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    TURNSTILE_TEST_MODE: 'true',
  });
  assert.equal(prodTest.status, 503);
  const localTest = await security.handleSecurityRoute(new Request('http://localhost:8787/api/security/status'), {
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    TURNSTILE_TEST_MODE: 'true',
  });
  assert.equal(localTest.status, 200);
});

test('entry challenge is verified by Cloudflare and creates a signed session cookie', async (t) => {
  const before = await security.handleSecurityRoute(request('/api/security/status'), env);
  assert.deepEqual(await before.json(), { siteKey: 'real-site-key', entryVerified: false });
  const cookie = await completeEntry(t);
  const after = await security.handleSecurityRoute(request('/api/security/status', { headers: { Cookie: cookie } }), env);
  assert.equal((await after.json()).entryVerified, true);
  assert.equal(await security.hasValidEntrySession(request('/', { headers: { Cookie: cookie } }), 'different-secret'), false);
  const split = cookie.lastIndexOf('.') + 1;
  const first = cookie[split];
  const changed = cookie.slice(0, split) + (first === 'A' ? 'B' : 'A') + cookie.slice(split + 1);
  assert.equal(await security.hasValidEntrySession(request('/', { headers: { Cookie: changed } }), env.TURNSTILE_SECRET_KEY), false);
});

test('entry rejects absent, wrong-action, wrong-host and cross-origin challenges', async (t) => {
  const missing = await security.handleSecurityRoute(request('/api/security/entry', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }), env);
  assert.equal(missing.status, 400);
  const cross = await security.handleSecurityRoute(request('/api/security/entry', {
    method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnstileToken: 'token' }),
  }), env);
  assert.equal(cross.status, 403);
  mockVerify(t, { success: true, hostname: 'wrong.example', action: 'site_entry' });
  const wrongHost = await security.handleSecurityRoute(request('/api/security/entry', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turnstileToken: 'token' }),
  }), env);
  assert.equal(wrongHost.status, 403);
});

test('studio and authentication routes require an entry session', async () => {
  for (const path of ['/api/auth/login', '/api/auth/register', '/api/auth/google', '/api/search-karaoke', '/api/lyrics', '/api/contact', '/api/projects']) {
    assert.equal(security.requiresEntrySession(path, 'POST'), true, path);
    const result = await security.requireEntrySession(request(path, { method: 'POST' }), env);
    assert.equal(result.status, 403, path);
  }
  assert.equal(security.requiresEntrySession('/api/public-config', 'GET'), false);
  assert.equal(security.requiresEntrySession('/api/admin/login', 'POST'), false);
});

test('authentication requires a fresh auth-purpose token, checked on the server', async (t) => {
  const calls = mockVerify(t, { success: true, hostname: 'singvaza.pages.dev', action: 'site_entry' });
  const bad = await security.requireAuthChallenge(request('/api/auth/login', { method: 'POST' }), env, 'entry-token');
  assert.equal(bad.status, 403);
  assert.equal(calls[0].response, 'entry-token');
});

test('worker rejects direct login and registration without a verified entry session', async () => {
  for (const path of ['/api/auth/login', '/api/auth/register', '/api/auth/google']) {
    const response = await worker.fetch(request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'test', credential: 'test' }),
    }), env);
    assert.equal(response.status, 403, path);
  }
});

test('worker rejects auth without its separate challenge even after entry verification', async (t) => {
  const cookie = await completeEntry(t);
  for (const path of ['/api/auth/login', '/api/auth/register', '/api/auth/google']) {
    const response = await worker.fetch(request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email: 'test@example.com', password: 'test', credential: 'test' }),
    }), env);
    assert.equal(response.status, 400, path);
    assert.match((await response.json()).error, /security check/i);
  }
});

test('site verification rejects Cloudflare failure and service/network errors without setting cookies', async (t) => {
  const replies = [
    new Response(JSON.stringify({ success: false, 'error-codes': ['timeout-or-duplicate'] }), { status: 200 }),
    new Response('down', { status: 503 }),
  ];
  t.mock.method(globalThis, 'fetch', async () => {
    if (replies.length) return replies.shift();
    throw new Error('network failure');
  });
  for (const expected of [403, 503, 503]) {
    const result = await security.handleSecurityRoute(request('/api/security/entry', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnstileToken: 'some-token' }),
    }), env);
    assert.equal(result.status, expected);
    assert.equal(result.headers.get('set-cookie'), null);
  }
});

test('security status never exposes the server-side secret', async () => {
  const result = await security.handleSecurityRoute(request('/api/security/status'), env);
  const body = await result.text();
  assert.ok(body.includes(env.TURNSTILE_SITE_KEY));
  assert.equal(body.includes(env.TURNSTILE_SECRET_KEY), false);
});

test('standalone blog and tool HTML also receives the visitor gate', async () => {
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async run() { return {}; },
        async all() { return { results: [] }; },
        async first() {
          if (sql.includes('SELECT * FROM html_tools WHERE slug')) {
            return { id: 'test-tool', slug: 'test-tool', title: 'Test Tool', html_code: '<!DOCTYPE html><HTML><HEAD></HEAD><BODY>Tool</BODY></HTML>' };
          }
          if (sql.includes('SELECT * FROM blog_posts WHERE slug')) {
            return { id: 'test-post', slug: 'test-post', title: 'Test Post', content_format: 'full_html', content: '<html><BODY>Article</BODY></html>' };
          }
          return null;
        },
      };
    },
  };
  for (const path of ['/tools/test-tool', '/blog/test-post']) {
    const res = await worker.fetch(request(path), { ...env, DB: db });
    assert.equal(res.status, 200, path);
    const html = await res.text();
    assert.match(html, /\/guard\.js\?v=1/, path);
    assert.match(html, /\/guard\.css\?v=1/, path);
  }
});
