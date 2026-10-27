import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Run against the local test-key preview, never the real D1 database.
const base = process.env.SINGVAZA_TEST_URL || 'http://localhost:8788';
const dummyWidget = `
  (() => {
    let id = 0;
    const widgets = new Map();
    function paint(record) {
      record.element.innerHTML = '';
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = 'Complete test security check';
      b.setAttribute('data-test-captcha', record.options.action);
      b.addEventListener('click', () => record.options.callback('XXXX.DUMMY.TOKEN.XXXX'));
      record.element.appendChild(b);
    }
    window.turnstile = {
      render(element, options) {
        if (typeof element === 'string') element = document.querySelector(element);
        const record = { element, options }; const key = ++id;
        widgets.set(key, record); paint(record); return key;
      },
      reset(key) { if (widgets.has(key)) paint(widgets.get(key)); },
      remove(key) { if (widgets.has(key)) widgets.get(key).element.innerHTML = ''; widgets.delete(key); },
    };
  })();
`;
let browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
after(async () => { await browser?.close(); });

async function newPage(width, height) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.route('https://challenges.cloudflare.com/turnstile/v0/api.js?*', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: dummyWidget }));
  const page = await context.newPage();
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('#svEntryWidget [data-test-captcha="site_entry"]').click();
  if (await page.locator('#svTermsBox').isVisible()) await page.locator('#svTermsAgree').check();
  await page.locator('#svEntryContinue').click();
  await page.waitForFunction(() => document.getElementById('svEntryGate')?.hidden === true);
  return { context, page };
}

// Two seconds of actual PCM audio: centered 440 Hz plus a stereo-only 700 Hz tone.
function wav(channels = 2) {
  const sr = 16000, samples = sr * 2, bytesPerFrame = channels * 2;
  const out = Buffer.alloc(44 + samples * bytesPerFrame);
  out.write('RIFF', 0); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sr, 24); out.writeUInt32LE(sr * bytesPerFrame, 28);
  out.writeUInt16LE(bytesPerFrame, 32); out.writeUInt16LE(16, 34); out.write('data', 36);
  out.writeUInt32LE(out.length - 44, 40);
  for (let i = 0; i < samples; i++) {
    const center = 0.4 * Math.sin(2 * Math.PI * 440 * i / sr);
    const side = 0.12 * Math.sin(2 * Math.PI * 700 * i / sr);
    for (let c = 0; c < channels; c++) out.writeInt16LE(Math.round(32767 * (center + (c ? -side : side))), 44 + i * bytesPerFrame + c * 2);
  }
  return out;
}
const stereo = { name: 'stereo-test.wav', mimeType: 'audio/wav', buffer: wav(2) };
const mono = { name: 'mono-test.wav', mimeType: 'audio/wav', buffer: wav(1) };

async function openRemover(page) {
  await page.locator('#homeVocalRemover').click();
  await page.locator('#vocalRemoverPanel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#vocalRemoverPanel').evaluate((el) => el.contains(document.activeElement)), true);
}

test('the homepage shortcut and focused tool panel work on phone, tablet and desktop without horizontal overflow', async () => {
  for (const [width, height] of [[320, 780], [390, 844], [768, 1024], [1440, 900]]) {
    const { context, page } = await newPage(width, height);
    try {
      const shortcut = page.locator('#homeVocalRemover');
      assert.equal(await shortcut.isVisible(), true, `${width}: homepage shortcut`);
      assert.equal(await page.locator('.featured-tool img').count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: homepage overflow`);
      await openRemover(page);
      assert.equal(await page.locator('#btnKaraokeCut').isDisabled(), true);
      assert.match(await page.locator('#vocalRemoverPanel').innerText(), /not AI separation/i);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: mixer overflow`);
    } finally { await context.close(); }
  }
});

test('a real stereo upload reaches the existing DSP and the processed buffer reaches Mix playback', async () => {
  const { context, page } = await newPage(390, 844);
  try {
    await openRemover(page);
    await page.evaluate(() => {
      const originalCut = window.SingVazaDSP.centerCutKaraokeBuffer;
      const originalRender = window.SingVazaDSP.renderWindowWav;
      window.__cutCalls = 0; window.__processedBuffer = null; window.__playedProcessed = false;
      window.SingVazaDSP.centerCutKaraokeBuffer = (...args) => {
        window.__cutCalls++; window.__processedBuffer = originalCut(...args); return window.__processedBuffer;
      };
      window.SingVazaDSP.renderWindowWav = (buffers, ...args) => {
        window.__playedProcessed = buffers.backing === window.__processedBuffer;
        return originalRender(buffers, ...args);
      };
    });
    await page.locator('#vocalRemoverFileInput').setInputFiles(stereo);
    await page.waitForFunction(() => document.getElementById('vocalRemoverStatus').textContent.startsWith('Ready:'));
    const cut = page.locator('#btnKaraokeCut');
    assert.equal(await cut.isEnabled(), true);
    assert.equal(await cut.getAttribute('aria-pressed'), 'false');
    await cut.click();
    assert.equal(await cut.getAttribute('aria-pressed'), 'true');
    assert.match(await cut.innerText(), /restore original/i);
    assert.equal(await page.evaluate(() => window.__cutCalls), 1);
    assert.match(await page.locator('#vocalRemoverStatus').innerText(), /reduction is on/i);
    await page.locator('#btnPlayPause').click();
    await page.waitForFunction(() => window.__playedProcessed === true);
    await page.locator('#btnStopRewind').click();
    await cut.click();
    assert.equal(await cut.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => window.__cutCalls), 1, 'restoring uses the original, not another cut');
  } finally { await context.close(); }
});

test('replacing a song resets the toggle; mono and unreadable files do not claim success', async () => {
  const { context, page } = await newPage(768, 1024);
  try {
    await openRemover(page);
    const input = page.locator('#vocalRemoverFileInput');
    const cut = page.locator('#btnKaraokeCut');
    await input.setInputFiles(stereo);
    await page.waitForFunction(() => document.getElementById('vocalRemoverStatus').textContent.startsWith('Ready:'));
    await cut.click();
    assert.equal(await cut.getAttribute('aria-pressed'), 'true');
    await input.setInputFiles({ ...stereo, name: 'new-song.wav' });
    await page.waitForFunction(() => document.getElementById('vocalRemoverStatus').textContent.includes('new-song.wav'));
    assert.equal(await cut.getAttribute('aria-pressed'), 'false');
    assert.equal(await cut.isEnabled(), true);
    await input.setInputFiles(mono);
    await page.waitForFunction(() => document.getElementById('vocalRemoverStatus').textContent.includes('mono'));
    assert.equal(await cut.isDisabled(), true);
    assert.equal(await cut.getAttribute('aria-pressed'), 'false');
    await input.setInputFiles({ name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not a real video') });
    await page.waitForFunction(() => document.getElementById('vocalRemoverStatus').textContent.includes('could not read'));
    assert.equal(await cut.isDisabled(), true);
  } finally { await context.close(); }
});

test('switching to the demo does not leave a stale active remover toggle', async () => {
  const { context, page } = await newPage(1440, 900);
  try {
    await openRemover(page);
    await page.locator('#vocalRemoverFileInput').setInputFiles(stereo);
    await page.waitForFunction(() => document.getElementById('vocalRemoverStatus').textContent.startsWith('Ready:'));
    await page.locator('#btnKaraokeCut').click();
    assert.equal(await page.locator('#btnKaraokeCut').getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => App.switchView('home'));
    await page.getByRole('button', { name: 'Open Mix Studio' }).click();
    await page.locator('#vocalRemoverPanel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#btnKaraokeCut').isDisabled(), true);
    assert.equal(await page.locator('#btnKaraokeCut').getAttribute('aria-pressed'), 'false');
    assert.match(await page.locator('#vocalRemoverStatus').innerText(), /choose a stereo song/i);
  } finally { await context.close(); }
});

test('a slow demo preload cannot replace a newer selected track', async () => {
  const { context, page } = await newPage(1440, 900);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let requested = 0;
  let started;
  const demoRequested = new Promise((resolve) => { started = resolve; });
  try {
    await context.route('**/assets/demo-*.mp3', async (route) => {
      if (++requested === 2) started();
      await gate;
      await route.continue();
    });
    await page.evaluate(() => { window.__demoLoad = App.loadInstrumentalDemoForSing(); });
    await demoRequested;
    await openRemover(page);
    await page.locator('#vocalRemoverFileInput').setInputFiles(stereo);
    await page.waitForFunction(() => document.getElementById('vocalRemoverStatus').textContent.includes('stereo-test.wav'));
    release();
    await page.evaluate(() => window.__demoLoad);
    assert.match(await page.locator('#vocalRemoverStatus').innerText(), /stereo-test\.wav/);
    assert.equal(await page.locator('#btnKaraokeCut').isEnabled(), true);
  } finally { release(); await context.close(); }
});
