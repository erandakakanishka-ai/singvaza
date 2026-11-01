import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');
const admin = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');

test('an article can be scheduled, and an empty time still means "now"', () => {
  assert.match(worker, /ALTER TABLE blog_posts ADD COLUMN publish_at TEXT DEFAULT ''/, 'the column exists');
  assert.match(
    worker,
    /publish_at IS NULL OR publish_at = '' OR publish_at <= CURRENT_TIMESTAMP/,
    'an empty or past time is visible; a future time is not'
  );
  assert.match(worker, /function normalizePublishAt/, 'a typed time is normalised before it is stored');
  assert.match(worker, /publish_at = excluded\.publish_at/, 'an update keeps the time it was given');
});

test('a scheduled article is hidden from visitors but readable by the owner', () => {
  assert.match(worker, /const scheduled = post && String\(post\.publish_at \|\| ''\)\.trim\(\) !== ''/, 'the single-post page checks the clock');
  assert.match(worker, /String\(post\.visibility \|\| 'published'\) !== 'published' \|\| scheduled/, 'a scheduled post is treated like a hidden one');
});

test('the publisher key adds articles and can do nothing else', () => {
  assert.match(worker, /\/api\/admin\/publisher-key' && request\.method === 'POST'/, 'the key can be created');
  assert.match(worker, /if \(!\(await isValidBlogAdmin\(request, env\)\)\) return json\(\{ error: 'Unauthorized' \}, 401\);\s*\n\s*if \(!env\.DB\) return json\(\{ error: 'Database unavailable' \}, 500\);\s*\n\s*const body: any = await request\.json\(\)\.catch\(\(\) => \(\{\}\)\);\s*\n\s*if \(body\.revoke === true\)/, 'creating or revoking a key needs the owner login');
  assert.match(worker, /sha256Hex\('publisher:' \+ key\)/, 'the key is stored as a hash, never in plain text');
  assert.match(worker, /key\.length < 20/, 'a short key is refused');
  assert.match(worker, /if \(viaPublisherKey && existing\)/, 'the key may not replace a live article');
  // the key must not open the rest of the panel
  const guarded = [...worker.matchAll(/if \(!\(await isValidBlogAdmin\(request, env\)\)\) return json\(\{ error: 'Unauthorized' \}, 401\);/g)];
  assert.ok(guarded.length > 10, 'every other admin route still demands the owner login');
});

test('the panel offers the key and the publish time, and shows what is waiting', () => {
  assert.match(admin, /id="blogPublishAt" type="datetime-local"/, 'a publish time box');
  assert.match(admin, /publish_at: document\.getElementById\('blogPublishAt'\)\.value\.trim\(\)/, 'the box is sent with the article');
  assert.match(admin, /AdminApp\.createPublisherKey\(\)/, 'a button to create the key');
  assert.match(admin, /AdminApp\.revokePublisherKey\(\)/, 'a button to kill it');
  assert.match(admin, /waiting for their time/, 'the list says how many articles are scheduled');
});

test('the handover note lists the standing orders and the queue', async () => {
  const inbox = await readFile(new URL('../INBOX.md', import.meta.url), 'utf8');
  assert.match(inbox, /Two new film posts every day/, 'two posts a day is written down');
  assert.match(inbox, /UTC/, 'the times are UTC');
  assert.match(inbox, /No Sri Lankan film topics/, 'the audience rule is written down');
  assert.match(inbox, /\| Date \| Slug \|/, 'there is a queue');
});

test('the save route owns publishAt, and the visibility switch does not', () => {
  // A const dropped into the wrong route once crashed every publish with a 500.
  const posts = worker.split("url.pathname === '/api/blog' && request.method === 'POST'")[1] || '';
  const body = posts.slice(0, posts.indexOf("url.pathname.startsWith('/api/blog/')"));
  assert.match(body, /const publishAt = normalizePublishAt\(body\.publish_at\);/, 'the article route defines it');
  const visibilityRoute = (worker.split("url.pathname === '/api/admin/visibility'")[1] || '').slice(0, 1200);
  assert.doesNotMatch(visibilityRoute, /const publishAt/, 'the visibility switch does not');
  assert.equal((worker.match(/const publishAt = normalizePublishAt/g) || []).length, 1, 'defined exactly once');
});
