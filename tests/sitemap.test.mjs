import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

/* Google re-crawls a URL when its sitemap entry says it changed. Without <lastmod>
 * a fixed title/description can sit stale in the search results for weeks, which
 * looks like "the console did not update". Every sitemap entry must carry one. */

async function load(entry) {
  const out = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent',
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)).default;
}

const worker = await load('src/worker.ts');

test('every sitemap URL carries a lastmod date', async () => {
  const res = await worker.fetch(new Request('https://example.com/sitemap.xml'), {});
  assert.equal(res.status, 200);
  const xml = await res.text();
  const urls = xml.match(/<url>/g) || [];
  const lastmods = xml.match(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g) || [];
  assert.ok(urls.length >= 9, 'the fixed pages are listed');
  assert.equal(lastmods.length, urls.length, 'one lastmod per URL — no entry left without a date');
});

test('robots.txt points Google at the sitemap', async () => {
  // served as a static file by Pages, so it is checked as a file
  const txt = await readFile(new URL('../public/robots.txt', import.meta.url), 'utf8');
  assert.match(txt, /Sitemap: https:\/\/singvaza\.pages\.dev\/sitemap\.xml/i);
  assert.match(txt, /Sitemap: https:\/\/singvaza\.pages\.dev\/rss\.xml/i);
  assert.match(txt, /Disallow: \/admin/, 'the admin panel stays out of the index');
});
