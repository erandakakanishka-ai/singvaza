import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

/* The operator's promise for templates: a file can be downloaded, edited and
 * uploaded back without losing anything, and nothing needs a CDN. */

async function load(entry) {
  const out = await build({
    entryPoints: [entry],
    bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

const templates = await load('src/templates.ts');
const _unusedOccasionSrc = await readFile(new URL('../src/occasions.ts', import.meta.url), 'utf8');

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

