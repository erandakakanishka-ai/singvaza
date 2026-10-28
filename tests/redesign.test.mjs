import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Use only the isolated local Pages/Worker preview with Cloudflare test keys.
const base = process.env.SINGVAZA_TEST_URL || 'http://localhost:8788';
const widget = `window.turnstile={render(el,o){if(typeof el==='string')el=document.querySelector(el);const b=document.createElement('button');b.textContent='Verify test';b.dataset.testCaptcha=o.action;b.onclick=()=>o.callback('XXXX.DUMMY.TOKEN.XXXX');el.appendChild(b);return 1},reset(){},remove(){}}`;
let browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
after(async () => { await browser?.close(); });

async function pageFor(width = 390, installRoutes = null) {
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 1000 }, acceptDownloads: true });
  await context.route('https://challenges.cloudflare.com/turnstile/v0/api.js?*', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: widget }));
  // Keep the 29 MB MDX model out of CI. The worker then reports its offline
  // centre-reduction fallback, which still exercises the whole download flow.
  await context.route('https://huggingface.co/**/UVR_MDXNET_KARA.onnx', r => r.fulfill({ status: 503, body: 'offline in tests' }));
  if (installRoutes) await installRoutes(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('#svEntryWidget [data-test-captcha="site_entry"]').click();
  if (await page.locator('#svTermsBox').isVisible()) await page.locator('#svTermsAgree').check();
  await page.locator('#svEntryContinue').click();
  await page.waitForFunction(() => document.getElementById('svEntryGate')?.hidden === true);
  return { context, page, errors };
}
function stereoWav() {
  const sr = 16000, n = sr, out = Buffer.alloc(44 + n * 4);
  out.write('RIFF', 0); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22);
  out.writeUInt32LE(sr, 24); out.writeUInt32LE(sr * 4, 28); out.writeUInt16LE(4, 32);
  out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(out.length - 44, 40);
  for (let i = 0; i < n; i++) {
    const c = .32 * Math.sin(2 * Math.PI * 440 * i / sr), side = .14 * Math.sin(2 * Math.PI * 700 * i / sr);
    out.writeInt16LE(Math.round((c + side) * 32767), 44 + i * 4);
    out.writeInt16LE(Math.round((c - side) * 32767), 46 + i * 4);
  }
  return out;
}

test('built-in tools have separate shareable URLs, home navigation and history on phone/tablet/desktop', async () => {
  for (const width of [320, 390, 768, 1440]) {
    const { context, page, errors } = await pageFor(width);
    try {
      assert.equal(await page.locator('#homeVocalRemover').isVisible(), true);
      assert.equal(await page.locator('#homeRecorder').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      for (const selector of ['#btnMenuDrawer', '#topPlanBadge', '#authTriggerBtn']) {
        const fits = await page.locator(selector).evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
        assert.equal(fits, true, `${width}: ${selector} is not clipped`);
      }
      await page.locator('#homeRecorder').click();
      assert.match(page.url(), /\/studio\/karaoke-recorder$/);
      assert.equal(await page.locator('#recorderMakeKaraoke').isVisible(), true);
      await page.locator('#recorderMakeKaraoke').click();
      assert.match(page.url(), /\/studio\/vocal-remover$/);
      assert.equal(await page.locator('#view-vocal-remover #vocalRemoverPanel').isVisible(), true);
      assert.equal(await page.locator('#view-mix #vocalRemoverPanel').count(), 0);
      await page.goBack();
      assert.equal(await page.locator('#view-sing').isVisible(), true);
      await page.goForward();
      assert.equal(await page.locator('#view-vocal-remover').isVisible(), true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.getElementById('svEntryGate')?.hidden === true);
      assert.equal(await page.title(), 'Vocal Remover — Make Karaoke Online | SingVaza');
      assert.equal(await page.locator('#view-vocal-remover').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('#view-vocal-remover .breadcrumbs a').first().click();
      assert.equal(await page.locator('#view-home').isVisible(), true);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test('the directory automatically discovers published tools and blogs and searches both safely', async () => {
  const fixture = async (context) => {
    await context.route('**/api/tools?summary=1', (r) => r.fulfill({ json: { tools: [
      { id: 'test-tuner', slug: 'rhythm-tuner', title: 'Rhythm Tuner', category: 'Music', icon: '🎵', description: 'Adjust a beat', seo_tags: 'tempo rhythm' },
      { id: 'danger', slug: 'safe-slug', title: '<img src=x onerror=alert(1)>', category: 'Tools', description: 'Safe title rendering' },
    ] } }));
    await context.route('**/api/blog?summary=1', (r) => r.fulfill({ json: { posts: [
      { id: 'test-guide', slug: 'rhythm-guide', title: 'Rhythm guide', category: 'Guide', excerpt: 'Discover a steady beat', seo_tags: 'tempo' },
    ] } }));
  };
  const { context, page, errors } = await pageFor(390, fixture);
  try {
    await page.getByRole('link', { name: /Rhythm Tuner/ }).waitFor();
    assert.equal(await page.locator('#toolCount').innerText(), '4 tools');
    assert.equal(await page.locator('#homeBlogPreview a').count(), 1);
    assert.equal(await page.locator('#toolCards img').count(), 0, 'HTML in a title is rendered as text');
    await page.locator('#siteSearch').fill('rhythm');
    assert.equal(await page.getByRole('link', { name: /Rhythm Tuner/ }).isVisible(), true);
    assert.equal(await page.getByRole('link', { name: /Rhythm guide/ }).isVisible(), true);
    assert.equal(await page.locator('#homeVocalRemover').isHidden(), true);
    assert.equal(await page.locator('#toolCards a[href="/tools/rhythm-tuner"]').count(), 1);
    assert.equal(await page.locator('#homeBlogPreview a[href="/blog/rhythm-guide"]').count(), 1);
    await page.locator('#siteSearch').fill('zzzxxyynotfound');
    assert.match(await page.locator('#discoveryStatus').innerText(), /0 results/);
    await page.locator('.mobile-bottom-nav [data-view="blog"]').click();
    assert.equal(await page.getByRole('link', { name: /Rhythm guide/ }).isVisible(), true);
    await page.locator('#blogSearch').fill('tempo');
    await page.locator('#blogSearch').press('Enter');
    assert.equal(await page.locator('#view-home').isVisible(), true);
    assert.equal(await page.getByRole('link', { name: /Rhythm Tuner/ }).isVisible(), true);
    assert.equal(await page.getByRole('link', { name: /Rhythm guide/ }).isVisible(), true);
    await page.goto(base + '/tools', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('svEntryGate')?.hidden === true);
    await page.locator('#siteShellSearch').fill('rhythm');
    await page.locator('#siteShellSearch').press('Enter');
    await page.waitForFunction(() => document.getElementById('svEntryGate')?.hidden === true);
    assert.equal(await page.locator('#siteSearch').inputValue(), 'rhythm');
    await page.locator('#toolCards a[href="/tools/rhythm-tuner"]').waitFor();
    assert.equal(await page.locator('#homeBlogPreview a[href="/blog/rhythm-guide"]').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('guest downloads share nine slots across karaoke WAV and recorder, then reset on the next local day', async () => {
  const { context, page, errors } = await pageFor();
  try {
    await page.locator('#homeVocalRemover').click();
    await page.locator('#vocalRemoverFileInput').setInputFiles({ name: 'our-song.wav', mimeType: 'audio/wav', buffer: stereoWav() });
    await page.waitForFunction(() => document.getElementById('vocalRemoverStatus').textContent.startsWith('Ready:'));
    await page.locator('#btnKaraokeCut').click();
    await page.waitForFunction(() => document.getElementById('btnKaraokeCut').getAttribute('aria-pressed') === 'true');
    assert.equal(await page.locator('#btnDownloadKaraoke').isVisible(), true);
    let downloadPromise = page.waitForEvent('download');
    await page.locator('#btnDownloadKaraoke').click();
    const first = await downloadPromise;
    assert.equal(first.suggestedFilename(), 'our-song-karaoke.wav');
    assert.equal((await readFile(await first.path())).subarray(0, 4).toString(), 'RIFF');
    assert.equal(await page.locator('#topPlanBadge').innerText(), '1/9 Free');
    await page.locator('#btnUseKaraoke').click();
    await page.locator('#btnGoToMix').click();
    // Quota behavior is independent of the separately tested audio encoder.
    await page.evaluate(() => { window.SingVazaDSP.renderMasterAudio = async () => ({ blob: new Blob(['master'], { type: 'audio/wav' }), mime: 'audio/wav', ext: 'wav' }); });
    downloadPromise = page.waitForEvent('download');
    await page.locator('#btnRenderMaster').click(); await downloadPromise;
    assert.equal(await page.locator('#topPlanBadge').innerText(), '2/9 Free');
    await page.evaluate(() => App.openVocalRemover());
    for (let i = 0; i < 7; i++) {
      downloadPromise = page.waitForEvent('download');
      await page.locator('#btnDownloadKaraoke').click(); await downloadPromise;
    }
    assert.equal(await page.locator('#topPlanBadge').innerText(), '9/9 Free');
    await page.locator('#btnDownloadKaraoke').click();
    assert.match(await page.locator('#toast').innerText(), /9\/9 downloads used/i);
    await page.evaluate(() => App.switchView('mix'));
    await page.locator('#btnRenderMaster').click();
    assert.match(await page.locator('#toast').innerText(), /9\/9 downloads used/i);
    assert.equal(await page.evaluate(() => localStorage.getItem('singvaza_daily_used')), '9');
    await page.evaluate(() => App.clearLocalStudioData());
    assert.equal(await page.evaluate(() => localStorage.getItem('singvaza_daily_used')), '9', 'resetting preferences does not reset the allowance');
    await page.evaluate(() => { localStorage.setItem('singvaza_daily_date', '2000-01-01'); App.openVocalRemover(); });
    downloadPromise = page.waitForEvent('download');
    await page.locator('#btnDownloadKaraoke').click(); await downloadPromise;
    assert.equal(await page.locator('#topPlanBadge').innerText(), '1/9 Free');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
