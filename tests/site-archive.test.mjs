import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';

/* The operator's rule for this feature:
 *   one click gives ONE file with the whole static site, the AI edits it, and the
 *   updated file comes back and is published — without the live tools/articles
 *   being disturbed and without losing the ability to undo. */

async function load(entry) {
  const out = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

const archive = await load('src/site-archive.ts');
const { buildZip } = await load('src/zip.ts');

test('the zip writer produces a real, readable archive', async () => {
  const files = [
    { name: 'index.html', data: new TextEncoder().encode('<!DOCTYPE html><h1>hi</h1>') },
    { name: 'assets/logo.png', data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) },
  ];
  const zip = buildZip(files);
  const parsed = await JSZip.loadAsync(zip);
  assert.deepEqual(Object.keys(parsed.files).sort(), ['assets/logo.png', 'index.html']);
  assert.equal(await parsed.file('index.html').async('string'), '<!DOCTYPE html><h1>hi</h1>');
});

test('the whole site is one file, without the private panel or the 46 MB model', () => {
  const keep = ['index.html', 'about.html', 'styles.css', 'app.js', 'assets/logo.png', 'studio/html-to-pdf.html', 'sl-songs.txt'];
  for (const path of keep) assert.equal(archive.isDownloadableSiteFile(path), true, path);
  assert.equal(archive.isDownloadableSiteFile('admin.html'), false, 'the admin panel stays private');
  assert.equal(archive.isDownloadableSiteFile('model/model-part1.part'), false, 'the karaoke model is not a page');
  assert.equal(archive.isDownloadableSiteFile('google8dc68fc0e32ac33e.html'), false, 'a verification file is not a page');
});

test('only real text files can come back and go live', () => {
  for (const path of ['index.html', 'styles.css', 'app.js', 'site.webmanifest', 'ads.txt', 'robots.txt', 'assets/logo.svg']) {
    assert.equal(archive.isPublishableTextFile(path), true, path);
  }
  for (const path of ['assets/logo.png', 'assets/demo-vocal.mp3', 'vendor/lame.min.js.map', 'archive.zip']) {
    assert.equal(archive.isPublishableTextFile(path), false, path);
  }
});

test('a file the AI wraps in a folder still lands in the right place', () => {
  assert.equal(archive.normalizeSitePath('/index.html'), 'index.html');
  assert.equal(archive.normalizeSitePath('./styles.css'), 'styles.css');
  assert.equal(archive.normalizeSitePath('singvaza-site-2026-10-30/index.html'), 'index.html');
  assert.equal(archive.normalizeSitePath('assets\\logo.png'), 'assets/logo.png');
});

test('a changed main page goes through the existing page-override path', () => {
  assert.equal(archive.pagePathForFile('index.html'), '/');
  assert.equal(archive.pagePathForFile('about.html'), '/about');
  assert.equal(archive.pagePathForFile('refunds.html'), '/refunds');
  assert.equal(archive.pagePathForFile('styles.css'), null, 'a stylesheet is not a page');
  assert.equal(archive.pagePathForFile('studio/html-to-pdf.html'), null);
});

test('the comparison tells changed, new and untouched files apart', () => {
  const uploaded = [
    { path: 'index.html', content: 'A' },
    { path: 'styles.css', content: 'B' },
    { path: 'new.css', content: 'C' },
  ];
  const current = { 'index.html': 'A', 'styles.css': 'old' };
  const summary = archive.summarizeChanges(uploaded, current);
  assert.deepEqual(summary.map((f) => [f.path, f.status]), [
    ['index.html', 'same'],
    ['styles.css', 'changed'],
    ['new.css', 'new'],
  ]);
});

test('a published file is served with the right content type', () => {
  assert.match(archive.contentTypeFor('styles.css'), /^text\/css/);
  assert.match(archive.contentTypeFor('app.js'), /^text\/javascript/);
  assert.match(archive.contentTypeFor('index.html'), /^text\/html/);
  assert.match(archive.contentTypeFor('site.webmanifest'), /^application\/manifest\+json/);
});

test('the upload service and the undo copy are stored under separate keys', () => {
  assert.equal(archive.liveKey('/styles.css'), 'live_override:styles.css');
  assert.equal(archive.undoKey('styles.css'), 'live_undo:styles.css');
  assert.notEqual(archive.liveKey('a.css'), archive.undoKey('a.css'));
});

test('the build writes a file list for the download button', async () => {
  const raw = await readFile(new URL('../public/site-manifest.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(raw);
  assert.ok(manifest.files.length > 20, 'the site has files');
  assert.ok(manifest.files.includes('index.html'));
  assert.ok(manifest.files.includes('styles.css'));
  // and the download filters it the way the worker does
  const kept = manifest.files.filter((f) => archive.isDownloadableSiteFile(f));
  assert.equal(kept.includes('admin.html'), false);
  assert.equal(kept.some((f) => f.startsWith('model/')), false);
  assert.ok(kept.length > 20);
});

test('the panel wires the whole flow and keeps the tools out of it', async () => {
  const admin = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(admin, /Download the whole site/, 'one click download');
  assert.match(admin, /Upload updated \.zip/, 'the updated file comes back');
  assert.match(admin, /Publish these changes|Publish \$\{data\.changed\}/, 'nothing goes live by itself');
  assert.match(admin, /undoSiteZip/, 'an undo exists');
  assert.match(admin, /Tools and articles are database rows, so they are <strong>not<\/strong> in the zip/, 'the limit is stated, not hidden');
  assert.doesNotMatch(admin, /data-tab="templates"/, 'no extra section for a site this small');
});

test('the deployed worker carries the same routes as the source', async () => {
  const core = await readFile(new URL('../functions/api/_worker_core.ts', import.meta.url), 'utf8');
  assert.match(core, /site-archive/);
  assert.match(core, /from '\.\.\/\.\.\/src\/site-archive'/);
  assert.match(core, /from '\.\.\/\.\.\/src\/zip'/);
});

test('the Tools tab follows the sketch: one + row, then Live · Download · Update', async () => {
  const admin = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  // the "+ New tool" row sits above the list, like the sketch
  const toolsTab = admin.slice(admin.indexOf('id="tab-tools"'), admin.indexOf('id="tab-tools-new"'));
  assert.ok(toolsTab.indexOf('class="add-row"') < toolsTab.indexOf('id="toolsListBody"'), 'the + row comes first');
  assert.match(toolsTab, /builtinToolsBody/, 'the built-in tools are listed');
  // exactly three actions per tool row, and their order
  assert.match(admin, /onclick="AdminApp\.toggleRowMenu/, 'the uploaded rows keep their menu');
  const builtin = admin.slice(admin.indexOf('function renderBuiltinTools'), admin.indexOf('async function downloadBuiltin'));
  const actions = [...builtin.matchAll(/>\s*(Live|Download|Update)\s*</g)].map((m) => m[1]);
  assert.deepEqual(actions, ['Live', 'Download', 'Update'], 'Live, then Download, then Update');
  assert.equal((builtin.match(/<td/g) || []).length, 2, 'no status column for a tool that is always live');
});

test('the extra settings are one closed block until their + is pressed', async () => {
  const admin = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  const block = admin.slice(admin.indexOf('id="accExtraTools"'), admin.indexOf('id="accExtraToolsBody"') + 200);
  assert.match(block, /acc-open/, 'there is a + button');
  assert.match(admin, /id="accExtraToolsBody" hidden/, 'it starts closed');
  assert.match(admin, /function toggleAcc/, 'and it can be opened');
  // and no card of the block is left outside the Settings tab
  // Settings is the last tab, so its section runs to the end of the page.
  const settings = admin.slice(admin.indexOf('id="tab-settings"'), admin.indexOf('</main>'));
  assert.match(settings, /accExtraTools/, 'the block lives inside Settings');
  assert.match(settings, /Manual greeting/, 'together with the manual greeting card');
  assert.ok(!admin.includes('data-tab="templates"'), 'no separate Templates tab');
});
