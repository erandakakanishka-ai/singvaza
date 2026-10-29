import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

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

test('the "tools we can build next" list is on the home page', () => {
  assert.ok(html.includes('id="roadmapTools"'), 'the roadmap block exists');
  const items = html.match(/<li><b>/g) || [];
  assert.ok(items.length >= 20, 'a real list of candidate tools (' + items.length + ')');
  for (const name of ['Photos → PDF', 'Invoice → PDF', 'QR code maker', 'EPF / ETF']) {
    assert.ok(html.includes(name), 'missing idea ' + name);
  }
  assert.ok(/no server, no upload/i.test(html), 'the on-device rule is stated');
});
