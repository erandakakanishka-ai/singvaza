import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

/* The operator wants two kinds of film writing on the blog, in English, published as a
 * page and shared to Facebook:
 *   1. a review as soon as a new film is out;
 *   2. news / rumours about actors.
 * The site keeps four rules for that kind of writing, and the admin panel says them out
 * loud before anything is published. */

async function load(entry) {
  const out = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

const check = await load('src/content-check.ts');

const review = (extra = '') => `<h1>Film review</h1>
<p>I watched this on the first night and the hall was full.</p>
<p>The story follows a driver who cannot sleep.</p>
<p>Rating: 7.5/10. Where to watch: in theatres now, then Netflix.</p>
${extra}
<p>${'The acting is quiet and the camera stays close. '.repeat(12)}</p>`;

test('a copied synopsis phrase is flagged', () => {
  const issues = check.filmReviewIssues(review());
  const copied = issues.filter((i) => i.code === 'copied-synopsis');
  assert.ok(copied.length >= 1, 'the stock phrase is noticed');
  assert.equal(copied[0].level, 'warn', 'the writer still decides');
});

test('an original review passes those checks', () => {
  const own = `<h1>Review</h1><p>Rating 8/10. In theatres now.</p><p>${'A quiet film about a loud city, and I liked the small scenes best. '.repeat(12)}</p>`;
  const issues = check.filmReviewIssues(own);
  assert.equal(issues.filter((i) => i.code === 'copied-synopsis').length, 0);
});

test('a pirate or rip host is a hard stop', () => {
  for (const bad of ['<a href="https://1337x.to/x">watch</a>', 'https://thepiratebay.org', 'https://t.me/joinchat/abc', 'movierulz']) {
    const issues = check.filmReviewIssues(review(bad));
    const error = issues.find((i) => i.code === 'pirate-link');
    assert.ok(error, bad);
    assert.equal(error.level, 'error', `${bad} blocks publishing`);
  }
});

test('a legal "where to watch" line is fine', () => {
  const issues = check.filmReviewIssues(review('<p>Streaming on Netflix and Prime Video after the cinema run.</p>'));
  assert.equal(issues.filter((i) => i.code === 'pirate-link').length, 0);
});

test('a plot twist without a spoiler warning is flagged', () => {
  const bare = review('<p>In the end, the driver was the one who called.</p>');
  assert.ok(check.filmReviewIssues(bare).some((i) => i.code === 'spoiler-not-marked'), 'bare reveal is flagged');

  const warned = review('<p>⚠️ Spoiler below.</p><p>In the end, the driver was the one who called.</p>');
  assert.equal(check.filmReviewIssues(warned).filter((i) => i.code === 'spoiler-not-marked').length, 0, 'a warning before the reveal is enough');
});

test('a review without a score or a "where to watch" line gets a nudge', () => {
  const plain = `<h1>Review</h1><p>${'The film is long and the last act is slow, but the songs stay with you. '.repeat(14)}</p>`;
  const codes = check.filmReviewIssues(plain).map((i) => i.code);
  assert.ok(codes.includes('no-rating'), 'asks for a score');
  assert.ok(codes.includes('no-where-to-watch'), 'asks where it can be watched');
});

test('the checks run for every blog article, not only films', () => {
  const report = check.analyzeContent(review(), 'blog');
  assert.ok(report.issues.some((i) => i.code === 'copied-synopsis'), 'analysis includes them');
  assert.equal(report.ok, true, 'a warning never blocks publishing');
});

test('the news / rumour guidance exists as a written page', async () => {
  const guide = await readFile(new URL('../FILM-REVIEW-TEMPLATE.md', import.meta.url), 'utf8');
  assert.match(guide, /review|Review/, 'reviews are covered');
  assert.match(guide, /named source|a source you can point to/i, 'news needs a named source');
  assert.match(guide, /noindex|unverified|rumour|Rumour/i, 'unverified gossip has its own rule');
});
