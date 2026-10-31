import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const expected = 'SingVaza is a free online karaoke maker and recorder. Reduce vocals in stereo songs, sing with lyrics, and mix and export your recording in your browser.';
const html = await readFile('public/index.html', 'utf8');
const bundle = await build({ entryPoints: ['functions/_middleware.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' });
const middleware = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function envFor(rows) {
  return { DB: { prepare(sql) {
    assert.match(sql, /site_settings/);
    return { async all() { return { results: rows }; } };
  } } };
}
async function getHome(rows) {
  return middleware.onRequest({
    request: new Request('https://example.com/'), env: envFor(rows),
    next: async () => new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
  });
}

test('homepage fallback and both admin defaults use the new description', async () => {
  assert.ok(html.includes(`<meta name="description" content="${expected}"`));
  for (const path of ['src/worker.ts', 'functions/api/_worker_core.ts']) {
    const code = await readFile(path, 'utf8');
    assert.ok(code.includes(`seo_home_description: s.seo_home_description || '${expected}'`), path);
  }
  assert.ok((await (await getHome([])).text()).includes(`<meta name="description" content="${expected}"`));
});

test('the Pages middleware still honors and escapes the admin-editable D1 description', async () => {
  const custom = 'A future tools & "guides" description';
  const response = await getHome([{ k: 'seo_home_description', v: custom }]);
  const rendered = await response.text();
  assert.ok(rendered.includes('<meta name="description" content="A future tools &amp; &quot;guides&quot; description" />'));
  assert.ok(!rendered.includes(`<meta name="description" content="${expected}"`));
});

test('an address that does not exist answers 404, not the homepage', async () => {
  // Cloudflare Pages falls back to the homepage with a 200 for any unknown path, so
  // Google could crawl endless made-up addresses that all repeat our title.
  const middleware = await readFile(new URL('../functions/_middleware.ts', import.meta.url), 'utf8');
  assert.match(middleware, /function notFoundPage\(/, 'there is an honest 404 page');
  assert.match(middleware, /status: 404/, 'with a real 404 status');
  assert.match(middleware, /name="robots" content="noindex"/, 'and it is kept out of the index');
  assert.match(middleware, /async function isMissingPage\(/, 'a missing page is recognised');
  assert.match(middleware, /a === b/, 'by comparing the answer with the homepage itself');
  assert.match(middleware, /isMissingPage\(context, res, url, cleanPath\)/, 'the check runs before the holiday script is added');
  assert.match(middleware, /isMissingPage\(context, response, url, cleanPath\)/, 'and on the general path too');
});
