import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

async function bundle(path) {
  const out = await build({ entryPoints: [path], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}
const middleware = await bundle('functions/_middleware.ts');
const worker = (await bundle('src/worker.ts')).default;
const html = await readFile('public/index.html', 'utf8');

test('Pages rewrites built-in deep links to the root asset with per-page SEO and no redirect', async () => {
  for (const [path, title] of [['/studio/vocal-remover', 'Vocal Remover'], ['/studio/karaoke-recorder', 'Karaoke Recorder']]) {
    let rewritten;
    const response = await middleware.onRequest({ request: new Request('https://example.com' + path), env: {}, next: async req => {
      rewritten = new URL(req.url).pathname;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: 'old' } });
    } });
    assert.equal(rewritten, '/');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('etag'), null);
    const body = await response.text();
    assert.ok(body.includes(`<title>${title}`));
    assert.ok(body.includes(`<link rel="canonical" href="https://example.com${path}" />`));
    assert.ok(body.includes('/guard.js?v=2'));
  }
});

test('existing /tools slugs are not reserved and sitemap includes built-ins once', async () => {
  const response = await worker.fetch(new Request('https://example.com/sitemap.xml'), {});
  const xml = await response.text();
  for (const p of ['/tools', '/studio/vocal-remover', '/studio/karaoke-recorder']) {
    assert.equal(xml.split(`<loc>https://example.com${p}</loc>`).length - 1, 1, p);
  }
  // Custom /tools/:slug remains handled by the CMS, not the new deep-link rewrite.
  const missing = await worker.fetch(new Request('https://example.com/tools/vocal-remover'), {});
  assert.equal(missing.status, 404);
});
