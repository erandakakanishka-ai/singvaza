import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const index = html;

test('the discover grid shows three tools and no Vocal Remover tile', () => {
  const tiles = html.match(/class="tool-tile"/g) || [];
  assert.ok(tiles.length >= 3, 'three or more tool tiles');
  const vocal = html.slice(html.indexOf('id="homeVocalRemover"'), html.indexOf('id="homeVocalRemover"') + 260);
  assert.ok(/hidden/.test(vocal), 'the vocal tile is hidden on the home grid');
  assert.ok(!/tool-tile-icon|Open tool|data-discovery="builtin-vocal" [^>]*><span/.test(vocal), 'no card chrome is rendered for it');
  for (const id of ['homeOfficeToPdf', 'homeHtmlToPdf', 'homeRecorder']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing tile ' + id);
  }
});

test('the tool counter follows what is actually on screen', () => {
  assert.ok(app.includes("querySelectorAll('.tool-tile')"), 'counts the visible tiles');
  assert.ok(app.includes('visibleTiles'), 'ignores hidden or removed tiles');
  assert.ok(app.includes("shown === 1 ? 'tool' : 'tools'"), 'singular and plural');
  // the built-in tools carry their own search entries so the counter can match them
  for (const key of ['builtin-office-pdf', 'builtin-html-pdf', 'builtin-recorder']) {
    assert.ok(app.includes(key), 'search entry ' + key);
  }
});

test('the ranked "what to build next" list is on the home page', () => {
  assert.ok(html.includes('id="roadmapTools"'), 'the roadmap block exists');
  const ranked = html.match(/<li><span class="rank">/g) || [];
  assert.equal(ranked.length, 8, 'eight ranked ideas, no invented extras');
  for (const name of ['Image compressor', 'Photos → PDF', 'QR code generator', 'PDF merge / split']) {
    assert.ok(html.includes(name), 'missing idea ' + name);
  }
  assert.ok(/only those we can run on your own device/i.test(html), 'the on-device rule is stated');
});

test('the cover is drawn, not a stock photo', () => {
  assert.ok(html.includes('class="art"'), 'an inline SVG cover');
  assert.ok(!/hero-documents|vocal-remover-studio\.jpg[^)]*\) center\/cover/.test(html.slice(html.indexOf('.discover-art'), html.indexOf('.discover-art') + 400)), 'no photo file behind the hero');
  assert.ok(html.includes('html[data-theme="light"] .discover-art .art-page'), 'the cover has a light-theme variant');
});

test('the controller is reachable as window.App for tool URLs, tests and the console', () => {
  // A top-level `const App = (() => {…})();` is not a property of window, so every
  // `window.App.openVocalRemover()` call used to throw. Keep the explicit export.
  assert.match(app, /window\.App\s*=\s*App;/, 'app.js must publish the controller on window');
});

test('no inline theme variable refers to itself', () => {
  // `--text-secondary: var(--text-secondary)` is invalid at computed-value time and
  // silently loses the theme colour, so the inline CSS must never do it.
  const style = html.slice(html.indexOf('<style id="singvaza-inline-css"'), html.indexOf('</style>', html.indexOf('<style id="singvaza-inline-css"')));
  for (const match of style.matchAll(/(--[a-z0-9-]+)\s*:\s*var\(\s*(--[a-z0-9-]+)\s*\)/g)) {
    assert.notEqual(match[1], match[2], `${match[1]} refers to itself`);
  }
});

test('the plan card speaks for the whole site, not only the singing studio', () => {
  // the operator: "those lines are about music — they must cover everything, this is a
  // blog-and-tools website, not one corner of it"
  assert.ok(index.includes('Your SingVaza Access Plan'), 'the card is about the whole site');
  assert.ok(index.includes('every tool and every article, not only the singing studio'), 'it says so plainly');
  assert.ok(index.includes('Every article, guide and template'), 'articles are included');
  assert.ok(index.includes('Every tool on the site'), 'tools are included');
  assert.ok(index.includes('PDF / Word / MP3 / WAV'), 'the download limit names other file types too');
  assert.ok(!/Unlimited karaoke singing & lyrics/.test(index), 'the music-only wording is gone');
  assert.ok(/No daily limit<\/strong> on finished-file downloads, on every tool/.test(index), 'one promise for every tool');
});

test('the plan card is not hidden behind the phone bottom bar', () => {
  assert.match(css, /body \{ padding-bottom: calc\(96px \+ env\(safe-area-inset-bottom\)\)/, 'the page reserves room for the fixed bar');
  assert.match(index, /padding-bottom: calc\(96px \+ env\(safe-area-inset-bottom\)\)/, 'and the inlined copy matches');
});
