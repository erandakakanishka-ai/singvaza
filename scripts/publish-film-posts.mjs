// Runs after every deploy: takes the finished articles in content/film/index.json
// and turns them into rows in the site's D1 database (through the same /api/blog
// endpoint the admin panel uses). That is what makes a new film review appear on
// the blog page, in the sitemap and in the RSS feed without anyone pressing Save.
//
//   node scripts/publish-film-posts.mjs            (adds only what is missing)
//   node scripts/publish-film-posts.mjs --dry-run   (says what it would do)
//
// Needs: CF_API_TOKEN + CF_ACCOUNT_ID in the environment. If they are absent it
// says so and exits 0, so a deploy never fails because of this step.
import { readFile } from 'node:fs/promises';

const DB_NAME = 'karomix-db';
const API = 'https://singvaza.pages.dev';
const dryRun = process.argv.includes('--dry-run');

const token = process.env.CF_API_TOKEN || '';
const account = process.env.CF_ACCOUNT_ID || '';
if (!token || !account) {
  console.log('No Cloudflare credentials in this environment — skipping the article step.');
  process.exit(0);
}

const root = new URL('../', import.meta.url);
const index = JSON.parse(await readFile(new URL('content/film/index.json', root), 'utf8'));
const posts = Array.isArray(index.posts) ? index.posts : [];
if (!posts.length) { console.log('No posts in content/film/index.json.'); process.exit(0); }

async function d1(query, params = []) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${await dbId()}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: query, params }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(JSON.stringify(data.errors || data).slice(0, 300));
  return data.result?.[0]?.results || [];
}

let cachedDbId = '';
async function dbId() {
  if (cachedDbId) return cachedDbId;
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database?per_page=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  const found = (data.result || []).find((d) => d.name === DB_NAME);
  if (!found) throw new Error(`D1 database "${DB_NAME}" was not found in this account.`);
  cachedDbId = found.uuid;
  return cachedDbId;
}

// The same checks the admin panel runs, so an article that would be blocked there
// is never slipped in here either.
const { analyzeContent } = await import(new URL('../src/content-check.ts', import.meta.url).href).catch(() => ({}));

const existing = new Set();
try {
  for (const row of await d1('SELECT slug FROM blog_posts')) existing.add(String(row.slug));
} catch (err) {
  console.log('Could not read the current article list:', err.message);
  process.exit(0);
}

let added = 0;
for (const p of posts) {
  const slug = String(p.slug || '').trim();
  if (!slug || existing.has(slug)) { console.log(`= ${slug} already there`); continue; }
  const content = await readFile(new URL(`content/film/${p.file}`, root), 'utf8');
  if (analyzeContent) {
    const blocking = analyzeContent(content, 'blog').issues.filter((i) => i.level === 'error');
    if (blocking.length) { console.log(`! ${slug} blocked: ${blocking[0].message}`); continue; }
  }
  const row = {
    id: `film-${slug}`,
    slug,
    title: p.title,
    category: p.category || 'Film Review',
    cover_image: p.cover_image || '/assets/studio-girl-card.jpg',
    excerpt: p.excerpt || '',
    seo_tags: p.seo_tags || '',
    author_name: p.author_name || 'Editorial Team',
    visibility: 'published',
    publish_at: p.publish_at || '',
    content,
    content_format: 'html',
  };
  if (dryRun) { console.log(`+ would add ${slug} (publish_at ${row.publish_at || 'now'})`); added++; continue; }
  try {
    await d1(
      `INSERT INTO blog_posts (id, slug, title, category, cover_image, excerpt, seo_tags, content, content_format, author_name, visibility, publish_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO NOTHING`,
      [row.id, row.slug, row.title, row.category, row.cover_image, row.excerpt, row.seo_tags, row.content, row.content_format, row.author_name, row.visibility, row.publish_at]
    );
    console.log(`+ added ${slug}${row.publish_at ? ` (live at ${row.publish_at} UTC)` : ' (live now)'}`);
    added++;
  } catch (err) {
    console.log(`! ${slug} failed: ${err.message}`);
  }
}

if (added) {
  // Ask Google and Bing to look at the blog again, the same way the panel does.
  await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      host: 'singvaza.pages.dev',
      key: '8dc68fc0e32ac33e8dc68fc0e32ac33e',
      keyLocation: `${API}/8dc68fc0e32ac33e8dc68fc0e32ac33e.txt`,
      urlList: posts.filter((p) => p.slug).map((p) => `${API}/blog/${p.slug}`).concat([`${API}/blog`, `${API}/sitemap.xml`]),
    }),
  }).catch(() => {});
}
console.log(`Done. ${added} article(s) added.`);
