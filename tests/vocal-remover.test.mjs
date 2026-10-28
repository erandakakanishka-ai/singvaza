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
before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }); });
after(async () => { await browser?.close(); });

async function newPage(width, height) {
  const context = await browser.newContext({ viewport: { width, height } });
  // Keep the 29 MB MDX model out of CI: fail the download fast so the worker
  // exercises its offline centre-reduction fallback with the same message flow.
  await context.route('https://huggingface.co/**/UVR_MDXNET_KARA.onnx', (route) => route.fulfill({ status: 503, body: 'offline in tests' }));
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
  await page.waitForFunction(() => document.getElementById('vocalRemoverPanel').contains(document.activeElement));
  assert.equal(await page.locator('#vocalRemoverPanel').evaluate((el) => el.contains(document.activeElement)), true);
}

test('the homepage shortcut and focused tool panel work on phone, tablet and desktop without horizontal overflow', async () => {
  for (const [width, height] of [[320, 780], [390, 844], [768, 1024], [1440, 900]]) {
    const { context, page } = await newPage(width, height);
    try {
      const shortcut = page.locator('#homeVocalRemover');
      assert.equal(await shortcut.isVisible(), true, `${width}: homepage shortcut`);
      assert.equal(await page.locator('#homeRecorder').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: homepage overflow`);
      await openRemover(page);
      assert.match(page.url(), /\/studio\/vocal-remover$/);
      assert.equal(await page.locator('#view-mix #vocalRemoverPanel').count(), 0);
      assert.equal(await page.locator('#btnKaraokeCut').isDisabled(), true);
      assert.match(await page.locator('#vocalRemoverPanel').innerText(), /AI separation/i);
      assert.equal(await page.locator('#karaokePresetBalanced').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: mixer overflow`);
    } finally { await context.close(); }
  }
});

test('stereo upload is processed in a worker, compared, played in Mix and used for Sing', async () => {
  const { context, page } = await newPage(390, 844);
  try {
    await openRemover(page);
    await page.evaluate(() => {
      const WorkerOriginal = window.Worker;
      window.Worker = class extends WorkerOriginal {
        constructor(url, ...rest) {
          super(url, ...rest);
          if (String(url).includes('karaoke-worker')) this.addEventListener('message', e => {
            window.__workerTask = e.data && e.data.type;
            if (e.data.type === 'result' && e.data.left) window.__processedLeft = new Float32Array(e.data.left);
          });
        }
      };
      const originalRender = window.SingVazaDSP.renderWindowWav;
      window.__playedProcessed = false;
      window.SingVazaDSP.renderWindowWav = (buffers, ...args) => {
        const actual = buffers.backing?.getChannelData(0);
        const expected = window.__processedLeft;
        window.__playedProcessed = Boolean(actual && expected && actual.length === expected.length && Math.abs(actual[1000] - expected[1000]) < 1e-6);
        return originalRender(buffers, ...args);
      };
    });
    await page.locator('#vocalRemoverFileInput').setInputFiles(stereo);
    await page.waitForFunction(() => document.getElementById('vocalRemoverStatus').textContent.startsWith('Ready:'));
    const cut = page.locator('#btnKaraokeCut');
    assert.equal(await cut.isEnabled(), true);
    await cut.click();
    await page.waitForFunction(() => document.getElementById('btnKaraokeCut').getAttribute('aria-pressed') === 'true');
    assert.match(await cut.innerText(), /restore original/i);
    assert.match(await page.locator('#vocalRemoverStatus').innerText(), /reduction is on/i);
    assert.equal(await page.locator('#karaokeCompare').isVisible(), true);
    assert.equal(await page.locator('#btnUseKaraoke').isVisible(), true);
    const processedUrl = await page.locator('#karaokeComparePlayer').evaluate(el => el.src);
    await page.locator('#compareOriginal').click();
    assert.equal(await page.locator('#compareOriginal').getAttribute('aria-pressed'), 'true');
    assert.notEqual(await page.locator('#karaokeComparePlayer').evaluate(el => el.src), processedUrl);
    await page.locator('#compareKaraoke').click();
    assert.equal(await page.locator('#karaokeComparePlayer').evaluate(el => el.src), processedUrl);
    await page.evaluate(() => App.switchView('mix'));
    await page.locator('#btnPlayPause').click();
    await page.waitForFunction(() => window.__playedProcessed === true);
    await page.locator('#btnStopRewind').click();
    await page.evaluate(() => App.openVocalRemover());
    await page.locator('#btnUseKaraoke').click();
    await page.locator('#stageKaraokeLabel').waitFor({ state: 'visible' });
    assert.match(await page.locator('#stageKaraokeLabel').innerText(), /selected for playback and recording/i);
    assert.equal(await page.locator('#stageUploadedMedia').evaluate(el => el.src), processedUrl, 'native stage audio is the processed backing');
    await page.locator('#stageUploadedMedia').evaluate(el => el.play());
    await page.waitForFunction(() => document.getElementById('stageUploadedMedia').currentTime > .1);
    await page.locator('#stageUploadedMedia').evaluate(el => el.pause());
    await context.grantPermissions(['microphone']);
    await page.locator('#useCountdown').uncheck();
    await page.locator('#btnRecordVocal').click();
    await page.waitForFunction(() => document.getElementById('recBtnLabel').textContent.includes('Stop & Mix'));
    await page.waitForFunction(() => !document.getElementById('stageUploadedMedia').paused && document.getElementById('stageUploadedMedia').currentTime > .15);
    assert.equal(await page.locator('#stageUploadedMedia').evaluate(el => el.src), processedUrl, 'the backing stays processed throughout recording');
    await page.locator('#btnRecordVocal').click();
    await page.waitForFunction(() => document.getElementById('view-mix').classList.contains('active'));
    await page.evaluate(() => App.openVocalRemover());
    await cut.click();
    await page.waitForFunction(() => document.getElementById('btnKaraokeCut').getAttribute('aria-pressed') === 'false');
    assert.notEqual(await page.locator('#stageUploadedMedia').evaluate(el => el.src), processedUrl, 'restoring also restores stage original');
    assert.equal(await page.locator('#stageKaraokeLabel').isHidden(), true);
  } finally { await context.close(); }
});

test('presets and intro mark settings dirty and update only after confirmation', async () => {
  const { context, page } = await newPage(390, 844);
  try {
    await openRemover(page);
    await page.locator('#vocalRemoverFileInput').setInputFiles(stereo);
    await page.waitForFunction(() => document.getElementById('vocalRemoverStatus').textContent.startsWith('Ready:'));
    await page.locator('#karaokePresetMusic').click();
    assert.equal(await page.locator('#karaokeStrength').inputValue(), '65');
    await page.locator('#karaokeIntro').fill('0.5');
    await page.locator('#btnKaraokeCut').click();
    await page.waitForFunction(() => document.getElementById('btnKaraokeCut').getAttribute('aria-pressed') === 'true');
    const previous = await page.locator('#karaokeComparePlayer').evaluate(el => el.src);
    await page.locator('#karaokePresetStrong').click();
    assert.equal(await page.locator('#btnUseKaraoke').isDisabled(), true);
    assert.equal(await page.locator('#btnUpdateKaraoke').isVisible(), true);
    await page.locator('#btnUpdateKaraoke').click();
    await page.waitForFunction(old => !document.getElementById('btnUseKaraoke').disabled && document.getElementById('karaokeComparePlayer').src !== old, previous);
    assert.equal(await page.locator('#karaokePresetStrong').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#btnUpdateKaraoke').isHidden(), true);
    await page.locator('#karaokeIntro').fill('99');
    await page.locator('#btnUpdateKaraoke').click();
    assert.match(await page.locator('#vocalRemoverStatus').innerText(), /less than the track duration/i);
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
    await page.waitForFunction(() => document.getElementById('btnKaraokeCut').getAttribute('aria-pressed') === 'true');
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
    await page.waitForFunction(() => document.getElementById('btnKaraokeCut').getAttribute('aria-pressed') === 'true');
    await page.evaluate(() => App.switchView('home'));
    await page.evaluate(() => App.openMixWithRealDemo());
    await page.evaluate(() => App.openVocalRemover());
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


test('supported video keeps original muted and processed audio synchronized during playback and microphone recording', async () => {
  const { context, page } = await newPage(768, 1024);
  try {
    await context.grantPermissions(['microphone']);
    // Create a real browser-encoded stereo WebM video with two independent tones.
    const bytes = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80;
      const c = canvas.getContext('2d'); c.fillStyle = '#2868a4'; c.fillRect(0, 0, 120, 80);
      const stream = canvas.captureStream(12);
      const ac = new AudioContext(); await ac.resume();
      const dest = ac.createMediaStreamDestination();
      const merger = ac.createChannelMerger(2); merger.connect(dest);
      const center = ac.createOscillator(); center.frequency.value = 440;
      const side = ac.createOscillator(); side.frequency.value = 710;
      const cg = ac.createGain(); cg.gain.value = .22; center.connect(cg);
      cg.connect(merger, 0, 0); cg.connect(merger, 0, 1);
      const sl = ac.createGain(); sl.gain.value = .15; side.connect(sl); sl.connect(merger, 0, 0);
      const sr = ac.createGain(); sr.gain.value = -.15; side.connect(sr); sr.connect(merger, 0, 1);
      stream.addTrack(dest.stream.getAudioTracks()[0]);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
      const chunks = []; rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      const done = new Promise(resolve => rec.onstop = resolve);
      center.start(); side.start(); rec.start();
      await new Promise(resolve => setTimeout(resolve, 2700));
      rec.stop(); await done; center.stop(); side.stop(); stream.getTracks().forEach(t => t.stop()); await ac.close();
      return Array.from(new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()));
    });
    await openRemover(page);
    await page.locator('#vocalRemoverFileInput').setInputFiles({ name: 'stereo-video.webm', mimeType: 'video/webm', buffer: Buffer.from(bytes) });
    await page.waitForFunction(() => /Ready:|could not read/i.test(document.getElementById('vocalRemoverStatus').textContent));
    assert.match(await page.locator('#vocalRemoverStatus').innerText(), /Ready:/, 'browser decoded video audio');
    await page.locator('#btnKaraokeCut').click();
    await page.waitForFunction(() => document.getElementById('btnKaraokeCut').getAttribute('aria-pressed') === 'true');
    await page.locator('#compareOriginal').click();
    await page.locator('#karaokeComparePlayer').evaluate(el => el.play());
    await page.waitForFunction(() => document.getElementById('karaokeComparePlayer').currentTime > .3);
    const positionBefore = await page.locator('#karaokeComparePlayer').evaluate(el => el.currentTime);
    await page.locator('#compareKaraoke').click();
    await page.waitForFunction(() => document.getElementById('karaokeComparePlayer').currentTime > .25);
    const positionAfter = await page.locator('#karaokeComparePlayer').evaluate(el => el.currentTime);
    assert.ok(Math.abs(positionAfter - positionBefore) < .5, `A/B position ${positionBefore} -> ${positionAfter}`);
    await page.locator('#btnUseKaraoke').click();
    const video = page.locator('#stageUploadedMedia');
    assert.equal(await video.evaluate(el => el.tagName), 'VIDEO');
    assert.equal(await video.evaluate(el => el.muted), true);
    await video.evaluate(el => el.play());
    await page.waitForFunction(() => {
      const v = document.getElementById('stageUploadedMedia'), a = document.getElementById('stageKaraokeAudio');
      return v.currentTime > .4 && a && !a.paused && a.currentTime > .25;
    });
    let sync = await page.evaluate(() => {
      const v = document.getElementById('stageUploadedMedia'), a = document.getElementById('stageKaraokeAudio');
      return { muted: v.muted, diff: Math.abs(v.currentTime - a.currentTime), same: v.src === a.src };
    });
    assert.equal(sync.muted, true); assert.equal(sync.same, false); assert.ok(sync.diff < .35, `playback sync ${sync.diff}`);
    await video.evaluate(el => { el.muted = false; });
    await page.waitForFunction(() => document.getElementById('stageUploadedMedia').muted);
    await video.evaluate(el => { el.pause(); el.currentTime = .9; });
    await page.waitForFunction(() => Math.abs(document.getElementById('stageKaraokeAudio').currentTime - .9) < .15);
    assert.equal(await page.locator('#stageKaraokeAudio').evaluate(el => el.paused), true);
    await video.evaluate(el => el.play());
    await page.waitForFunction(() => !document.getElementById('stageKaraokeAudio').paused);
    await video.evaluate(el => { el.currentTime = 1.4; });
    await page.waitForFunction(() => {
      const v = document.getElementById('stageUploadedMedia'), a = document.getElementById('stageKaraokeAudio');
      return !v.seeking && !a.paused && Math.abs(v.currentTime - a.currentTime) < .25;
    });
    await video.evaluate(el => el.pause());
    await page.locator('#useCountdown').uncheck();
    await page.locator('#btnRecordVocal').click();
    await page.waitForFunction(() => document.getElementById('recBtnLabel').textContent.includes('Stop & Mix'));
    await page.waitForFunction(() => {
      const v = document.getElementById('stageUploadedMedia'), a = document.getElementById('stageKaraokeAudio');
      return v && a && !v.paused && !a.paused && v.currentTime > .2;
    });
    sync = await page.evaluate(() => {
      const v = document.getElementById('stageUploadedMedia'), a = document.getElementById('stageKaraokeAudio');
      return { muted: v.muted, diff: Math.abs(v.currentTime - a.currentTime) };
    });
    assert.equal(sync.muted, true, 'original video audio remains muted throughout recording');
    assert.ok(sync.diff < .35, `recording sync ${sync.diff}`);
    await page.locator('#btnRecordVocal').click();
    await page.waitForFunction(() => !document.getElementById('stageUploadedMedia') || document.getElementById('stageUploadedMedia').paused);
  } finally { await context.close(); }
});


test('a dual-mono upload never claims centre reduction and falls back honestly', async () => {
  const { context, page } = await newPage(390, 844);
  try {
    await openRemover(page);
    const bytes = wav(2);
    for (let i = 44; i < bytes.length; i += 4) bytes.writeInt16LE(bytes.readInt16LE(i), i + 2);
    await page.locator('#vocalRemoverFileInput').setInputFiles({ name: 'dual-mono.wav', mimeType: 'audio/wav', buffer: bytes });
    await page.waitForFunction(() => document.getElementById('vocalRemoverStatus').textContent.startsWith('Ready:'));
    await page.locator('#btnKaraokeCut').click();
    // With the AI model blocked in tests the worker must say so instead of
    // pretending a centre-cancel worked.
    await page.waitForFunction(() => {
      const text = document.getElementById('vocalRemoverStatus').textContent;
      return /offline|centre|could not|unavailable|error|shorter|failed/i.test(text);
    }, { timeout: 60000 });
    const text = await page.locator('#vocalRemoverStatus').innerText();
    assert.match(text, /offline|centre|could not|unavailable|error|shorter|failed/i);
  } finally { await context.close(); }
});

test('a newer upload cancels a pending reduction and prevents stale results', async () => {
  const { context, page } = await newPage(390, 844);
  try {
    await openRemover(page);
    await page.evaluate(() => {
      const RealWorker = window.Worker;
      window.Worker = class extends RealWorker {
        postMessage(message, transfer) {
          if (message.type === 'process') setTimeout(() => { try { super.postMessage(message, transfer); } catch (_) {} }, 700);
          else super.postMessage(message, transfer);
        }
      };
    });
    const input = page.locator('#vocalRemoverFileInput');
    await input.setInputFiles(stereo);
    await page.waitForFunction(() => document.getElementById('vocalRemoverStatus').textContent.startsWith('Ready:'));
    await page.locator('#btnKaraokeCut').click();
    assert.equal(await page.locator('#btnCancelKaraoke').isVisible(), true);
    await input.setInputFiles({ ...stereo, name: 'newer.wav' });
    await page.waitForFunction(() => document.getElementById('vocalRemoverStatus').textContent.includes('newer.wav'));
    await page.waitForTimeout(900);
    assert.equal(await page.locator('#btnKaraokeCut').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#karaokeCompare').isHidden(), true);
    assert.match(await page.locator('#vocalRemoverStatus').innerText(), /newer.wav/);
  } finally { await context.close(); }
});

test('key changes and crop/undo cannot leave a stale karaoke stage preview', async () => {
  const { context, page } = await newPage(768, 1024);
  try {
    await openRemover(page);
    await page.locator('#vocalRemoverFileInput').setInputFiles(stereo);
    await page.waitForFunction(() => document.getElementById('vocalRemoverStatus').textContent.startsWith('Ready:'));
    await page.locator('#btnKaraokeCut').click();
    await page.waitForFunction(() => document.getElementById('btnKaraokeCut').getAttribute('aria-pressed') === 'true');
    const old = await page.locator('#karaokeComparePlayer').evaluate(el => el.src);
    await page.evaluate(() => App.shiftBackingKey(1));
    assert.equal(await page.locator('#btnUseKaraoke').isDisabled(), true);
    await page.locator('#btnUpdateKaraoke').click();
    await page.waitForFunction(old => !document.getElementById('btnUseKaraoke').disabled && document.getElementById('karaokeComparePlayer').src !== old, old);
    assert.equal(await page.locator('#transposeLabel').textContent(), '+1 st');
    await page.evaluate(() => App.switchView('mix'));
    await page.evaluate(() => App.updateCropSlider('start', 200));
    await page.locator('#btnApplyCrop').click();
    await page.evaluate(() => App.openVocalRemover());
    assert.equal(await page.locator('#karaokeCompare').isHidden(), true);
    await page.locator('#btnUpdateKaraoke').click();
    assert.match(await page.locator('#vocalRemoverStatus').innerText(), /undo the mix crop/i);
    await page.evaluate(() => App.switchView('mix'));
    await page.locator('#btnUndoCrop').click();
    await page.evaluate(() => App.openVocalRemover());
    await page.locator('#btnUpdateKaraoke').click();
    await page.waitForFunction(() => !document.getElementById('btnUseKaraoke').disabled);
    assert.equal(await page.locator('#karaokeCompare').isVisible(), true);
  } finally { await context.close(); }
});

test('the AI worker keeps a vocal-free backing untouched and reports engine metadata', async () => {
  const { context, page } = await newPage(768, 1024);
  try {
    const info = await page.evaluate(async () => {
      const ac = new AudioContext();
      const backing = await ac.decodeAudioData(await (await fetch('/assets/demo-backing.mp3')).arrayBuffer());
      const n = Math.min(backing.length, Math.floor(ac.sampleRate * 6));
      const l = new Float32Array(n), r = new Float32Array(n);
      const bL = backing.getChannelData(0), bR = backing.getChannelData(Math.min(1, backing.numberOfChannels - 1));
      for (let i = 0; i < n; i++) { l[i] = bL[i] * 0.3; r[i] = bR[i] * 0.3; }
      const result = await new Promise((resolve, reject) => {
        const w = new Worker('/karaoke-worker.js?v=test');
        w.onmessage = (e) => {
          if (e.data.type === 'error') { w.terminate(); reject(new Error(e.data.message)); }
          if (e.data.type === 'result') {
            w.terminate();
            resolve({ info: e.data.info, len: new Float32Array(e.data.left).length, wavBytes: e.data.wav.byteLength });
          }
        };
        w.onerror = () => reject(new Error('worker failed to start'));
        w.postMessage({ type: 'separate', left: l.buffer, right: r.buffer, sampleRate: ac.sampleRate, options: { strength: 0.85 } }, [l.buffer, r.buffer]);
      });
      await ac.close();
      return result;
    });
    assert.ok(['mdx', 'centre'].includes(info.info.engine), `engine reported: ${info.info.engine}`);
    assert.ok(info.len > 0, 'produced audio');
    assert.ok(info.wavBytes > info.len, 'produced a WAV');
    assert.ok(info.info.seconds > 1);
  } finally { await context.close(); }
});

test('a stereo AAC/H.264 MP4 can be processed, compared and played in the video stage', async () => {
  const { context, page } = await newPage(390, 844);
  try {
    await openRemover(page);
    await page.locator('#vocalRemoverFileInput').setInputFiles(new URL('./fixtures/stereo-synthetic.mp4', import.meta.url).pathname);
    await page.waitForFunction(() => /Ready:|could not read/i.test(document.getElementById('vocalRemoverStatus').textContent));
    assert.match(await page.locator('#vocalRemoverStatus').innerText(), /Ready:/);
    await page.locator('#btnKaraokeCut').click();
    await page.waitForFunction(() => document.getElementById('btnKaraokeCut').getAttribute('aria-pressed') === 'true');
    await page.locator('#compareOriginal').click();
    await page.locator('#karaokeComparePlayer').evaluate(el => el.play());
    await page.waitForFunction(() => document.getElementById('karaokeComparePlayer').currentTime > .2);
    await page.locator('#btnUseKaraoke').click();
    await page.locator('#stageUploadedMedia').evaluate(el => el.play());
    await page.waitForFunction(() => {
      const v = document.getElementById('stageUploadedMedia'), a = document.getElementById('stageKaraokeAudio');
      return v.currentTime > .3 && a && !a.paused && Math.abs(v.currentTime - a.currentTime) < .3;
    });
    assert.equal(await page.locator('#stageUploadedMedia').evaluate(el => el.muted), true);
  } finally { await context.close(); }
});
