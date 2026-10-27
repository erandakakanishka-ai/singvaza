import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// EXPLICITLY local-only: this suite writes disposable fixtures to Miniflare.
// Set SINGVAZA_LOCAL_PERSIST to the same local persistence directory as pages dev.
const base = process.env.SINGVAZA_TEST_URL || 'http://localhost:8788';
const persist = process.env.SINGVAZA_LOCAL_PERSIST;
if (!persist || !['localhost', '127.0.0.1', '::1'].includes(new URL(base).hostname)) {
  throw new Error('Integration tests require a loopback SINGVAZA_TEST_URL and an explicit local SINGVAZA_LOCAL_PERSIST directory.');
}
const id = randomUUID().replaceAll('-', '');
const adminToken = `local-admin-${id}`, freeToken = `local-free-${id}`, proToken = `local-pro-${id}`;
const freeId = `local-free-${id}`, proId = `local-pro-${id}`;
const toolId = `local-tool-${id}`, blogId = `local-blog-${id}`;
const toolSlug = `local-rhythm-tool-${id}`, blogSlug = `local-rhythm-guide-${id}`;
let browser, context, page, oldLimit;
function db(sql) {
  const output = execFileSync('./node_modules/.bin/wrangler', ['d1', 'execute', 'karomix-db', '--local', '--persist-to', resolve(persist), '--command', sql, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(output);
}
async function req(path, opts = {}) {
  return page.evaluate(async ({ path, opts }) => {
    const response = await fetch(path, opts); const text = await response.text();
    try { return { status: response.status, body: JSON.parse(text) }; } catch { return { status: response.status, body: text }; }
  }, { path, opts });
}
const auth = token => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const widget = `window.turnstile={render(el,o){if(typeof el==='string')el=document.querySelector(el);const b=document.createElement('button');b.textContent='Verify test';b.dataset.testCaptcha=o.action;b.onclick=()=>o.callback('XXXX.DUMMY.TOKEN.XXXX');el.appendChild(b);return 1},reset(){},remove(){}}`;

before(async () => {
  // Causes local schema setup, then reads/writes ONLY through wrangler --local.
  const probe = await fetch(base + '/api/state'); assert.equal(probe.status, 200);
  const settings = db("SELECT v FROM site_settings WHERE k='daily_free_limit'");
  oldLimit = settings[0]?.results?.[0]?.v ?? null;
  db(`INSERT INTO site_settings(k,v) VALUES('daily_free_limit','9') ON CONFLICT(k) DO UPDATE SET v='9';
      INSERT INTO admin_sessions(token,username,expires_at) VALUES('${adminToken}','local-test',${Date.now() + 3600000});
      INSERT INTO users(id,email,display_name,plan,pro_until,daily_date,daily_exports) VALUES('${freeId}','${freeId}@example.invalid','Local Free','free',0,'',0);
      INSERT INTO users(id,email,display_name,plan,pro_until,daily_date,daily_exports) VALUES('${proId}','${proId}@example.invalid','Local Pro','pro_global',0,'',0);
      INSERT INTO sessions(token,user_id) VALUES('${freeToken}','${freeId}');
      INSERT INTO sessions(token,user_id) VALUES('${proToken}','${proId}');`);
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('https://challenges.cloudflare.com/turnstile/v0/api.js?*', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: widget }));
  page = await context.newPage();
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('#svEntryWidget [data-test-captcha="site_entry"]').click();
  if (await page.locator('#svTermsBox').isVisible()) await page.locator('#svTermsAgree').check();
  await page.locator('#svEntryContinue').click();
  await page.waitForFunction(() => document.getElementById('svEntryGate')?.hidden === true);
});
after(async () => {
  await browser?.close();
  // Restore the previous local setting and delete every disposable fixture.
  const restore = oldLimit == null ? "DELETE FROM site_settings WHERE k='daily_free_limit';" : `UPDATE site_settings SET v='${String(oldLimit).replaceAll("'", "''")}' WHERE k='daily_free_limit';`;
  db(`${restore} DELETE FROM html_tools WHERE id='${toolId}'; DELETE FROM blog_posts WHERE id='${blogId}'; DELETE FROM sessions WHERE user_id IN ('${freeId}','${proId}'); DELETE FROM users WHERE id IN ('${freeId}','${proId}'); DELETE FROM admin_sessions WHERE token='${adminToken}';`);
});

test('local admin publishes separate standalone tools and blogs that appear in discovery and retain Home navigation', async () => {
  const tool = await req('/api/tools', { method: 'POST', headers: auth(adminToken), body: JSON.stringify({ id: toolId, slug: toolSlug, title: 'Rhythm local tuner', category: 'Music', description: 'Tune a rhythm track', seo_tags: 'rhythm tempo', html_code: '<!doctype html><html><head><title>Test Tool</title></head><body><h1>Test tool body</h1></body></html>' }) });
  assert.equal(tool.status, 200, JSON.stringify(tool.body));
  const blog = await req('/api/blog', { method: 'POST', headers: auth(adminToken), body: JSON.stringify({ id: blogId, slug: blogSlug, title: 'Rhythm local guide', category: 'Guide', excerpt: 'A rhythm article', seo_tags: 'rhythm tempo', content_format: 'full_html', content: '<!doctype html><html><head><title>Test Article</title></head><body><h1>Test article body</h1></body></html>' }) });
  assert.equal(blog.status, 200, JSON.stringify(blog.body));
  const summaryTools = await req('/api/tools?summary=1');
  const summaryBlogs = await req('/api/blog?summary=1');
  const t = summaryTools.body.tools.find(x => x.id === toolId), b = summaryBlogs.body.posts.find(x => x.id === blogId);
  assert.ok(t); assert.ok(b); assert.equal('html_code' in t, false); assert.equal('content' in b, false);
  const fullTools = await req('/api/tools'); assert.ok(fullTools.body.tools.find(x => x.id === toolId)?.html_code);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('svEntryGate')?.hidden === true);
  await page.locator(`a[href="/tools/${toolSlug}"]`).waitFor();
  await page.locator('#siteSearch').fill('rhythm');
  assert.equal(await page.locator(`a[href="/tools/${toolSlug}"]`).isVisible(), true);
  assert.equal(await page.locator(`#homeBlogPreview a[href="/blog/${blogSlug}"]`).isVisible(), true);
  for (const path of [`/tools/${toolSlug}`, `/blog/${blogSlug}`]) {
    const output = await req(path);
    assert.equal(output.status, 200);
    assert.match(output.body, /aria-label="SingVaza navigation"/);
    assert.match(output.body, /href="\/"/);
    assert.match(output.body, /guard\.js/);
  }
  const adminHtml = await req('/admin.html');
  assert.match(adminHtml.body, /data-tab="blog"/);
  assert.match(adminHtml.body, /data-tab="tools"/);
  assert.match(adminHtml.body, /Only upload HTML you trust/);
  await page.evaluate(token => localStorage.setItem('singvaza_admin_token', token), adminToken);
  await page.goto(base + '/admin.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#adminShell.active').waitFor();
  await page.locator('.nav-mob[data-tab="tools"]').click();
  assert.equal(await page.locator('#toolTitle').isVisible(), true);
  assert.equal(await page.locator('#toolHtmlCode').isVisible(), true);
  await page.locator('.nav-mob[data-tab="blog"]').click();
  assert.equal(await page.locator('#blogTitle').isVisible(), true);
  assert.equal(await page.locator('#tab-blog').isVisible(), true);
  await page.evaluate(() => localStorage.removeItem('singvaza_admin_token'));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('svEntryGate')?.hidden === true);
  assert.equal((await req(`/api/tools/${toolId}`, { method: 'DELETE', headers: auth(adminToken) })).status, 200);
  assert.equal((await req(`/api/blog/${blogId}`, { method: 'DELETE', headers: auth(adminToken) })).status, 200);
  assert.equal((await req('/api/tools?summary=1')).body.tools.some(x => x.id === toolId), false);
  assert.equal((await req('/api/blog?summary=1')).body.posts.some(x => x.id === blogId), false);
});

test('authenticated free allowance is atomic and configurable; Pro remains unlimited', async () => {
  const state = await req('/api/state', { headers: auth(freeToken) });
  assert.equal(state.body.authenticated, true);
  assert.equal(state.body.quota.dailyLimit, 9);
  const day = state.body.quota.localDate;
  db(`UPDATE users SET daily_date='${day}',daily_exports=8 WHERE id='${freeId}'; UPDATE users SET daily_date='${day}',daily_exports=9 WHERE id='${proId}';`);
  const race = await page.evaluate(async (token) => Promise.all([1, 2].map(async () => {
    const r = await fetch('/api/track-export', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, data: await r.json() };
  })), freeToken);
  assert.deepEqual(race.map(x => x.status).sort(), [200, 429]);
  assert.equal(race.find(x => x.status === 200).data.quota.dailyLimit, 9);
  const invalid = await req('/api/track-export', { method: 'POST', headers: auth('expired-local-session') });
  assert.equal(invalid.status, 401);
  for (let i = 0; i < 2; i++) {
    const response = await req('/api/track-export', { method: 'POST', headers: auth(proToken) });
    assert.equal(response.status, 200); assert.equal(response.body.quota.proActive, true);
  }
  const proState = await req('/api/state', { headers: auth(proToken) });
  assert.equal(proState.body.quota.dailyUsed, 11);
  db(`UPDATE site_settings SET v='4' WHERE k='daily_free_limit'; UPDATE users SET daily_date='${day}',daily_exports=3 WHERE id='${freeId}';`);
  const customState = await req('/api/state', { headers: auth(freeToken) });
  assert.equal(customState.body.quota.dailyLimit, 4);
  assert.equal((await req('/api/track-export', { method: 'POST', headers: auth(freeToken) })).status, 200);
  const blocked = await req('/api/track-export', { method: 'POST', headers: auth(freeToken) });
  assert.equal(blocked.status, 429); assert.equal(blocked.body.quota.dailyLimit, 4);
  db("UPDATE site_settings SET v='9' WHERE k='daily_free_limit'");
});

function stereoWav() {
  const sr = 16000, n = sr, out = Buffer.alloc(44 + n * 4);
  out.write('RIFF', 0); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22); out.writeUInt32LE(sr, 24);
  out.writeUInt32LE(sr * 4, 28); out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const c = .30 * Math.sin(2 * Math.PI * 440 * i / sr), side = .12 * Math.sin(2 * Math.PI * 700 * i / sr);
    out.writeInt16LE(Math.round((c + side) * 32767), 44 + i * 4); out.writeInt16LE(Math.round((c - side) * 32767), 46 + i * 4);
  }
  return out;
}

test('signed-in recorder and remover charge the same D1 counter and fail closed if tracking fails', async () => {
  const q = await req('/api/state', { headers: auth(freeToken) });
  db(`UPDATE users SET daily_date='${q.body.quota.localDate}',daily_exports=0,plan='free',pro_until=0 WHERE id='${freeId}';`);
  await page.evaluate(token => localStorage.setItem('singvaza_token', token), freeToken);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('topPlanBadge').textContent === '0/9 Free');
  await page.locator('#homeVocalRemover').click();
  await page.locator('#vocalRemoverFileInput').setInputFiles({ name: 'auth-song.wav', mimeType: 'audio/wav', buffer: stereoWav() });
  await page.waitForFunction(() => document.getElementById('vocalRemoverStatus').textContent.startsWith('Ready:'));
  await page.locator('#btnKaraokeCut').click();
  await page.waitForFunction(() => document.getElementById('btnKaraokeCut').getAttribute('aria-pressed') === 'true');
  let download = page.waitForEvent('download'); await page.locator('#btnDownloadKaraoke').click(); await download;
  assert.equal(await page.locator('#topPlanBadge').innerText(), '1/9 Free');
  await page.locator('#btnUseKaraoke').click(); await page.locator('#btnGoToMix').click();
  await page.evaluate(() => { window.SingVazaDSP.renderMasterAudio = async () => ({ blob: new Blob(['master'], { type: 'audio/wav' }), mime: 'audio/wav', ext: 'wav' }); });
  download = page.waitForEvent('download'); await page.locator('#btnRenderMaster').click(); await download;
  assert.equal(await page.locator('#topPlanBadge').innerText(), '2/9 Free');
  assert.equal((await req('/api/state', { headers: auth(freeToken) })).body.quota.dailyUsed, 2);
  await page.evaluate(() => App.openVocalRemover());
  await context.route('**/api/track-export', (route) => route.fulfill({ status: 503, json: { error: 'Temporary quota service outage' } }));
  let issued = 0; const onDownload = () => { issued++; }; page.on('download', onDownload);
  await page.locator('#btnDownloadKaraoke').click();
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Temporary quota service outage'));
  assert.equal(issued, 0);
  page.off('download', onDownload); await context.unroute('**/api/track-export');
  assert.equal((await req('/api/state', { headers: auth(freeToken) })).body.quota.dailyUsed, 2);
  db("UPDATE site_settings SET v='4' WHERE k='daily_free_limit'");
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('topPlanBadge').textContent === '2/4 Free');
  assert.equal(await page.locator('#view-vocal-remover .daily-limit-value').innerText(), '4');
  db("UPDATE site_settings SET v='9' WHERE k='daily_free_limit'");
  await page.evaluate(() => localStorage.removeItem('singvaza_token'));
});
