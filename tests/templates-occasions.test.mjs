import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

/* Two promises to the operator, pinned here:
 *   1. a template can be downloaded, edited and uploaded back without losing anything,
 *   2. a seasonal greeting appears ONLY inside its own dates, is additive, and
 *      disappears by itself — the layout of the site never changes. */

async function load(entry) {
  const out = await build({
    entryPoints: [entry],
    bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

const templates = await load('src/templates.ts');
const occasionSrc = await readFile(new URL('../src/occasions.ts', import.meta.url), 'utf8');
const workerSrc = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');

test('every built-in template is downloadable HTML', () => {
  const list = templates.templateList();
  assert.ok(list.length >= 4, 'at least four starter templates');
  for (const t of list) {
    const full = templates.templateById(t.id);
    assert.ok(typeof t.bytes === 'number' && t.bytes > 200, `${t.id} has HTML`);
    assert.ok(full, `${t.id} is reachable by id`);
    if (t.downloadable) {
      assert.match(full.html, /^<!DOCTYPE html>/i, `${t.id} is a full document`);
      assert.match(full.html, /<title>[^<]+<\/title>/i, `${t.id} has a title`);
    }
  }
  assert.ok(templates.DOWNLOADABLE_TEMPLATES.length >= 2, 'at least two downloadable files');
});

test('templates ship no external dependency', () => {
  for (const t of templates.templateList()) {
    const { html } = templates.templateById(t.id);
    assert.doesNotMatch(html, /<(script|link)[^>]+(src|href)=["']https?:/i, `${t.id} must not load a CDN file`);
    assert.doesNotMatch(html, /@import\s+url\(["']?https?:/i, `${t.id} must not import remote CSS`);
  }
});

test('a download can be uploaded back unchanged (round trip)', () => {
  for (const t of templates.DOWNLOADABLE_TEMPLATES) {
    assert.equal(templates.templateById(t.id).html, t.html, `${t.id} download is stable`);
    assert.ok(JSON.stringify({ html: t.html }).includes('<!DOCTYPE html>'), `${t.id} keeps its doctype`);
  }
  assert.equal(templates.templateById('does-not-exist'), undefined);
});

test('an occasion is active only inside its own dates', async () => {
  const { isOccasionActive } = await load('src/occasions.ts');
  const cfg = { enabled: true, message: 'hello', startDate: '2026-12-20', endDate: '2026-12-27' };
  assert.equal(isOccasionActive(cfg, '2026-12-19'), false, 'day before');
  assert.equal(isOccasionActive(cfg, '2026-12-20'), true, 'first day');
  assert.equal(isOccasionActive(cfg, '2026-12-24'), true, 'middle');
  assert.equal(isOccasionActive(cfg, '2026-12-27'), true, 'last day');
  assert.equal(isOccasionActive(cfg, '2026-12-28'), false, 'day after — reverts by itself');
});

test('an occasion needs a switch, a message and both dates', async () => {
  const { isOccasionActive } = await load('src/occasions.ts');
  const base = { enabled: true, message: 'hello', startDate: '2026-12-20', endDate: '2026-12-27' };
  assert.equal(isOccasionActive({ ...base, enabled: false }, '2026-12-24'), false, 'off switch wins');
  assert.equal(isOccasionActive({ ...base, message: '' }, '2026-12-24'), false, 'no message, no bar');
  assert.equal(isOccasionActive({ ...base, startDate: '' }, '2026-12-24'), false, 'no start date');
  assert.equal(isOccasionActive({ ...base, endDate: '' }, '2026-12-24'), false, 'no end date');
  assert.equal(isOccasionActive(null, '2026-12-24'), false, 'no config');
});

test('presets never carry a stale hard-coded year', async () => {
  const { occasionPresets } = await load('src/occasions.ts');
  const now = occasionPresets('2026-10-30');
  assert.ok(now.length >= 4);
  for (const p of now) {
    assert.match(p.startDate, /^\d{4}-\d{2}-\d{2}$/, `${p.id} start date`);
    assert.match(p.endDate, /^\d{4}-\d{2}-\d{2}$/, `${p.id} end date`);
    assert.ok(p.endDate >= p.startDate, `${p.id} ends after it starts`);
    assert.ok(p.startDate >= '2026-10-30', `${p.id} is not in the past`);
  }
  const christmas = now.find((p) => p.id === 'christmas');
  assert.equal(christmas.startDate.slice(0, 4), '2026');
  // New Year crosses the year boundary, so it must end in the next year.
  const ny = now.find((p) => p.id === 'new-year');
  assert.equal(ny.startDate, `${ny.startDate.slice(0, 4)}-12-31`);
  assert.equal(Number(ny.endDate.slice(0, 4)), Number(ny.startDate.slice(0, 4)) + 1);
});

test('the greeting is additive: injected after <body>, never over the page', () => {
  const iBody = occasionSrc.indexOf('export function renderOccasionBanner');
  assert.ok(iBody > 0, 'renderOccasionBanner exists');
  const body = occasionSrc.slice(iBody, iBody + 4000);
  assert.match(body, /id="sv-occasion"/, 'the bar has a stable id');
  assert.match(body, /position:relative/, 'the bar is in the flow, not floating over content');
  assert.doesNotMatch(body, /document\.body\.innerHTML|replaceChild\(|<style>body/, 'the page is never rewritten');
});

test('the bar is inserted after <body> and only once', async () => {
  const { injectOccasionBanner } = await load('src/occasions.ts');
  const page = '<!DOCTYPE html><html><head></head><body class="x"><h1>Home</h1></body></html>';
  const once = injectOccasionBanner(page, { message: 'Hi', emoji: '🎄' });
  assert.ok(once.indexOf('sv-occasion') > once.indexOf('<body class="x">'), 'after <body>');
  assert.ok(once.includes('<h1>Home</h1>'), 'the page content is untouched');
  const twice = injectOccasionBanner(once, { message: 'Hi', emoji: '🎄' });
  assert.equal(twice.split('id="sv-occasion"').length - 1, 1, 'never duplicated');
});

test('switch-off leaves the page byte for byte as it was', async () => {
  const { injectOccasionBanner } = await load('src/occasions.ts');
  const page = '<html><body><p>same</p></body></html>';
  assert.equal(injectOccasionBanner(page, null), page);
  assert.equal(injectOccasionBanner(page, { enabled: false }), page);
});

test('preview needs a signed-in admin, not just a query string', async () => {
  const { isOccasionPreview } = await load('src/occasions.ts');
  const cfg = { enabled: true, message: 'hi', startDate: '2030-12-20', endDate: '2030-12-27' };
  assert.equal(isOccasionPreview(cfg, true, false), false, 'public visitor cannot preview');
  assert.equal(isOccasionPreview(cfg, true, true), true, 'admin can preview outside the dates');
  assert.equal(isOccasionPreview(cfg, false, true), false, 'no request, no preview');
  assert.equal(isOccasionPreview({ ...cfg, message: '' }, true, true), false, 'no message, no preview');
  assert.equal(isOccasionPreview({ ...cfg, enabled: false }, true, true), false, 'switched off, no preview');
});

test('the greeting only lands on the pages the admin picked', async () => {
  const { occasionAppliesTo } = await load('src/occasions.ts');
  const cfg = { pages: ['/', '/about'] };
  assert.equal(occasionAppliesTo(cfg, '/'), true);
  assert.equal(occasionAppliesTo(cfg, '/about'), true);
  assert.equal(occasionAppliesTo(cfg, '/terms'), false, 'untouched page');
  assert.equal(occasionAppliesTo({ pages: [] }, '/about'), false);
});

test('the worker wires the bar in on the way out only', () => {
  assert.match(workerSrc, /injectOccasionBanner\(page, config\)/, 'added at serve time');
  assert.doesNotMatch(workerSrc, /setSetting\([^)]*page_override[^)]*occasion/, 'never stored into the page');
});
