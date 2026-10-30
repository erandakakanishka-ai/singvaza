import { builtinPage, builtinResponse } from './builtin-pages';
import { analyzeContent, compareVersions, mergeIssues } from './content-check';
import { templateById, templateList } from './templates';
import { occasionPresets, isOccasionActive, isOccasionPreview, occasionAppliesTo, injectOccasionBanner } from './occasions';
import { HOLIDAYS, activeHoliday, proWindow, decorPayload, upcoming, HOLIDAY_TAG, windowsAround } from './holidays';
import { buildZip } from './zip';
import { insertBeforeBodyClose } from './html-insert';
import {
  isDownloadableSiteFile, isPublishableTextFile, MAX_TEXT_FILE_BYTES, MAX_FILES_PER_UPLOAD,
  liveKey, undoKey, stageKey, normalizeSitePath, pagePathForFile, summarizeChanges, contentTypeFor,
} from './site-archive';
import { handleSecurityRoute, requiresEntrySession, requireEntrySession, requireAuthChallenge, type SecurityEnv } from './security';

export interface Env extends SecurityEnv {
  DB: D1Database;
  ASSETS?: Fetcher;
  GOOGLE_CLIENT_ID?: string;
  BLOG_ADMIN_CODE?: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Timezone, X-Admin-Code',
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DAILY_FREE_LIMIT = 9;
const DEFAULT_ADMIN_SHA256 = 'b5098ccafc515b07d2d7033a3102e61dcd6ea5d61e91b77d1fce82a4cc3cac16';

let schemaChecked = false;
let memSlIndex: Array<{ t: string; w: string[]; p: string }> | null = null;

let lastSchemaProblems: string[] = [];

async function ensureSchema(db?: D1Database) {
  if (!db || schemaChecked) return;
  const statements = [
    `ALTER TABLE users ADD COLUMN pro_until INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN daily_date TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN daily_exports INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN auth_provider TEXT DEFAULT 'email'`,
    `CREATE TABLE IF NOT EXISTS contact_messages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      subject TEXT DEFAULT 'General Inquiry',
      message TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS cached_lyrics (
      q_norm TEXT PRIMARY KEY,
      plain_lyrics TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS blog_posts (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      category TEXT DEFAULT 'Guide',
      cover_image TEXT DEFAULT '/assets/studio-girl-card.jpg',
      excerpt TEXT DEFAULT '',
      content TEXT NOT NULL,
      content_format TEXT DEFAULT 'html',
      author_name TEXT DEFAULT 'Editor',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `ALTER TABLE blog_posts ADD COLUMN content_format TEXT DEFAULT 'html'`,
    `ALTER TABLE blog_posts ADD COLUMN seo_tags TEXT DEFAULT ''`,
    `ALTER TABLE blog_posts ADD COLUMN visibility TEXT DEFAULT 'published'`,
    `ALTER TABLE blog_posts ADD COLUMN updated_by TEXT DEFAULT ''`,
    `CREATE TABLE IF NOT EXISTS html_tools (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      category TEXT DEFAULT 'Web Tool',
      icon TEXT DEFAULT '⚡',
      description TEXT DEFAULT '',
      seo_tags TEXT DEFAULT '',
      html_code TEXT NOT NULL,
      views INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `ALTER TABLE html_tools ADD COLUMN seo_tags TEXT DEFAULT ''`,
    `ALTER TABLE html_tools ADD COLUMN visibility TEXT DEFAULT 'published'`,
    `ALTER TABLE html_tools ADD COLUMN updated_by TEXT DEFAULT ''`,
    `CREATE TABLE IF NOT EXISTS site_settings (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS analytics_daily (
      day TEXT PRIMARY KEY,
      views INTEGER DEFAULT 0,
      uniques INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS analytics_uniques (
      day_hash TEXT PRIMARY KEY,
      day TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS analytics_countries (
      country TEXT PRIMARY KEY,
      views INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS analytics_pages (
      path TEXT PRIMARY KEY,
      views INTEGER DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_blog_created ON blog_posts(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_tools_created ON html_tools(created_at DESC)`,
  ];
  // D1 can run only one statement per call, so each one is issued on its own. A
  // statement that fails (typically ALTER ... ADD COLUMN on a column that already
  // exists) must not stop the ones after it, or a single duplicate could leave the
  // whole schema half-applied.
  for (const sql of statements) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }
  const schemaProblems: string[] = [];
  for (const sql of statements) {
    try { await db.prepare(sql).run(); } catch (err) {
      const message = String((err as any)?.message || err);
      if (!/duplicate column name|already exists/i.test(message)) schemaProblems.push(message);
    }
  }
  if (schemaProblems.length) {
    // Surfaced through /api/health so a broken migration is visible instead of silent.
    lastSchemaProblems = schemaProblems.slice(0, 8);
  }
  schemaChecked = true;
}

function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPlainBodyToHtml(raw: string): string {
  const blocks = String(raw || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks
    .map((b) => {
      const trimmed = b.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('## ')) {
        return `<h2>${escapeHtml(trimmed.slice(3).trim())}</h2>`;
      }
      if (trimmed.startsWith('### ')) {
        return `<h3>${escapeHtml(trimmed.slice(4).trim())}</h3>`;
      }
      return `<p>${escapeHtml(trimmed).replace(/\n/g, '<br />')}</p>`;
    })
    .filter(Boolean)
    .join('\n');
}

function renderBlogShellHtml(opts: { origin: string; title: string; description: string; keywords?: string; canonicalPath: string; extraHead?: string; bodyHtml: string }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#07090f" />
  <title>${escapeHtml(opts.title)}</title>
  <meta name="description" content="${escapeHtml(opts.description)}" />
  ${opts.keywords ? `<meta name="keywords" content="${escapeHtml(opts.keywords)}" />` : ''}
  <meta property="og:site_name" content="SingVaza" />
  <meta property="og:title" content="${escapeHtml(opts.title)}" />
  <meta property="og:description" content="${escapeHtml(opts.description)}" />
  <meta property="og:url" content="${escapeHtml(opts.origin + opts.canonicalPath)}" />
  <link rel="canonical" href="${escapeHtml(opts.origin + opts.canonicalPath)}" />
  <link rel="icon" href="/favicon.ico" sizes="48x48" />
  <link rel="icon" type="image/png" sizes="96x96" href="/favicon-96.png" />
  <link rel="stylesheet" href="/guard.css?v=1" />
  <script defer src="/guard.js?v=2"></script>
  ${opts.extraHead || ''}
  <style>
    :root { --bg:#07090f; --surface:#111625; --border:rgba(148,163,184,0.16); --text:#f8fafc; --muted:#94a3b8; --amber:#fbbf24; --cyan:#38bdf8; }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; line-height:1.75; padding:24px 16px 64px; }
    .wrap { max-width:860px; margin:0 auto; }
    .top { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:28px; padding-bottom:16px; border-bottom:1px solid var(--border); }
    .brand { display:flex; align-items:center; gap:10px; text-decoration:none; color:var(--text); font-weight:800; font-size:18px; }
    .brand img { width:34px; height:34px; border-radius:9px; }
    .nav-links { display:flex; gap:14px; flex-wrap:wrap; font-size:13.5px; }
    .nav-links a { color:var(--muted); text-decoration:none; }
    .nav-links a:hover { color:var(--amber); }
    .site-search { display:flex;gap:8px;margin:0 0 24px;max-width:510px; }
    .site-search input { min-width:0;flex:1;background:#101725;color:#f8fafc;border:1px solid var(--border);border-radius:10px;padding:11px 12px;font:inherit;font-size:14px; }
    .site-search button { border:0;cursor:pointer;font:inherit;font-size:13px; }
    .sr-only { position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap; }
    h1 { font-size:clamp(25px,4vw,35px); line-height:1.22; margin-bottom:12px; }
    h2 { font-size:20px; margin:20px 0 8px; color:var(--amber); }
    h3 { font-size:17px; margin:16px 0 6px; color:var(--text); }
    p { color:#cbd5e1; margin-bottom:14px; font-size:15px; }
    .card { background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:24px; margin-bottom:18px; }
    .use-tool { display:inline-block;margin-top:10px;font-size:13px;font-weight:700;color:var(--amber); }
    .post-card { text-decoration:none;display:block;transition:border-color .18s,transform .18s; }
    .post-card:hover { border-color:var(--amber); transform:translateY(-1px); }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(265px,1fr)); gap:16px; }
    .post-card { background:var(--surface); border:1px solid var(--border); border-radius:16px; overflow:hidden; text-decoration:none; color:inherit; display:flex; flex-direction:column; }
    .post-card:hover { border-color:var(--amber); }
    .post-card img { width:100%; height:160px; object-fit:cover; display:block; }
    .post-body { padding:16px; flex:1; }
    .tag { font-size:11px; font-weight:800; letter-spacing:0.07em; color:var(--cyan); text-transform:uppercase; }
    .btn { display:inline-block; background:var(--amber); color:#07090f; font-weight:700; text-decoration:none; padding:9px 16px; border-radius:10px; font-size:13.5px; }
    footer { margin-top:34px; padding-top:18px; border-top:1px solid var(--border); text-align:center; font-size:12.5px; color:var(--muted); }
    footer a { color:var(--muted); margin:0 8px; text-decoration:none; }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="top">
      <a class="brand" href="/"><img src="/assets/logo.png" alt="SingVaza" /><span>SING<span style="color:var(--amber);">VAZA</span></span></a>
      <nav class="nav-links" style="align-items:center;">
        <a href="/">Home</a>
        <a href="/tools" ${opts.canonicalPath.startsWith('/tools') ? 'style="color:var(--amber);font-weight:700;"' : ''}>Tools</a>
        <a href="/blog" ${opts.canonicalPath.startsWith('/blog') ? 'style="color:var(--amber);font-weight:700;"' : ''}>Blog</a>
        <a href="/about">About</a>
        <a href="/contact">Contact</a>
        <button onclick="if(navigator.share){navigator.share({title:document.title,url:location.href}).catch(()=>{});}else{navigator.clipboard?.writeText(location.href);alert('Link copied: '+location.href);}" style="background:rgba(251,191,36,0.14);border:1px solid rgba(251,191,36,0.4);color:var(--amber);border-radius:8px;padding:4px 10px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;">Share ↗</button>
      </nav>
    </header>
    <form class="site-search" role="search" action="/" method="get"><label class="sr-only" for="siteShellSearch">Search tools and articles</label><input id="siteShellSearch" name="q" type="search" placeholder="Search tools and articles..." /><button class="btn" type="submit">Search</button></form>
    ${opts.bodyHtml}
    <footer>
      <div>
        <a href="/">Home</a> •
        <a href="/tools">Tools</a> •
        <a href="/blog">Blog</a> •
        <a href="/about">About Us</a> •
        <a href="/contact">Contact Support</a> •
        <a href="/privacy">Privacy Policy</a> •
        <a href="/terms">Terms of Service</a>
      </div>
      <div style="margin-top:8px;">© 2026 SingVaza</div>
    </footer>
  </div>
${HOLIDAY_TAG}</body>
</html>`;
}

/** Add the shared visitor gate even to standalone editor-supplied HTML. */
function addGuardToStandaloneHtml(html: string): string {
  const assets = '<link rel="stylesheet" href="/guard.css?v=1" /><script defer src="/guard.js?v=2"></script>';
  // A compact floating return bar is appended after the editor's content so it
  // does not become a flex/grid item or change the order of their own markup.
  const nav = '<nav aria-label="SingVaza navigation" style="box-sizing:border-box;position:fixed;top:10px;right:10px;z-index:2147482000;display:flex;align-items:center;gap:14px;padding:9px 12px;background:#0b101a;color:#f8fafc;border:1px solid #344154;border-radius:12px;font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px #0008"><a href="/" style="color:#fbbf24;text-decoration:none">← Home</a><a href="/tools" style="color:#f8fafc;text-decoration:none">Tools</a><a href="/blog" style="color:#f8fafc;text-decoration:none">Blog</a></nav>';
  if (/<\/head\s*>/i.test(html)) html = html.replace(/<\/head\s*>/i, (tag) => assets + tag);
  else html = assets + html;
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, (tag) => nav + tag);
  return html + nav;
}

function getUserLocalDayInfo(request: Request) {
  const cfTz = String((request as any).cf?.timezone || '').trim();
  const headerTz = String(request.headers.get('X-Client-Timezone') || '').trim();
  for (const candidate of [cfTz, headerTz, 'UTC']) {
    if (!candidate) continue;
    try {
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: candidate,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
      const parts: Record<string, string> = {};
      for (const p of fmt.formatToParts(new Date())) {
        if (p.type !== 'literal') parts[p.type] = p.value;
      }
      const localDate = `${parts.year}-${parts.month}-${parts.day}`;
      const elapsedMin = Number(parts.hour || 0) * 60 + Number(parts.minute || 0);
      const minutesToMidnight = Math.max(1, 1440 - elapsedMin);
      return { tz: candidate, localDate, minutesToMidnight };
    } catch (_) {}
  }
  return { tz: 'UTC', localDate: new Date().toISOString().slice(0, 10), minutesToMidnight: 720 };
}

function buildQuotaSummary(user: Record<string, any> | null, authenticated: boolean, tzInfo: { tz: string; localDate: string; minutesToMidnight: number }) {
  const now = Date.now();
  const proUntil = authenticated && user ? Number(user.pro_until || 0) : 0;
  const manualPro = authenticated && user && user.plan && user.plan !== 'free';
  const proActive = Boolean(manualPro || proUntil > now);
  const proDaysLeft = proUntil > now ? Math.max(1, Math.ceil((proUntil - now) / 86400000)) : 0;
  const dailyUsed = authenticated && user && user.daily_date === tzInfo.localDate
    ? Number(user.daily_exports || 0)
    : 0;
  return {
    proActive,
    proDaysLeft,
    proUntil,
    dailyUsed,
    dailyLimit: DAILY_FREE_LIMIT,
    timezone: tzInfo.tz,
    localDate: tzInfo.localDate,
    minutesToMidnight: tzInfo.minutesToMidnight,
  };
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode('karomix_salt_v1:' + input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const EDITABLE_PAGES = [
  { path: '/', label: 'Home page' },
  { path: '/about', label: 'About' },
  { path: '/contact', label: 'Contact' },
  { path: '/privacy', label: 'Privacy Policy' },
  { path: '/terms', label: 'Terms & Conditions' },
  { path: '/refunds', label: 'Refund Policy' },
];

async function setSetting(db: D1Database, key: string, value: string) {
  await db.prepare(
    `INSERT INTO site_settings (k, v, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = CURRENT_TIMESTAMP`
  ).bind(key, value).run();
}

/** Read a static asset as text (the page files are not readable through fetch on the edge). */
async function fetchAssetText(env: Env, assetUrl: string): Promise<string> {
  try {
    const request = new Request(assetUrl, { headers: { Accept: 'text/html' } });
    const res = env.ASSETS
      ? await env.ASSETS.fetch(request)
      : await fetch(assetUrl);
    if (!res || !res.ok) return '';
    return await res.text();
  } catch (_) {
    return '';
  }
}

/** Apply the admin edits (page upload, private switch, seasonal greeting) to a static page. */
async function applyPageOverride(path: string, html: string, env: Env, isAdmin = false, previewRequested = false): Promise<string> {
  if (!env.DB || !EDITABLE_PAGES.some((p) => p.path === path) || !/<\/body\s*>/i.test(html)) return html;
  try {
    const sMap = await getSettingsMap(env.DB);
    if (!isAdmin && sMap['page_visibility:' + path] === 'hidden') {
      return renderBlogShellHtml({
        origin: 'https://singvaza.pages.dev',
        title: 'Page unavailable — SingVaza',
        description: 'This page is temporarily unavailable.',
        canonicalPath: path,
        bodyHtml: `<div class="card"><h1>Temporarily unavailable</h1><p>This page is being checked and will be back shortly.</p><p><a class="btn" href="/">← Back to Home</a></p></div>`,
      });
    }

    // The page that will actually be served: an uploaded version if there is one.
    let page = html;
    const override = sMap['page_override:' + path];
    if (override) {
      page = override;
      // Keep the per-visit view counter of the asset when the uploaded page has none.
      if (!/ping-visit/.test(page)) {
        const beacon = html.match(/<script>try\{if\(!sessionStorage[\s\S]*?<\/script>/i);
        if (beacon) page = page.replace(/<\/body\s*>/i, beacon[0] + '</body>');
      }
    }

    // Seasonal greeting: added on the way out, only inside its own dates (or for a
    // signed-in admin preview), so the stored page and the design are never
    // overwritten and the site returns to normal by itself when the dates pass.
    const rawOccasion = sMap['occasion_config'];
    if (rawOccasion && /<body[^>]*>/i.test(page)) {
      try {
        const config = JSON.parse(rawOccasion);
        // The automatic holidays come first: on 25 December the Christmas greeting
        // is the one people should see, not two bars stacked on top of each other.
        const autoToday = activeHoliday(new Date().toISOString().slice(0, 10));
        const insideDates = isOccasionActive(config) && !autoToday;
        const preview = !insideDates && !autoToday && isOccasionPreview(config, previewRequested, isAdmin || previewRequested);
        if ((insideDates || preview) && occasionAppliesTo(config, path)) {
          page = injectOccasionBanner(page, config);
        }
      } catch (_) {}
    }
    // Seasonal decoration (see src/holidays.ts): a tiny deferred script, added to
    // every page the worker serves too. Without a holiday it costs nothing.
    if (!page.includes('/holiday.js')) page = insertBeforeBodyClose(page, HOLIDAY_TAG);
    return page;
  } catch (_) {
    return html;
  }
}

/** Run the static checks and verify that every same-origin asset really exists. */
async function analyzeWithAssets(html: string, kind: 'tool' | 'blog' | 'page', env: Env, origin: string) {
  const report = analyzeContent(html, kind);
  const missing: string[] = [];
  for (const ref of report.localRefs) {
    try {
      const assetUrl = new URL(ref, origin).toString();
      const probe = env.ASSETS
        ? await env.ASSETS.fetch(new Request(assetUrl, { method: 'HEAD' }))
        : await fetch(assetUrl, { method: 'HEAD' });
      if (probe && probe.status === 404) missing.push(ref);
    } catch (_) {
      // A network hiccup must never block publishing.
    }
  }
  const issues = [...report.issues];
  if (missing.length) {
    issues.push({
      level: 'warn',
      code: 'missing-assets',
      message: `${missing.length} local file(s) not found: ${missing.slice(0, 5).join(', ')}`,
    });
  }
  return { ...report, ok: issues.every((i) => i.level !== 'error'), issues };
}

/**
 * Offline review. No model is called: the admin asked for an "AI check", and the
 * honest, free version of that is a rule engine plus the stored-version diff, so
 * the verdict is instant, private and identical every time. The result reads like
 * a reviewer's note: what is wrong, where, and how bad.
 */
function heuristicReview(report: any, html: string) {
  const errors = report.issues.filter((i: any) => i.level === 'error');
  const warns = report.issues.filter((i: any) => i.level === 'warn');
  const infos = report.issues.filter((i: any) => i.level === 'info');
  const verdict = errors.length ? 'broken' : warns.length ? 'needs-attention' : 'healthy';
  const risk: string[] = [];
  if (report.stats.externalScripts.length) risk.push('external code');
  if (/\bfetch\s*\(\s*['"]https?:/i.test(html)) risk.push('sends data to another site');
  if (/\blocalStorage\b|\bindexedDB\b/i.test(html)) risk.push('stores data in the browser');
  if (/<form[^>]+action=["']https?:/i.test(html)) risk.push('posts a form to another site');
  if (/\beval\s*\(|new Function\(/i.test(html)) risk.push('runs generated code');
  const notes: string[] = [];
  if (!report.stats.scripts) notes.push('No JavaScript: the page is static, so nothing can break at run time.');
  if (report.stats.forms === 0 && report.stats.scripts > 0) notes.push('Interactive, but without a form.');
  if (report.fingerprint.headings.length) notes.push(`Main heading: "${report.fingerprint.headings[0]}".`);
  notes.push(`${report.fingerprint.textLength} characters of readable text, ${report.stats.links} links, ${report.stats.images} images.`);
  return {
    verdict,
    score: Math.max(0, 100 - errors.length * 35 - warns.length * 8 - infos.length * 2),
    summary: errors.length
      ? `Not safe to publish: ${errors.length} breaking problem${errors.length === 1 ? '' : 's'}.`
      : warns.length
        ? `Publishable, but ${warns.length} point${warns.length === 1 ? '' : 's'} worth fixing.`
        : 'Looks healthy. Nothing blocking was found.',
    findings: [...errors, ...warns, ...infos],
    risk,
    notes,
    engine: 'rule-engine',
  };
}

async function isValidBlogAdmin(request: Request, env: Env): Promise<boolean> {
  const auth = String(request.headers.get('Authorization') || '').trim();
  if (auth.startsWith('Bearer ') && env.DB) {
    const tok = auth.slice(7).trim();
    if (tok) {
      try {
        const row: any = await env.DB.prepare('SELECT token, expires_at FROM admin_sessions WHERE token = ?').bind(tok).first();
        if (row && Number(row.expires_at || 0) > Date.now()) return true;
      } catch (_) {}
    }
  }
  const code = String(request.headers.get('X-Admin-Code') || '').trim();
  if (!code) return false;
  if (env.BLOG_ADMIN_CODE && code === env.BLOG_ADMIN_CODE) return true;
  const hashed = await sha256Hex('admin:' + code);
  return hashed === DEFAULT_ADMIN_SHA256;
}

/** Forgets the short-lived cache the middleware keeps of replaced files, so a
 *  publish or an undo is visible on the next request. */
async function bustOverridesCache(url: URL): Promise<void> {
  try {
    const cache = (globalThis as any).caches?.default;
    if (cache) await cache.delete(new Request(new URL('/__sv_live_overrides', url).toString()));
  } catch (_) {}
}

/** Every static file of the site, as written by scripts/make-manifest.mjs.
 *  Read from the assets themselves so the list can never drift from what ships. */
async function readManifest(env: Env): Promise<string[]> {
  try {
    const res = await env.ASSETS?.fetch(new Request('https://singvaza.pages.dev/site-manifest.json'));
    if (!res || !res.ok) return [];
    const data: any = await res.json();
    return Array.isArray(data.files) ? data.files.map((f: any) => String(f)) : [];
  } catch (_) {
    return [];
  }
}

/** Signature for a holiday preview link: HMAC over the season id and the expiry,
 *  keyed with the admin password hash, so the link cannot be guessed or edited. */
async function holidayPreviewSignature(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('singvaza-holiday:' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return Array.from(sig).slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Short-lived signature for an occasion preview link: HMAC over the expiry. */
async function occasionPreviewSignature(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('singvaza-occasion:' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return Array.from(sig).slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getSettingsMap(db?: D1Database): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  if (!db) return map;
  try {
    const rows = await db.prepare('SELECT k, v FROM site_settings').all();
    for (const r of (rows.results || []) as any[]) {
      if (r?.k) map[String(r.k)] = String(r.v ?? '');
    }
  } catch (_) {}
  return map;
}

async function recordEdgeVisit(request: Request, db?: D1Database, rawPath = '/') {
  if (!db) return;
  try {
    const cleanP = (String(rawPath || '/').split('?')[0] || '/').slice(0, 120);
    if (cleanP.startsWith('/admin') || cleanP.startsWith('/api')) return;
    const uaFull = String(request.headers.get('User-Agent') || '');
    if (/bot|crawler|spider|preview|curl|wget|python|headless|facebookexternalhit|whatsapp|telegrambot|slurp|mediapartners/i.test(uaFull)) {
      return;
    }
    const day = new Date().toISOString().slice(0, 10);
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'anon';
    const ua = uaFull.slice(0, 80);
    const country = (request.headers.get('CF-IPCountry') || (request as any).cf?.country || 'XX').toUpperCase().slice(0, 4);
    const visitorHash = (await sha256Hex(`${day}:${ip}:${ua}`)).slice(0, 20);

    const ins = await db.prepare('INSERT OR IGNORE INTO analytics_uniques (day_hash, day) VALUES (?, ?)').bind(visitorHash, day).run();
    const isNewUnique = (ins.meta?.changes || 0) > 0 ? 1 : 0;

    await db.prepare(
      `INSERT INTO analytics_daily (day, views, uniques) VALUES (?, 1, ?)
       ON CONFLICT(day) DO UPDATE SET views = views + 1, uniques = uniques + excluded.uniques`
    ).bind(day, isNewUnique).run();

    await db.prepare(
      `INSERT INTO analytics_countries (country, views) VALUES (?, 1)
       ON CONFLICT(country) DO UPDATE SET views = views + 1`
    ).bind(country).run();

    await db.prepare(
      `INSERT INTO analytics_pages (path, views) VALUES (?, 1)
       ON CONFLICT(path) DO UPDATE SET views = views + 1`
    ).bind(cleanP).run();
  } catch (_) {}
}

async function resolveUser(request: Request, env: Env) {
  await ensureSchema(env.DB);
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';

  if (env.DB && token) {
    try {
      const sess = await env.DB.prepare(
        `SELECT u.id, u.email, u.display_name, u.plan, u.currency, u.exports_this_month,
                u.pro_until, u.daily_date, u.daily_exports, u.auth_provider
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
      ).bind(token).first();
      if (sess) return { user: sess as Record<string, any>, authenticated: true };
    } catch (_) {}
  }

  const fallbackId = 'demo-singer-global';
  if (env.DB) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, email, password_hash, display_name, plan, currency, exports_this_month)
       VALUES (?, 'guest@singvaza.com', '', 'Guest Artist', 'free', 'USD', 0)`
    ).bind(fallbackId).run();
    const u = await env.DB.prepare(
      'SELECT id, email, display_name, plan, currency, exports_this_month, pro_until, daily_date, daily_exports FROM users WHERE id = ?'
    ).bind(fallbackId).first();
    if (u) return { user: u as Record<string, any>, authenticated: false };
  }

  return {
    user: { id: fallbackId, email: 'guest@singvaza.com', display_name: 'Guest Artist', plan: 'free', currency: 'USD', exports_this_month: 0, pro_until: 0, daily_date: '', daily_exports: 0 },
    authenticated: false,
  };
}

async function searchKaraokeVideos(rawQuery: string) {
  const clean = rawQuery.trim();
  if (!clean) return [];
  const lower = clean.toLowerCase();
  const fullQuery = lower.includes('karaoke') || lower.includes('instrumental')
    ? clean
    : `${clean} karaoke version`;

  try {
    const ytRes = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(fullQuery)}&hl=en`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      }
    );
    if (ytRes.ok) {
      const html = await ytRes.text();
      const match = html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
      if (match) {
        const data = JSON.parse(match[1]);
        const sections =
          data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
        const candidates: Array<Record<string, string>> = [];
        for (const sec of sections) {
          const items = sec?.itemSectionRenderer?.contents || [];
          for (const it of items) {
            const vr = it?.videoRenderer;
            if (!vr?.videoId) continue;
            const title = (vr.title?.runs || []).map((r: any) => r.text || '').join('');
            const channel = (vr.ownerText?.runs || []).map((r: any) => r.text || '').join('');
            const duration = vr.lengthText?.simpleText || '';
            candidates.push({
              id: vr.videoId,
              title,
              channel,
              duration,
              thumbnail: `https://i.ytimg.com/vi/${vr.videoId}/mqdefault.jpg`,
            });
            if (candidates.length >= 16) break;
          }
          if (candidates.length >= 16) break;
        }
        if (candidates.length > 0) {
          const verified = await Promise.all(
            candidates.map(async (c) => {
              try {
                const check = await fetch(
                  `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(c.id)}&format=json`
                );
                return check.status === 200 ? c : null;
              } catch (_) {
                return c;
              }
            })
          );
          const playable = verified.filter(Boolean) as Array<Record<string, string>>;
          playable.sort((a, b) => {
            const ak = /karaoke|instrumental|backing/i.test(a.title) ? 0 : 1;
            const bk = /karaoke|instrumental|backing/i.test(b.title) ? 0 : 1;
            return ak - bk;
          });
          if (playable.length > 0) return playable.slice(0, 8);
          return candidates.slice(0, 6);
        }
      }
    }
  } catch (_) {}

  const mirrors = [
    `https://inv.nadeko.net/api/v1/search?q=${encodeURIComponent(fullQuery)}&type=video`,
    `https://invidious.nerdvpn.de/api/v1/search?q=${encodeURIComponent(fullQuery)}&type=video`,
  ];
  for (const url of mirrors) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) continue;
      const arr = (await r.json()) as any[];
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.slice(0, 8).map((v) => ({
          id: v.videoId,
          title: v.title || 'Karaoke Track',
          channel: v.author || 'Karaoke Channel',
          duration: v.lengthSeconds ? `${Math.floor(v.lengthSeconds / 60)}:${String(v.lengthSeconds % 60).padStart(2, '0')}` : '',
          thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
        }));
      }
    } catch (_) {}
  }

  return [];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      const cleanPath = (() => {
        try { return decodeURIComponent(url.pathname).replace(/^\/\s+/, '/').replace(/\s+$/, ''); } catch (_) { return url.pathname; }
      })();

      if ((request.method === 'GET' || request.method === 'HEAD') && builtinPage(cleanPath) && env.ASSETS) {
        const assetUrl = new URL('/', url);
        const asset = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
        return builtinResponse(asset, request);
      }

      const securityResponse = await handleSecurityRoute(request, env);
      if (securityResponse) return securityResponse;
      if (requiresEntrySession(cleanPath, request.method)) {
        const entryError = await requireEntrySession(request, env);
        if (entryError) return entryError;
      }

      if (cleanPath === '/google8dc68fc0e32ac33e.html') {
        return new Response(request.method === 'HEAD' ? null : 'google-site-verification: google8dc68fc0e32ac33e.html', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
        });
      }

      if (cleanPath === '/8dc68fc0e32ac33e8dc68fc0e32ac33e.txt') {
        return new Response('8dc68fc0e32ac33e8dc68fc0e32ac33e', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' },
        });
      }

      // Ultra-Fast Cold-Start Sitemap XML & RSS 2.0 Feed (0 DDL queries on read = ~8ms instant response for Googlebot!)
      if ((cleanPath === '/sitemap.xml' || cleanPath === '/rss.xml') && (request.method === 'GET' || request.method === 'HEAD')) {
        const staticPaths = [
          { p: '/', pri: '1.0' },
          { p: '/blog', pri: '0.9' },
          { p: '/tools', pri: '0.9' },
          { p: '/studio/karaoke-recorder', pri: '0.85' },
          { p: '/about', pri: '0.8' },
          { p: '/contact', pri: '0.8' },
          { p: '/privacy', pri: '0.7' },
          { p: '/terms', pri: '0.6' },
          { p: '/refunds', pri: '0.6' },
        ];
        let postsList: any[] = [];
        let toolsList: any[] = [];
        if (env.DB) {
          try {
            const [rows, tRows] = await Promise.all([
              env.DB.prepare("SELECT slug, title, excerpt, updated_at FROM blog_posts WHERE COALESCE(visibility, 'published') = 'published' ORDER BY updated_at DESC LIMIT 200").all(),
              env.DB.prepare("SELECT slug, title, description, updated_at FROM html_tools WHERE COALESCE(visibility, 'published') = 'published' ORDER BY updated_at DESC LIMIT 200").all(),
            ]);
            postsList = (rows.results || []) as any[];
            toolsList = (tRows.results || []) as any[];
          } catch (_) {}
        }

        if (cleanPath === '/rss.xml') {
          let itemsXml = '';
          for (const p of postsList) {
            itemsXml += `\n    <item><title>${escapeHtml(p.title)}</title><link>${escapeHtml(url.origin)}/blog/${escapeHtml(p.slug)}</link><description>${escapeHtml(p.excerpt || '')}</description></item>`;
          }
          for (const t of toolsList) {
            itemsXml += `\n    <item><title>${escapeHtml(t.title)}</title><link>${escapeHtml(url.origin)}/tools/${escapeHtml(t.slug)}</link><description>${escapeHtml(t.description || '')}</description></item>`;
          }
          const rss = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n    <title>SingVaza — Karaoke Studio, Articles &amp; Online Tools</title>\n    <link>${escapeHtml(url.origin)}/</link>\n    <description>Free online karaoke vocal recorder, audio mastering, tutorials, and web tools.</description>${itemsXml}\n  </channel>\n</rss>\n`;
          return new Response(request.method === 'HEAD' ? null : rss, {
            status: 200,
            headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
          });
        }

        let postUrls = '';
        for (const r of postsList) {
          const d = String(r.updated_at || '').slice(0, 10) || '2026-10-23';
          postUrls += `\n  <url>\n    <loc>${escapeHtml(url.origin)}/blog/${escapeHtml(r.slug)}</loc>\n    <lastmod>${d}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.85</priority>\n  </url>`;
        }
        if (toolsList.length > 0) {
          for (const t of toolsList) {
            const d = String(t.updated_at || '').slice(0, 10) || '2026-10-23';
            postUrls += `\n  <url>\n    <loc>${escapeHtml(url.origin)}/tools/${escapeHtml(t.slug)}</loc>\n    <lastmod>${d}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.85</priority>\n  </url>`;
          }
        }
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${staticPaths
          .map((s) => `\n  <url>\n    <loc>${escapeHtml(url.origin + s.p)}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>${s.pri}</priority>\n  </url>`)
          .join('')}${postUrls}\n</urlset>\n`;
        return new Response(request.method === 'HEAD' ? null : xml, {
          status: 200,
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=300, s-maxage=300',
          },
        });
      }

      // Dynamic HTML Web Tools Hub & Individual Standalone HTML Tools (/tools & /tools/:slug)
      if ((cleanPath === '/tools' || cleanPath === '/tools/' || cleanPath.startsWith('/tools/')) && (request.method === 'GET' || request.method === 'HEAD')) {
        await ensureSchema(env.DB);
        const sMapAd = await getSettingsMap(env.DB);
        const globalAdSnippet = sMapAd.ads_enabled === 'true'
          ? ((sMapAd.adsense_client_id ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${escapeHtml(sMapAd.adsense_client_id)}" crossorigin="anonymous"></script>` : '') + (sMapAd.custom_ad_code || ''))
          : '';
        const toolSlug = cleanPath.replace(/^\/tools\/?/, '').replace(/\/$/, '').trim();
        const beaconTag = `${globalAdSnippet}<script>try{if(!sessionStorage.getItem('sv_v_'+location.pathname)){sessionStorage.setItem('sv_v_'+location.pathname,'1');fetch('/api/ping-visit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:location.pathname})}).catch(()=>{});}}catch(_){}</script>`;
        if (!toolSlug) {
          const rows = env.DB
            ? await env.DB.prepare("SELECT id, slug, title, category, icon, description, views, created_at FROM html_tools WHERE COALESCE(visibility, 'published') = 'published' ORDER BY created_at DESC LIMIT 200").all()
            : { results: [] };
          const list = (rows.results || []) as any[];
          const bodyHtml = `
            <h1>Online Tools</h1>
            <p style="color:var(--muted);margin-bottom:24px;">Fast browser-based utilities and interactive web tools.</p>
            <div class="grid">
              <a class="post-card" href="/studio/karaoke-recorder" style="padding:20px;"><div style="font-size:28px;margin-bottom:10px;">🎙</div><div class="tag">Audio Tool</div><h2 style="font-size:17.5px;color:var(--text);margin:6px 0 8px;">Karaoke Recorder</h2><p style="font-size:13.5px;color:var(--muted);margin:0;">Sing, record, mix and master your song.</p><span class="use-tool">Use this tool →</span></a>
              <a class="post-card" href="/studio/office-to-pdf" style="padding:20px;"><div style="font-size:28px;margin-bottom:10px;">📄</div><div class="tag">Document Tool</div><h2 style="font-size:17.5px;color:var(--text);margin:6px 0 8px;">Word / Excel / PowerPoint to PDF</h2><p style="font-size:13.5px;color:var(--muted);margin:0;">Turn a .docx, .xlsx or .pptx into a clean PDF, on your own device.</p><span class="use-tool">Use this tool →</span></a>
              <a class="post-card" href="/studio/html-to-pdf" style="padding:20px;"><div style="font-size:28px;margin-bottom:10px;">🧾</div><div class="tag">Document Tool</div><h2 style="font-size:17.5px;color:var(--text);margin:6px 0 8px;">HTML / Code to PDF</h2><p style="font-size:13.5px;color:var(--muted);margin:0;">Turn HTML, Markdown or code into a PDF, Word, Excel or PowerPoint file.</p><span class="use-tool">Use this tool →</span></a>
              ${list.map((t) => `
                <a class="post-card" href="/tools/${escapeHtml(t.slug)}" style="padding:20px;">
                  <div style="font-size:28px;margin-bottom:10px;">${escapeHtml(t.icon || '⚡')}</div>
                  <div class="tag">${escapeHtml(t.category || 'Web Tool')}</div>
                  <h2 style="font-size:17.5px;color:var(--text);margin:6px 0 8px;">${escapeHtml(t.title)}</h2>
                  <p style="font-size:13.5px;color:var(--muted);margin:0;">${escapeHtml(t.description || '')}</p>
                  <span class="use-tool">Use this tool →</span>
                </a>`).join('')}
            </div>${beaconTag}`;
          return new Response(
            request.method === 'HEAD' ? null : renderBlogShellHtml({
              origin: url.origin,
              title: 'Online Tools — SingVaza',
              description: 'Fast browser utilities and interactive tools on SingVaza.',
              canonicalPath: '/tools',
              bodyHtml,
            }),
            { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=30, s-maxage=180' } }
          );
        }

        const tool: any = env.DB
          ? await env.DB.prepare('SELECT * FROM html_tools WHERE slug = ?').bind(toolSlug).first()
          : null;
        // A tool switched off in the admin panel disappears from the public site,
        // but stays reachable for the signed-in admin so it can be checked.
        if (tool && String(tool.visibility || 'published') !== 'published' && !(await isValidBlogAdmin(request, env))) {
          return new Response(
            renderBlogShellHtml({
              origin: url.origin,
              title: 'Tool Not Available — SingVaza',
              description: 'This tool is temporarily unavailable.',
              canonicalPath: '/tools',
              bodyHtml: `<div class="card"><h1>Tool temporarily unavailable</h1><p>This tool is being checked. Please come back later.</p><p><a class="btn" href="/tools">← View All Tools</a></p></div>`,
            }),
            { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
          );
        }
        if (!tool) {
          return new Response(
            renderBlogShellHtml({
              origin: url.origin,
              title: 'Tool Not Found — SingVaza',
              description: 'Tool not found.',
              canonicalPath: '/tools',
              bodyHtml: `<div class="card"><h1>Tool Not Found</h1><p><a class="btn" href="/tools">← View All Tools</a></p></div>`,
            }),
            { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        }
        try { await env.DB?.prepare('UPDATE html_tools SET views = views + 1 WHERE id = ?').bind(tool.id).run(); } catch (_) {}
        const rawToolHtml = String(tool.html_code || '');
        const toolSeoHead = `
  <meta name="description" content="${escapeHtml(tool.description || tool.title)}" />
  ${tool.seo_tags ? `<meta name="keywords" content="${escapeHtml(tool.seo_tags)}" />` : ''}
  <meta property="og:site_name" content="SingVaza" />
  <meta property="og:title" content="${escapeHtml(tool.title)} — SingVaza Tools" />
  <meta property="og:description" content="${escapeHtml(tool.description || tool.title)}" />
  <link rel="canonical" href="${escapeHtml(url.origin + '/tools/' + tool.slug)}" />
  <link rel="icon" href="/favicon.ico" sizes="48x48" />`;
        let enrichedTool = rawToolHtml;
        if (enrichedTool.includes('</head>')) {
          enrichedTool = enrichedTool.replace('</head>', `${toolSeoHead}\n</head>`);
        }
        const withBeacon = enrichedTool.includes('</body>') ? enrichedTool.replace('</body>', `${beaconTag}</body>`) : (enrichedTool + beaconTag);
        return new Response(request.method === 'HEAD' ? null : addGuardToStandaloneHtml(withBeacon), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60, s-maxage=300' },
        });
      }

      // Dynamic SEO Server-Side Rendered Blog Index & Single Post Pages (/blog & /blog/:slug — supports Plain, Rich HTML, & Full Standalone HTML!)
      if ((url.pathname === '/blog' || url.pathname === '/blog/' || url.pathname.startsWith('/blog/')) && (request.method === 'GET' || request.method === 'HEAD')) {
        await ensureSchema(env.DB);
        const sMapAd = await getSettingsMap(env.DB);
        const globalAdSnippet = sMapAd.ads_enabled === 'true'
          ? ((sMapAd.adsense_client_id ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${escapeHtml(sMapAd.adsense_client_id)}" crossorigin="anonymous"></script>` : '') + (sMapAd.custom_ad_code || ''))
          : '';
        const beaconTag = `${globalAdSnippet}<script>try{if(!localStorage.getItem('singvaza_admin_token')&&!sessionStorage.getItem('sv_v_'+location.pathname)){sessionStorage.setItem('sv_v_'+location.pathname,'1');fetch('/api/ping-visit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:location.pathname})}).catch(()=>{});}}catch(_){}</script>`;
        const slugPart = url.pathname.replace(/^\/blog\/?/, '').replace(/\/$/, '').trim();
        if (!slugPart) {
          const rows = env.DB
            ? await env.DB.prepare("SELECT id, slug, title, category, cover_image, excerpt, author_name, created_at FROM blog_posts WHERE COALESCE(visibility, 'published') = 'published' ORDER BY created_at DESC LIMIT 100").all()
            : { results: [] };
          const list = (rows.results || []) as any[];
          const bodyHtml = `
            <h1>SingVaza Blog & Articles</h1>
            <p style="color:var(--muted);margin-bottom:24px;">Latest tutorials, guides, technology insights, and resources.</p>
            ${list.length === 0
              ? `<div class="card"><p style="margin:0;">New articles are coming soon. <a href="/" style="color:var(--amber);">Back to Home →</a></p></div>`
              : `<div class="grid">${list.map((p) => `
                <a class="post-card" href="/blog/${escapeHtml(p.slug)}">
                  <img src="${escapeHtml(p.cover_image || '/assets/studio-girl-card.jpg')}" alt="${escapeHtml(p.title)}" />
                  <div class="post-body">
                    <div class="tag">${escapeHtml(p.category || 'Article')}</div>
                    <h2 style="font-size:17px;color:var(--text);margin:6px 0 8px;">${escapeHtml(p.title)}</h2>
                    <p style="font-size:13.5px;color:var(--muted);margin:0;">${escapeHtml(p.excerpt || '')}</p>
                  </div>
                </a>`).join('')}</div>`
            }${beaconTag}`;
          return new Response(
            request.method === 'HEAD' ? null : renderBlogShellHtml({
              origin: url.origin,
              title: 'Blog & Articles — SingVaza',
              description: 'Latest tutorials, guides, technology articles, and resources on SingVaza.',
              canonicalPath: '/blog',
              bodyHtml,
            }),
            { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=30, s-maxage=180' } }
          );
        }

        const post: any = env.DB
          ? await env.DB.prepare('SELECT * FROM blog_posts WHERE slug = ?').bind(slugPart).first()
          : null;
        // A hidden article is invisible to visitors but readable by the admin.
        if (post && String(post.visibility || 'published') !== 'published' && !(await isValidBlogAdmin(request, env))) {
          return new Response(
            renderBlogShellHtml({
              origin: url.origin,
              title: 'Article Unavailable — SingVaza',
              description: 'This article is temporarily unavailable.',
              canonicalPath: '/blog',
              bodyHtml: `<div class="card"><h1>Article temporarily unavailable</h1><p>This article is being checked and will be back shortly.</p><p><a class="btn" href="/blog">← View All Articles</a></p></div>`,
            }),
            { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
          );
        }
        if (!post) {
          return new Response(
            renderBlogShellHtml({
              origin: url.origin,
              title: 'Article Not Found — SingVaza',
              description: 'Article not found.',
              canonicalPath: '/blog',
              bodyHtml: `<div class="card"><h1>Article Not Found</h1><p><a class="btn" href="/blog">← View All Articles</a></p></div>`,
            }),
            { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        }

        const rawContent = String(post.content || '');
        const fmt = String(post.content_format || '').toLowerCase();
        const isStandaloneDoc = fmt === 'full_html' || /^\s*<!doctype html/i.test(rawContent) || /^\s*<html[\s>]/i.test(rawContent);
        const postDesc = post.excerpt || rawContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 155);
        const postTagsStr = String(post.seo_tags || '').trim();
        const articleJsonLd = `<script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: post.title,
          description: postDesc,
          keywords: postTagsStr || post.category || 'Guide',
          author: { '@type': 'Person', name: post.author_name || 'SingVaza Editorial' },
          publisher: { '@type': 'Organization', name: 'SingVaza' },
          mainEntityOfPage: `${url.origin}/blog/${post.slug}`,
        })}</script>`;

        if (isStandaloneDoc) {
          const standaloneHead = `
  <meta name="description" content="${escapeHtml(postDesc)}" />
  ${postTagsStr ? `<meta name="keywords" content="${escapeHtml(postTagsStr)}" />` : ''}
  <meta property="og:site_name" content="SingVaza" />
  <meta property="og:title" content="${escapeHtml(post.title)}" />
  <link rel="canonical" href="${escapeHtml(url.origin + '/blog/' + post.slug)}" />
  ${articleJsonLd}`;
          let enrichedFull = rawContent.includes('</head>') ? rawContent.replace('</head>', `${standaloneHead}\n</head>`) : rawContent;
          const fullWithBeacon = enrichedFull.includes('</body>') ? enrichedFull.replace('</body>', `${beaconTag}</body>`) : (enrichedFull + beaconTag);
          return new Response(request.method === 'HEAD' ? null : addGuardToStandaloneHtml(fullWithBeacon), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60, s-maxage=300' },
          });
        }

        const isRichHtml = fmt === 'html' || /<(p|div|h1|h2|h3|h4|ul|ol|table|section|article|style|img|pre|blockquote)\b/i.test(rawContent);
        const articleInner = isRichHtml ? rawContent : renderPlainBodyToHtml(rawContent);
        const tagPillsHtml = postTagsStr
          ? `<div style="margin-top:18px;display:flex;gap:6px;flex-wrap:wrap;">${postTagsStr.split(',').map((tg) => tg.trim()).filter(Boolean).map((tg) => `<span style="font-size:11.5px;background:rgba(56,189,248,0.1);border:1px solid rgba(56,189,248,0.25);color:var(--cyan);padding:3px 9px;border-radius:999px;">#${escapeHtml(tg)}</span>`).join('')}</div>`
          : '';

        const bodyHtml = `
          <article class="card">
            <p style="margin-bottom:14px;"><a href="/blog" style="color:var(--cyan);text-decoration:none;font-size:13.5px;">← Back to All Articles</a></p>
            ${post.cover_image ? `<img src="${escapeHtml(post.cover_image)}" alt="${escapeHtml(post.title)}" style="width:100%;max-height:360px;object-fit:cover;border-radius:12px;margin-bottom:18px;" />` : ''}
            <div class="tag">${escapeHtml(post.category || 'Article')} • By ${escapeHtml(post.author_name || 'Editor')} • ${escapeHtml(String(post.created_at || '').slice(0, 10))}</div>
            <h1 style="margin-top:8px;">${escapeHtml(post.title)}</h1>
            <div class="rich-article-body" style="margin-top:16px;line-height:1.78;">${articleInner}</div>
            ${tagPillsHtml}
            <div style="margin-top:26px;padding-top:16px;border-top:1px solid var(--border);display:flex;gap:10px;flex-wrap:wrap;">
              <a class="btn" href="/">← Back to SingVaza</a>
            </div>
          </article>${beaconTag}
        `;
        return new Response(
          request.method === 'HEAD' ? null : renderBlogShellHtml({
            origin: url.origin,
            title: `${post.title} — SingVaza`,
            description: postDesc,
            keywords: postTagsStr,
            extraHead: articleJsonLd,
            canonicalPath: `/blog/${post.slug}`,
            bodyHtml,
          }),
          { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60, s-maxage=300' } }
        );
      }

      // Public Analytics Beacon & Dynamic Site Config
      if (url.pathname === '/api/ping-visit' && request.method === 'POST') {
        await ensureSchema(env.DB);
        const body: any = await request.json().catch(() => ({}));
        await recordEdgeVisit(request, env.DB, String(body?.path || '/'));
        return json({ ok: true });
      }

      if (url.pathname === '/api/public-config' && request.method === 'GET') {
        await ensureSchema(env.DB);
        const s = await getSettingsMap(env.DB);
        let toolsCount = 0;
        if (env.DB) {
          try {
            const tc: any = await env.DB.prepare('SELECT COUNT(*) AS c FROM html_tools').first();
            toolsCount = Number(tc?.c || 0);
          } catch (_) {}
        }
        return json({
          support_email: s.support_email || '',
          business_whatsapp: s.business_whatsapp || '',
          whatsapp_enabled: s.whatsapp_enabled === 'true',
          social_youtube: s.social_youtube || '',
          social_facebook: s.social_facebook || '',
          social_tiktok: s.social_tiktok || '',
          social_telegram: s.social_telegram || '',
          google_client_id: s.google_client_id || env.GOOGLE_CLIENT_ID || '',
          adsense_client_id: s.adsense_client_id || '',
          notice_banner: s.notice_banner || '',
          tools_count: toolsCount,
        });
      }

      // ==================== HOLIDAYS: AUTOMATIC, DATE-BOUNDED DECORATION ====================
      // The visitor's own date decides (the browser sends it), so Christmas starts
      // in Auckland before it starts in Colombo — and ends there first too.
      if (url.pathname === '/api/holidays/active' && request.method === 'GET') {
        const requested = String(url.searchParams.get('date') || '').trim();
        const today = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : new Date().toISOString().slice(0, 10);
        const previewId = String(url.searchParams.get('preview') || '').trim();
        if (previewId) {
          // A preview link is signed and time-limited: it shows one season to the
          // person holding the link and nobody else, and changes nothing globally.
          const until = Number(url.searchParams.get('hp') || 0);
          const sig = String(url.searchParams.get('hs') || '');
          if (until > Date.now() && sig && env.DB) {
            const settings = await getSettingsMap(env.DB);
            const secret = String(settings.admin_pass_sha256 || DEFAULT_ADMIN_SHA256);
            const expected = await holidayPreviewSignature(previewId + ':' + until, secret);
            if (expected === sig) {
              const all = windowsAround(today);
              const window = all.find((w) => w.id === previewId && today >= w.startDate && today <= w.endDate)
                || all.find((w) => w.id === previewId);
              if (window) return json(decorPayload(window, true), 200, { 'Cache-Control': 'no-store' });
            }
          }
        }
        return json(decorPayload(activeHoliday(today)), 200, { 'Cache-Control': 'no-store' });
      }

      // Signed-in visitors claim the season's free Pro week (Christmas week, New Year
      // week). One claim per season per account, and it never shortens a longer pass.
      if (url.pathname === '/api/holidays/claim-pro' && request.method === 'POST') {
        await ensureSchema(env.DB);
        const { user, authenticated } = await resolveUser(request, env);
        if (!authenticated || !user || !env.DB) return json({ error: 'Please sign in first, then claim your free week.' }, 401);
        // The server's date decides, so a crafted client date cannot open the gift
        // early; the visitor's date only settles the timezone edge (a visitor whose
        // Christmas has just started while UTC is still the 24th).
        const body: any = await request.json().catch(() => ({}));
        const clientDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? String(body.date) : '';
        const serverDate = new Date().toISOString().slice(0, 10);
        const window = proWindow(serverDate) || (clientDate ? proWindow(clientDate) : null);
        if (!window) return json({ error: 'There is no free Pro week running today.' }, 400);
        const claimKey = `pro_claim:${user.id}:${window.id}`;
        const already: any = await env.DB.prepare('SELECT v FROM site_settings WHERE k = ?').bind(claimKey).first();
        if (already) {
          const until = Number(already.v || 0);
          return json({ ok: true, alreadyClaimed: true, days: window.proDays, proUntil: until });
        }
        const currentUntil = Number((user as any).pro_until || 0);
        const base = Math.max(currentUntil, Date.now());
        const proUntil = base + window.proDays * 24 * 60 * 60 * 1000;
        await env.DB.prepare('UPDATE users SET pro_until = ?, plan = ? WHERE id = ?').bind(proUntil, 'pro_global', user.id).run();
        await setSetting(env.DB, claimKey, String(proUntil));
        return json({ ok: true, days: window.proDays, proUntil, label: window.proLabel || window.label });
      }

      // The admin may look at any season for a short while (a preview, not a change):
      // it paints the decorations for everyone with the preview link and nobody else.
      if (url.pathname === '/api/admin/holiday-preview' && request.method === 'POST') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const body: any = await request.json().catch(() => ({}));
        const id = String(body.id || '').trim();
        const days = Math.min(30, Math.max(1, Number(body.days) || 7));
        // No ids: hand back a signed link for every season at once (the operator
        // asked for the Christmas and New Year links ready to look at).
        const wanted: string[] = id ? [id] : HOLIDAYS.filter((h) => h.proDays > 0 || h.id === 'christmas').map((h) => h.id);
        for (const one of wanted) {
          if (!HOLIDAYS.some((h) => h.id === one)) return json({ error: 'Unknown holiday.' }, 404);
        }
        const settings = await getSettingsMap(env.DB);
        const secret = String(settings.admin_pass_sha256 || DEFAULT_ADMIN_SHA256);
        const until = Date.now() + days * 24 * 60 * 60 * 1000;
        const links: any[] = [];
        for (const one of wanted) {
          const sig = await holidayPreviewSignature(one + ':' + until, secret);
          links.push({
            id: one,
            url: `/?holiday_preview=${one}&hp=${until}&hs=${sig}`,
            until,
            expiresOn: new Date(until).toISOString().slice(0, 10),
          });
        }
        return json({ ok: true, preview: true, days, until, links, url: links[0]?.url });
      }

      // A reminder for the admin: is today a holiday? (shown in the panel)
      if (url.pathname === '/api/holidays/today' && request.method === 'GET') {
        const requested = String(url.searchParams.get('date') || '').trim();
        const today = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : new Date().toISOString().slice(0, 10);
        return json({ today, active: decorPayload(activeHoliday(today)), upcoming: upcoming(today, 6) }, 200, { 'Cache-Control': 'no-store' });
      }

      // ==================== EXECUTIVE ADMIN PANEL API (/api/admin/* & /api/tools) ====================
      if (url.pathname === '/api/admin/login' && request.method === 'POST') {
        await ensureSchema(env.DB);
        if (!env.DB) return json({ error: 'Database unavailable' }, 500);
        const body: any = await request.json().catch(() => ({}));
        const username = String(body.username || '').trim();
        const password = String(body.password || '').trim();
        if (!username || !password) return json({ error: 'Enter both username and password.' }, 400);

        const s = await getSettingsMap(env.DB);
        const expectedUser = (s.admin_username || 'admin').trim();
        const defaultPassHash = await sha256Hex('admin_pw:SingVaza@2026');
        const expectedHash = s.admin_pass_sha256 || defaultPassHash;
        const givenHash = await sha256Hex('admin_pw:' + password);
        const legacyHash = await sha256Hex('admin:' + password);

        const userMatch = username.toLowerCase() === expectedUser.toLowerCase();
        const passMatch = givenHash === expectedHash || (!s.admin_pass_sha256 && legacyHash === DEFAULT_ADMIN_SHA256);
        if (!userMatch || !passMatch) {
          return json({ error: 'Invalid admin username or password.' }, 401);
        }

        const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
        const expiresAt = Date.now() + THIRTY_DAYS_MS;
        await env.DB.prepare('INSERT INTO admin_sessions (token, username, expires_at) VALUES (?, ?, ?)').bind(token, expectedUser, expiresAt).run();
        return json({ ok: true, token, username: expectedUser });
      }

      if (url.pathname === '/api/admin/logout' && request.method === 'POST') {
        await ensureSchema(env.DB);
        const auth = String(request.headers.get('Authorization') || '');
        if (auth.startsWith('Bearer ') && env.DB) {
          await env.DB.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(auth.slice(7).trim()).run();
        }
        return json({ ok: true });
      }

      if (url.pathname === '/api/admin/overview' && request.method === 'GET') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        if (!env.DB) return json({ error: 'Database unavailable' }, 500);

        const today = new Date().toISOString().slice(0, 10);
        const realUserWhere = `id NOT IN ('demo-singer-global', 'demo-singer-lk')`;
        const [uCount, proCount, exportsSum, bCount, tCount, mCount, dailyRows, countryRows, pageRows, recentUsers]: any = await Promise.all([
          env.DB.prepare(`SELECT COUNT(*) AS c FROM users WHERE ${realUserWhere}`).first(),
          env.DB.prepare(`SELECT COUNT(*) AS c FROM users WHERE (${realUserWhere}) AND (pro_until > ? OR plan != ?)`).bind(Date.now(), 'free').first(),
          env.DB.prepare('SELECT COALESCE(SUM(exports_this_month), 0) AS s FROM users').first(),
          env.DB.prepare('SELECT COUNT(*) AS c FROM blog_posts').first(),
          env.DB.prepare('SELECT COUNT(*) AS c FROM html_tools').first(),
          env.DB.prepare('SELECT COUNT(*) AS c FROM contact_messages').first(),
          env.DB.prepare('SELECT day, views, uniques FROM analytics_daily ORDER BY day DESC LIMIT 30').all(),
          env.DB.prepare('SELECT country, views FROM analytics_countries ORDER BY views DESC LIMIT 12').all(),
          env.DB.prepare('SELECT path, views FROM analytics_pages ORDER BY views DESC LIMIT 12').all(),
          env.DB.prepare(`SELECT id, email, display_name, plan, pro_until, exports_this_month, auth_provider, created_at FROM users WHERE ${realUserWhere} ORDER BY created_at DESC LIMIT 8`).all(),
        ]);

        const dayMap = new Map<string, { views: number; uniques: number }>();
        let views30d = 0, uniques30d = 0;
        for (const r of (dailyRows.results || []) as any[]) {
          dayMap.set(String(r.day), { views: Number(r.views || 0), uniques: Number(r.uniques || 0) });
          views30d += Number(r.views || 0);
          uniques30d += Number(r.uniques || 0);
        }

        const chart14d: Array<{ day: string; views: number; uniques: number }> = [];
        for (let i = 13; i >= 0; i--) {
          const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
          const item = dayMap.get(d) || { views: 0, uniques: 0 };
          chart14d.push({ day: d, views: item.views, uniques: item.uniques });
        }
        const todayStats = dayMap.get(today) || { views: 0, uniques: 0 };

        return json({
          kpis: {
            todayViews: todayStats.views,
            todayUniques: todayStats.uniques,
            views30d,
            uniques30d,
            totalUsers: Number(uCount?.c || 0),
            proUsers: Number(proCount?.c || 0),
            totalExports: Number(exportsSum?.s || 0),
            blogPosts: Number(bCount?.c || 0),
            htmlTools: Number(tCount?.c || 0),
            messages: Number(mCount?.c || 0),
          },
          chart14d,
          countries: countryRows.results || [],
          topPages: pageRows.results || [],
          recentUsers: recentUsers.results || [],
        });
      }

      if (url.pathname === '/api/admin/users' && request.method === 'GET') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const rows = await env.DB.prepare(
          `SELECT id, email, display_name, plan, pro_until, daily_date, daily_exports, exports_this_month, auth_provider, created_at
           FROM users WHERE id NOT IN ('demo-singer-global', 'demo-singer-lk') ORDER BY created_at DESC LIMIT 300`
        ).all();
        return json({ users: rows.results || [] });
      }

      if (url.pathname === '/api/admin/users/pro' && request.method === 'POST') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const body: any = await request.json();
        const uid = String(body.user_id || '').trim();
        const grant = Boolean(body.grant);
        const proUntil = grant ? Date.now() + THIRTY_DAYS_MS : 0;
        const plan = grant ? 'pro_global' : 'free';
        await env.DB.prepare('UPDATE users SET plan = ?, pro_until = ? WHERE id = ?').bind(plan, proUntil, uid).run();
        return json({ ok: true });
      }

      if (url.pathname.startsWith('/api/admin/users/') && request.method === 'DELETE') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const uid = url.pathname.split('/').pop();
        if (uid) {
          await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(uid).run();
          await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid).run().catch(() => {});
        }
        return json({ ok: true });
      }

      if (url.pathname === '/api/admin/messages' && request.method === 'GET') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const rows = await env.DB.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 200').all();
        return json({ messages: rows.results || [] });
      }

      if (url.pathname.startsWith('/api/admin/messages/') && request.method === 'DELETE') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const mid = url.pathname.split('/').pop();
        if (mid) await env.DB.prepare('DELETE FROM contact_messages WHERE id = ?').bind(mid).run();
        return json({ ok: true });
      }

      if (url.pathname === '/api/admin/settings' && request.method === 'GET') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const s = await getSettingsMap(env.DB);
        return json({
          settings: {
            admin_username: s.admin_username || 'admin',
            support_email: s.support_email || '',
            business_whatsapp: s.business_whatsapp || '',
            whatsapp_enabled: s.whatsapp_enabled === 'true',
            social_youtube: s.social_youtube || '',
            social_facebook: s.social_facebook || '',
            social_tiktok: s.social_tiktok || '',
            social_telegram: s.social_telegram || '',
            google_client_id: s.google_client_id || env.GOOGLE_CLIENT_ID || '',
            adsense_client_id: s.adsense_client_id || '',
            custom_ad_code: s.custom_ad_code || '',
            ads_enabled: s.ads_enabled === 'true',
            seo_home_title: s.seo_home_title || 'SingVaza — Free Online Karaoke Player, Vocal Recorder & Audio Mastering Studio',
            seo_home_description: s.seo_home_description || 'SingVaza is a free online karaoke maker and recorder. Reduce vocals in stereo songs, sing with lyrics, and mix and export your recording in your browser.',
            seo_home_tags: s.seo_home_tags || 'SingVaza, Sing Vaza, SingViza, online karaoke player, free vocal recorder, karaoke with lyrics, vocal remover online, pitch changer, audio mastering studio, Sinhala karaoke, MP3 vocal mixer',
            notice_banner: s.notice_banner || '',
            daily_free_limit: Number(s.daily_free_limit || DAILY_FREE_LIMIT),
          },
        });
      }

      if (url.pathname === '/api/admin/settings' && request.method === 'POST') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const body: any = await request.json();
        const allowedKeys = [
          'admin_username', 'support_email', 'business_whatsapp', 'whatsapp_enabled',
          'social_youtube', 'social_facebook', 'social_tiktok', 'social_telegram',
          'google_client_id', 'adsense_client_id', 'custom_ad_code', 'ads_enabled',
          'seo_home_title', 'seo_home_description', 'seo_home_tags',
          'notice_banner', 'daily_free_limit',
        ];
        for (const k of allowedKeys) {
          if (body[k] !== undefined) {
            const maxLen = k === 'custom_ad_code' ? 6000 : (k === 'seo_home_tags' ? 1500 : 500);
            const val = String(body[k]).trim().slice(0, maxLen);
            if (k === 'admin_username' && val.length < 2) continue;
            await env.DB.prepare(
              `INSERT INTO site_settings (k, v, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = CURRENT_TIMESTAMP`
            ).bind(k, val).run();
          }
        }
        if (body.new_password && String(body.new_password).trim().length >= 5) {
          const pwHash = await sha256Hex('admin_pw:' + String(body.new_password).trim());
          await env.DB.prepare(
            `INSERT INTO site_settings (k, v, updated_at) VALUES ('admin_pass_sha256', ?, CURRENT_TIMESTAMP)
             ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = CURRENT_TIMESTAMP`
          ).bind(pwHash).run();
          const curBearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
          await env.DB.prepare('DELETE FROM admin_sessions WHERE token != ?').bind(curBearer).run();
        }
        return json({ ok: true });
      }

      if (url.pathname === '/api/admin/diagnostics' && request.method === 'GET') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const result: any = { db: Boolean(env.DB), schemaProblems: lastSchemaProblems, tables: {}, columns: {}, counts: {} };
        if (env.DB) {
          for (const table of ['html_tools', 'blog_posts', 'site_settings', 'users']) {
            try {
              const info: any = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
              const cols = ((info.results || []) as any[]).map((c) => String(c.name));
              result.tables[table] = cols.length > 0;
              result.columns[table] = cols;
            } catch (err) {
              result.tables[table] = false;
              result.columns[table] = [];
              result.columnError = String((err as any)?.message || err);
            }
          }
          try {
            const [tools, toolsPublished, posts, postsPublished] = await Promise.all([
              env.DB.prepare('SELECT COUNT(*) AS c FROM html_tools').first(),
              env.DB.prepare("SELECT COUNT(*) AS c FROM html_tools WHERE COALESCE(visibility, 'published') = 'published'").first(),
              env.DB.prepare('SELECT COUNT(*) AS c FROM blog_posts').first(),
              env.DB.prepare("SELECT COUNT(*) AS c FROM blog_posts WHERE COALESCE(visibility, 'published') = 'published'").first(),
            ]);
            result.counts = {
              tools: Number((tools as any)?.c || 0),
              toolsPublished: Number((toolsPublished as any)?.c || 0),
              posts: Number((posts as any)?.c || 0),
              postsPublished: Number((postsPublished as any)?.c || 0),
            };
          } catch (err) {
            result.countError = String((err as any)?.message || err);
          }
        }
        const problems: string[] = [...(result.schemaProblems || [])];
        for (const table of ['html_tools', 'blog_posts']) {
          if (result.db && !(result.columns[table] || []).length) problems.push(`table ${table} is missing`);
        }
        result.ok = problems.length === 0;
        result.problems = problems;
        return json(result, 200, { 'Cache-Control': 'no-store' });
      }

      // ==================== THE WHOLE STATIC SITE, IN ONE FILE ====================
      // One click: list every static file, fetch each one, pack one .zip in the
      // browser. The updated copy comes back as a .zip, is compared file by file,
      // and only what changed is published — with a one-click undo.
      if (url.pathname === '/api/admin/site-archive' && request.method === 'GET') {
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        if (!env.ASSETS) return json({ error: 'The static files are not available here.' }, 500);
        const wanted = url.searchParams.get('path');
        if (wanted) {
          const clean = wanted.replace(/^\/+/, '');
          if (!isDownloadableSiteFile(clean)) return json({ error: 'That file is not part of the download.' }, 403);
          const res = await env.ASSETS.fetch(new Request(new URL('/' + clean, url).toString()));
          if (!res.ok) return json({ error: 'File not found.' }, 404);
          return new Response(res.body, {
            headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream', 'Cache-Control': 'no-store' },
          });
        }
        const list = await readManifest(env);
        return json({ files: list.filter(isDownloadableSiteFile), count: list.filter(isDownloadableSiteFile).length }, 200, { 'Cache-Control': 'no-store' });
      }

      if (url.pathname === '/api/admin/site-archive' && request.method === 'POST') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        if (!env.DB) return json({ error: 'Database unavailable' }, 500);
        const search = url.searchParams;
        const action = search.get('action') || 'stage';

        if (action === 'undo') {
          const changed: any[] = JSON.parse((await getSettingsMap(env.DB)).live_last_change || '[]');
          let restored = 0;
          let removed = 0;
          for (const item of changed) {
            const path = String(item.path || '');
            if (!path) continue;
            const pagePath = pagePathForFile(path);
            const prev = (await getSettingsMap(env.DB))[undoKey(path)];
            if (prev === '' || (prev === undefined && !pagePath)) {
              await env.DB.prepare('DELETE FROM site_settings WHERE k = ?').bind(pagePath ? 'page_override:' + pagePath : liveKey(path)).run();
              removed += 1;
            } else if (prev !== undefined) {
              await setSetting(env.DB, pagePath ? 'page_override:' + pagePath : liveKey(path), prev);
              restored += 1;
            }
            await env.DB.prepare('DELETE FROM site_settings WHERE k = ?').bind(undoKey(path)).run();
          }
          const beforeUndo: string[] = JSON.parse((await getSettingsMap(env.DB)).live_overrides_list || '[]');
          const stillLive: string[] = [];
          for (const path of beforeUndo) {
            const row: any = await env.DB.prepare('SELECT k FROM site_settings WHERE k = ?').bind(liveKey(path)).first();
            if (row) stillLive.push(path);
          }
          await setSetting(env.DB, 'live_overrides_list', JSON.stringify(stillLive));
          await bustOverridesCache(url);
          await setSetting(env.DB, 'live_last_change', '[]');
          return json({ ok: true, restored, removed });
        }

        const body: any = await request.json().catch(() => ({}));
        const files: { path: string; content: string }[] = Array.isArray(body.files) ? body.files : [];

        if (action === 'stage') {
          if (!files.length) return json({ error: 'The zip did not contain any readable text file.' }, 400);
          if (files.length > MAX_FILES_PER_UPLOAD) return json({ error: `Too many files at once (${files.length}). Send up to ${MAX_FILES_PER_UPLOAD}.` }, 400);
          const current = await getSettingsMap(env.DB);
          const currentText: Record<string, string> = {};
          const staging: { path: string; content: string }[] = [];
          const rejected: { path: string; reason: string }[] = [];
          for (const file of files) {
            const path = normalizeSitePath(String(file.path || ''));
            const content = String(file.content ?? '');
            if (!path) { rejected.push({ path: String(file.path || ''), reason: 'No file name.' }); continue; }
            if (!isPublishableTextFile(path)) { rejected.push({ path, reason: 'Only text files can be published from a zip (images and audio stay as they are).' }); continue; }
            if (new TextEncoder().encode(content).length > MAX_TEXT_FILE_BYTES) { rejected.push({ path, reason: 'This file is too big (over 512 KB).' }); continue; }
            if (path.toLowerCase() === 'admin.html') { rejected.push({ path, reason: 'The admin panel is never replaced from a zip.' }); continue; }
            const pagePath = pagePathForFile(path);
            if (pagePath) {
              const report = await analyzeWithAssets(content, 'page', env, url.origin);
              const blocking = report.issues.filter((i) => i.level === 'error');
              if (blocking.length) { rejected.push({ path, reason: blocking[0].message }); continue; }
            }
            if (current[liveKey(path)] !== undefined) currentText[path] = current[liveKey(path)];
            staging.push({ path, content });
          }
          // Compare with what is live right now (stored copy first, then the file).
          for (const file of staging) {
            if (currentText[file.path] !== undefined) continue;
            const pagePath = pagePathForFile(file.path);
            const stored = current[pagePath ? 'page_override:' + pagePath : liveKey(file.path)];
            if (stored !== undefined) {
              currentText[file.path] = stored;
            } else {
              const asset = await env.ASSETS?.fetch(new Request(new URL('/' + file.path, url).toString()));
              currentText[file.path] = asset && asset.ok ? await asset.text() : '';
            }
            await setSetting(env.DB, stageKey(file.path), currentText[file.path]);
          }
          // Keep the comparison base for the publish step.
          await setSetting(env.DB, 'zip_stage_items', JSON.stringify(staging.map((f) => f.path)));
          const summary = summarizeChanges(staging, currentText);
          const changed = summary.filter((f) => f.status !== 'same');
          if (changed.length) await setSetting(env.DB, 'zip_stage_contents', JSON.stringify(staging));
          return json({
            ok: true,
            summary,
            changed: changed.length,
            same: summary.length - changed.length,
            rejected,
            note: 'Nothing has been published yet. Review the list, then press Publish.',
          });
        }

        if (action === 'publish') {
          const staged: { path: string; content: string }[] = JSON.parse((await getSettingsMap(env.DB)).zip_stage_contents || '[]');
          if (!staged.length) return json({ error: 'There is nothing staged to publish.' }, 400);
          const previous = await getSettingsMap(env.DB);
          const changedList: any[] = [];
          for (const file of staged) {
            const before = previous[stageKey(file.path)];
            if (before === file.content) continue;
            const pagePath = pagePathForFile(file.path);
            if (pagePath) {
              // '' means "there was nothing here before", so undo deletes it again.
              const hadPage = previous['page_override:' + pagePath];
              await setSetting(env.DB, undoKey(file.path), hadPage ?? '');
              await setSetting(env.DB, 'page_override:' + pagePath, file.content);
            } else {
              await setSetting(env.DB, undoKey(file.path), before ?? '');
              await setSetting(env.DB, liveKey(file.path), file.content);
            }
            changedList.push({ path: file.path, bytes: new TextEncoder().encode(file.content).length });
            await env.DB.prepare('DELETE FROM site_settings WHERE k = ?').bind(stageKey(file.path)).run();
          }
          await setSetting(env.DB, 'live_last_change', JSON.stringify(changedList));
          {
            const prevList: string[] = JSON.parse(previous.live_overrides_list || '[]');
            const next = Array.from(new Set([...prevList, ...changedList.map((f: any) => f.path)]));
            await setSetting(env.DB, 'live_overrides_list', JSON.stringify(next));
            await bustOverridesCache(url);
          }
          await env.DB.prepare('DELETE FROM site_settings WHERE k = ?').bind('zip_stage_contents').run();
          await env.DB.prepare('DELETE FROM site_settings WHERE k = ?').bind('zip_stage_items').run();
          return json({ ok: true, published: changedList.length, files: changedList, undoHint: 'Undo is available until the next upload.' });
        }

        return json({ error: 'Unknown action.' }, 400);
      }

      // ==================== STATIC HTML TEMPLATES (download / upload) ====================
      if (url.pathname === '/api/admin/templates' && request.method === 'GET') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const wanted = url.searchParams.get('id');
        if (wanted) {
          const tpl = templateById(wanted);
          if (!tpl) return json({ error: 'Unknown template.' }, 404);
          if (tpl.fragment) return json({ error: 'That one is a snippet to paste in, not a page file.' }, 400);
          return new Response(tpl.html, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Disposition': `attachment; filename="singvaza-template-${tpl.id}.html"`,
              'Cache-Control': 'no-store',
            },
          });
        }
        return json({ templates: templateList() });
      }

      if (url.pathname === '/api/admin/templates' && request.method === 'POST') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        if (!env.DB) return json({ error: 'Database unavailable' }, 500);
        const body: any = await request.json().catch(() => ({}));
        const name = String(body.name || '').trim().slice(0, 80) || 'My template';
        const kind = ['page', 'tool', 'blog'].includes(String(body.kind)) ? String(body.kind) : 'page';
        const html = String(body.html || '');
        if (!html.trim()) return json({ error: 'Nothing to save.' }, 400);
        const report = await analyzeWithAssets(html, kind as 'page' | 'tool' | 'blog', env, url.origin);
        const blocking = report.issues.filter((i) => i.level === 'error');
        if (blocking.length) return json({ error: blocking[0].message, report }, 422);
        const id = String(body.id || '').trim() || ('tpl-' + Date.now().toString(36));
        await setSetting(env.DB, 'template_upload:' + id, JSON.stringify({ id, name, kind, html, savedAt: new Date().toISOString() }));
        return json({ ok: true, id, name, kind, report });
      }

      if (url.pathname === '/api/admin/templates/export' && request.method === 'GET') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const id = url.searchParams.get('id') || '';
        if (!env.DB || !id) return json({ error: 'Missing id.' }, 400);
        const raw = (await getSettingsMap(env.DB))['template_upload:' + id];
        if (!raw) return json({ error: 'Template not found.' }, 404);
        const parsed = JSON.parse(raw);
        return new Response(String(parsed.html || ''), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Disposition': `attachment; filename="singvaza-template-${String(parsed.name || id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'custom'}.html"`,
            'Cache-Control': 'no-store',
          },
        });
      }

      if (url.pathname === '/api/admin/templates/uploads' && request.method === 'GET') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const sMap = env.DB ? await getSettingsMap(env.DB) : {};
        const uploads = Object.entries(sMap)
          .filter(([k]) => k.startsWith('template_upload:'))
          .map(([, v]) => { try { const t = JSON.parse(v); return { id: t.id, name: t.name, kind: t.kind, savedAt: t.savedAt, bytes: new TextEncoder().encode(String(t.html || '')).length }; } catch (_) { return null; } })
          .filter(Boolean);
        return json({ uploads });
      }

      if (url.pathname.startsWith('/api/admin/templates/uploads/') && request.method === 'DELETE') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const id = url.pathname.split('/').pop();
        if (env.DB && id) await env.DB.prepare('DELETE FROM site_settings WHERE k = ?').bind('template_upload:' + id).run();
        return json({ ok: true });
      }

      // ==================== OCCASIONS (safe seasonal changes) ====================
      // A seasonal change is a date-limited greeting bar injected into the pages on
      // the way out. Nothing is overwritten, so when the dates pass the site is
      // exactly what it was, and one switch turns the whole thing off.
      if (url.pathname === '/api/admin/occasions' && request.method === 'GET') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const raw = (await getSettingsMap(env.DB))['occasion_config'] || '';
        let config: any = {};
        try { config = raw ? JSON.parse(raw) : {}; } catch (_) { config = {}; }
        return json({
          occasions: {
            enabled: config.enabled === true,
            title: config.title || '',
            message: config.message || '',
            emoji: config.emoji || '🎉',
            startDate: config.startDate || '',
            endDate: config.endDate || '',
            pages: Array.isArray(config.pages) && config.pages.length ? config.pages : ['/'],
            dismissible: config.dismissible !== false,
            theme: config.theme || 'celebration',
          },
          presets: occasionPresets(),
        });
      }

      if (url.pathname === '/api/admin/occasions' && request.method === 'POST') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        if (!env.DB) return json({ error: 'Database unavailable' }, 500);
        const body: any = await request.json().catch(() => ({}));
        const dateOk = (v: any) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(String(v));
        if (!dateOk(body.startDate) || !dateOk(body.endDate)) return json({ error: 'Dates must look like 2026-12-20.' }, 400);
        if (body.startDate && body.endDate && String(body.endDate) < String(body.startDate)) {
          return json({ error: 'The end date is before the start date.' }, 400);
        }
        const pages = (Array.isArray(body.pages) ? body.pages : ['/'])
          .map((p: any) => String(p))
          .filter((p: string) => EDITABLE_PAGES.some((e) => e.path === p));
        const config = {
          enabled: body.enabled === true,
          title: String(body.title || '').trim().slice(0, 80),
          message: String(body.message || '').trim().slice(0, 200),
          emoji: String(body.emoji || '').trim().slice(0, 8),
          startDate: String(body.startDate || ''),
          endDate: String(body.endDate || ''),
          pages: pages.length ? pages : ['/'],
          dismissible: body.dismissible !== false,
          theme: ['celebration', 'newyear', 'calm'].includes(String(body.theme)) ? String(body.theme) : 'celebration',
        };
        if (config.enabled && !config.message) return json({ error: 'Write a short message before switching it on.' }, 400);
        await setSetting(env.DB, 'occasion_config', JSON.stringify(config));
        // A preview link the admin can open in a tab (no headers needed): valid for
        // two hours and only for this greeting, never for anything else.
        const previewUntil = Date.now() + 2 * 60 * 60 * 1000;
        const settings = await getSettingsMap(env.DB);
        const secret = String(settings.admin_pass_sha256 || DEFAULT_ADMIN_SHA256);
        const sig = await occasionPreviewSignature('until:' + previewUntil, secret);
        const previewPath = (Array.isArray(config.pages) && config.pages[0]) || '/';
        const previewUrl = `${previewPath}?occasion_preview=${previewUntil}&sig=${sig}`;
        return json({ ok: true, occasions: config, activeNow: isOccasionActive(config), previewUrl });
      }

      // ==================== CONTENT HEALTH: CHECK / SAVE / PRIVACY / EXPORT ====================
      // Every published tool, article and main-site page can be checked here before
      // it goes live. Nothing is trusted from the client: the admin token is required
      // and the verdict is recomputed on the server.
      if (url.pathname === '/api/admin/content/check' && request.method === 'POST') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const body: any = await request.json().catch(() => ({}));
        const kind = (['tool', 'blog', 'page'].includes(String(body.kind)) ? String(body.kind) : 'tool') as 'tool' | 'blog' | 'page';
        const html = String(body.html || '');
        if (!html.trim()) return json({ error: 'Nothing to check.' }, 400);
        const report = await analyzeWithAssets(html, kind, env, url.origin);
        return json({ report: { ...report, issues: mergeIssues(report.issues, []) } });
      }

      if (url.pathname === '/api/admin/content/visibility' && request.method === 'POST') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        if (!env.DB) return json({ error: 'Database unavailable' }, 500);
        const body: any = await request.json().catch(() => ({}));
        const table = body.type === 'blog' ? 'blog_posts' : (body.type === 'page' ? 'site_pages' : 'html_tools');
        const visibility = body.visibility === 'hidden' ? 'hidden' : 'published';
        const id = String(body.id || '').trim();
        if (!id) return json({ error: 'Missing id.' }, 400);
        if (table === 'site_pages') {
          await setSetting(env.DB, 'page_visibility:' + id, visibility);
          return json({ ok: true, visibility });
        }
        await env.DB.prepare(`UPDATE ${table} SET visibility = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(visibility, id).run();
        return json({ ok: true, visibility });
      }

      if (url.pathname === '/api/admin/content/raw' && request.method === 'GET') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const type = url.searchParams.get('type') || 'tool';
        const id = url.searchParams.get('id') || '';
        if (!env.DB || !id) return json({ error: 'Missing id.' }, 400);
        let html = '';
        let meta: any = null;
        if (type === 'page') {
          const sMap = await getSettingsMap(env.DB);
          html = sMap['page_override:' + id] || '';
          if (!html) html = await fetchAssetText(env, url.origin + id);
          meta = { path: id, visibility: sMap['page_visibility:' + id] || 'published' };
        } else {
          const table = type === 'blog' ? 'blog_posts' : 'html_tools';
          const column = type === 'blog' ? 'content' : 'html_code';
          const row: any = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
          if (!row) return json({ error: 'Not found.' }, 404);
          html = String(row[column] || '');
          meta = { slug: row.slug, title: row.title, visibility: row.visibility || 'published' };
        }
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'attachment; filename="singvaza-' + String(meta?.slug || 'content').replace(/[^a-z0-9-]/gi, '-') + '.html"', 'Cache-Control': 'no-store' },
        });
      }

      if (url.pathname === '/api/admin/content/export' && request.method === 'GET') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const path = url.searchParams.get('path') || '/';
        if (!EDITABLE_PAGES.some((p) => p.path === path)) return json({ error: 'Not an editable page.' }, 400);
        const sMap = env.DB ? await getSettingsMap(env.DB) : {};
        const override = sMap['page_override:' + path];
        const html = override || await fetchAssetText(env, url.origin + (path === '/' ? '/index.html' : path + '.html'));
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `attachment; filename="singvaza-page-${path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'}.html"`, 'Cache-Control': 'no-store' },
        });
      }

      if (url.pathname === '/api/admin/pages' && request.method === 'GET') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const sMap = env.DB ? await getSettingsMap(env.DB) : {};
        const pages = EDITABLE_PAGES.map((p) => {
          const custom = sMap['page_override:' + p.path] || '';
          return {
            path: p.path,
            label: p.label,
            custom: Boolean(custom),
            bytes: custom ? new TextEncoder().encode(custom).length : 0,
            updated_at: sMap['page_override_at:' + p.path] || '',
            visibility: sMap['page_visibility:' + p.path] || 'published',
          };
        });
        return json({ pages });
      }

      if (url.pathname === '/api/admin/pages' && request.method === 'POST') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        if (!env.DB) return json({ error: 'Database unavailable' }, 500);
        const body: any = await request.json().catch(() => ({}));
        const path = String(body.path || '');
        if (!EDITABLE_PAGES.some((p) => p.path === path)) return json({ error: 'Not an editable page.' }, 400);

        if (body.reset) {
          await env.DB.prepare('DELETE FROM site_settings WHERE k IN (?, ?, ?)')
            .bind('page_override:' + path, 'page_override_at:' + path, 'page_visibility:' + path).run();
          return json({ ok: true, reset: true });
        }

        const html = String(body.html || '');
        if (!html.trim()) return json({ error: 'Nothing to save.' }, 400);
        const live = (await getSettingsMap(env.DB))['page_override:' + path] || await fetchAssetText(env, url.origin + (path === '/' ? '/index.html' : path + '.html'));
        const report = await analyzeWithAssets(html, 'page', env, url.origin);
        const diffIssues = compareVersions(live, html);
        const issues = mergeIssues(report.issues, diffIssues);
        const blocking = issues.filter((i) => i.level === 'error');
        if (blocking.length && body.force !== true) {
          return json({ error: 'The new page would break: ' + blocking[0].message, report: { ...report, issues } }, 422);
        }
        const at = new Date().toISOString();
        await setSetting(env.DB, 'page_override:' + path, html);
        await setSetting(env.DB, 'page_override_at:' + path, at);
        return json({ ok: true, path, savedAt: at, report: { ...report, issues } });
      }

      if (url.pathname === '/api/admin/ai-review' && request.method === 'POST') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const body: any = await request.json().catch(() => ({}));
        const kind = (['tool', 'blog', 'page'].includes(String(body.kind)) ? String(body.kind) : 'tool') as 'tool' | 'blog' | 'page';
        const html = String(body.html || '');
        if (!html.trim()) return json({ error: 'Nothing to review.' }, 400);
        const report = await analyzeWithAssets(html, kind, env, url.origin);
        const review = heuristicReview(report, html);
        return json({ review, report });
      }

      // HTML Web Tools CRUD API (/api/tools)
      if (url.pathname === '/api/tools' && request.method === 'GET') {
        await ensureSchema(env.DB);
        if (!env.DB) return json({ tools: [] });
        // The published list is public; only an admin token may read drafts (and
        // the raw html_code, which is fetched per item by the admin panel).
        if (url.searchParams.get('admin') === '1') {
          if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
          const query = url.searchParams.get('summary') === '1'
            ? 'SELECT id, slug, title, category, icon, description, seo_tags, visibility, created_at, updated_at FROM html_tools ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 200'
            : 'SELECT * FROM html_tools ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 200';
          const rows = await env.DB.prepare(query).all();
          return json({ tools: rows.results || [] });
        }
        const query = url.searchParams.get('summary') === '1'
          ? "SELECT id, slug, title, category, icon, description, seo_tags, created_at FROM html_tools WHERE COALESCE(visibility, 'published') = 'published' ORDER BY created_at DESC LIMIT 200"
          : "SELECT id, slug, title, category, icon, description, seo_tags, created_at FROM html_tools WHERE COALESCE(visibility, 'published') = 'published' ORDER BY created_at DESC LIMIT 200";
        const rows = await env.DB.prepare(query).all();
        return json({ tools: rows.results || [] });
      }

      if (url.pathname === '/api/tools' && request.method === 'POST') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        if (!env.DB) return json({ error: 'Database unavailable' }, 500);
        const body: any = await request.json();
        const title = String(body.title || '').trim();
        const htmlCode = String(body.html_code || '').trim();
        if (title.length < 2 || htmlCode.length < 15) {
          return json({ error: 'Please provide a tool title and valid HTML code.' }, 400);
        }
        const rawSlug = String(body.slug || title)
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-')
          .slice(0, 80) || ('tool-' + Date.now());
        const id = String(body.id || '').trim() || crypto.randomUUID();
        const category = String(body.category || 'Web Tool').trim().slice(0, 50);
        const icon = String(body.icon || '⚡').trim().slice(0, 8);
        const description = String(body.description || '').trim().slice(0, 260);
        const seoTags = String(body.seo_tags || '').trim().slice(0, 800);
        const visibility = body.visibility === 'hidden' ? 'hidden' : 'published';

        // ---- safety gate: the new file must be healthy, and an update must not
        // quietly throw away the content that is already live.
        const report = await analyzeWithAssets(htmlCode, 'tool', env, url.origin);
        const existing: any = await env.DB.prepare('SELECT html_code, visibility FROM html_tools WHERE id = ?').bind(id).first();
        const issues = mergeIssues(report.issues, existing ? compareVersions(String(existing.html_code || ''), htmlCode) : []);
        const blocking = issues.filter((i) => i.level === 'error');
        if (blocking.length && body.force !== true) {
          return json({ error: blocking[0].message, report: { ...report, issues } }, 422);
        }

        await env.DB.prepare(
          `INSERT INTO html_tools (id, slug, title, category, icon, description, seo_tags, html_code, visibility, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(id) DO UPDATE SET
             slug = excluded.slug,
             title = excluded.title,
             category = excluded.category,
             icon = excluded.icon,
             description = excluded.description,
             seo_tags = excluded.seo_tags,
             html_code = excluded.html_code,
             visibility = excluded.visibility,
             updated_by = excluded.updated_by,
             updated_at = CURRENT_TIMESTAMP`
        ).bind(id, rawSlug, title, category, icon, description, seoTags, htmlCode, visibility, String(body.updated_by || 'admin').slice(0, 60)).run();

        fetch('https://api.indexnow.org/indexnow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            host: url.host,
            key: '8dc68fc0e32ac33e8dc68fc0e32ac33e',
            keyLocation: `${url.origin}/8dc68fc0e32ac33e8dc68fc0e32ac33e.txt`,
            urlList: [`${url.origin}/tools/${rawSlug}`, `${url.origin}/tools`, `${url.origin}/sitemap.xml`],
          }),
        }).catch(() => {});

        return json({ ok: true, id, slug: rawSlug, url: `/tools/${rawSlug}`, visibility, report: { ...report, issues } });
      }

      if (url.pathname.startsWith('/api/tools/') && request.method === 'DELETE') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        const tid = url.pathname.split('/').pop();
        if (env.DB && tid) await env.DB.prepare('DELETE FROM html_tools WHERE id = ?').bind(tid).run();
        return json({ ok: true });
      }

      // Blog JSON API & Admin CMS Endpoints
      if (url.pathname === '/api/blog' && request.method === 'GET') {
        await ensureSchema(env.DB);
        if (!env.DB) return json({ posts: [] });
        if (url.searchParams.get('admin') === '1') {
          if (!(await isValidBlogAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
          const query = url.searchParams.get('summary') === '1'
            ? 'SELECT id, slug, title, category, cover_image, excerpt, seo_tags, author_name, content_format, visibility, created_at, updated_at FROM blog_posts ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 100'
            : 'SELECT * FROM blog_posts ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 100';
          const rows = await env.DB.prepare(query).all();
          return json({ posts: rows.results || [] });
        }
        const query = url.searchParams.get('summary') === '1'
          ? "SELECT id, slug, title, category, cover_image, excerpt, seo_tags, author_name, content_format, created_at FROM blog_posts WHERE COALESCE(visibility, 'published') = 'published' ORDER BY created_at DESC LIMIT 100"
          : "SELECT id, slug, title, category, cover_image, excerpt, seo_tags, author_name, content_format, created_at FROM blog_posts WHERE COALESCE(visibility, 'published') = 'published' ORDER BY created_at DESC LIMIT 100";
        const rows = await env.DB.prepare(query).all();
        return json({ posts: rows.results || [] });
      }

      if (url.pathname === '/api/blog/verify' && request.method === 'POST') {
        const ok = await isValidBlogAdmin(request, env);
        return ok ? json({ ok: true }) : json({ error: 'Invalid admin passcode.' }, 401);
      }

      if (url.pathname === '/api/blog' && request.method === 'POST') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) {
          return json({ error: 'Invalid admin passcode.' }, 401);
        }
        if (!env.DB) return json({ error: 'Database unavailable' }, 500);
        const body: any = await request.json();
        const title = String(body.title || '').trim();
        const content = String(body.content || '').trim();
        if (title.length < 2 || content.length < 15) {
          return json({ error: 'Please enter a post title and full article content.' }, 400);
        }
        const rawSlug = String(body.slug || title)
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-')
          .slice(0, 80) || ('post-' + Date.now());
        const id = String(body.id || '').trim() || crypto.randomUUID();
        const category = String(body.category || 'Article').trim().slice(0, 50);
        const coverImage = String(body.cover_image || '/assets/studio-girl-card.jpg').trim().slice(0, 500);
        const plainStrip = content.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const excerpt = String(body.excerpt || (plainStrip.slice(0, 150) + (plainStrip.length > 150 ? '...' : ''))).trim().slice(0, 260);
        const authorName = String(body.author_name || 'Editor').trim().slice(0, 80);
        const contentFormat = String(body.content_format || 'html').trim().slice(0, 20);
        const seoTags = String(body.seo_tags || '').trim().slice(0, 800);
        const visibility = body.visibility === 'hidden' ? 'hidden' : 'published';

        // Same safety gate as the tools: healthy file, and an update may not wipe
        // the article that is already published.
        const report = await analyzeWithAssets(content, 'blog', env, url.origin);
        const existing: any = await env.DB.prepare('SELECT content, visibility FROM blog_posts WHERE id = ?').bind(id).first();
        const issues = mergeIssues(report.issues, existing ? compareVersions(String(existing.content || ''), content) : []);
        const blocking = issues.filter((i) => i.level === 'error');
        if (blocking.length && body.force !== true) {
          return json({ error: blocking[0].message, report: { ...report, issues } }, 422);
        }

        await env.DB.prepare(
          `INSERT INTO blog_posts (id, slug, title, category, cover_image, excerpt, seo_tags, content, content_format, author_name, visibility, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(id) DO UPDATE SET
             slug = excluded.slug,
             title = excluded.title,
             category = excluded.category,
             cover_image = excluded.cover_image,
             excerpt = excluded.excerpt,
             seo_tags = excluded.seo_tags,
             content = excluded.content,
             content_format = excluded.content_format,
             author_name = excluded.author_name,
             visibility = excluded.visibility,
             updated_by = excluded.updated_by,
             updated_at = CURRENT_TIMESTAMP`
        ).bind(id, rawSlug, title, category, coverImage, excerpt, seoTags, content, contentFormat, authorName, visibility, String(body.updated_by || 'admin').slice(0, 60)).run();

        fetch('https://api.indexnow.org/indexnow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            host: url.host,
            key: '8dc68fc0e32ac33e8dc68fc0e32ac33e',
            keyLocation: `${url.origin}/8dc68fc0e32ac33e8dc68fc0e32ac33e.txt`,
            urlList: [`${url.origin}/blog/${rawSlug}`, `${url.origin}/blog`, `${url.origin}/sitemap.xml`],
          }),
        }).catch(() => {});

        return json({ ok: true, id, slug: rawSlug, url: `/blog/${rawSlug}`, visibility, report: { ...report, issues } });
      }

      if (url.pathname.startsWith('/api/blog/') && request.method === 'DELETE') {
        await ensureSchema(env.DB);
        if (!(await isValidBlogAdmin(request, env))) {
          return json({ error: 'Invalid admin passcode.' }, 401);
        }
        const postId = url.pathname.split('/').pop();
        if (env.DB && postId) {
          await env.DB.prepare('DELETE FROM blog_posts WHERE id = ?').bind(postId).run();
        }
        return json({ ok: true, deleted: true });
      }

      const tzInfo = getUserLocalDayInfo(request);

      // 1. Instant Song Name -> Karaoke Video Search (7-Day Cloudflare Edge Cache)
      if (url.pathname === '/api/search-karaoke' && request.method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json({ videos: [] });

        const cacheKey = new Request(`https://singvaza-edge-cache.local/karaoke-v4?q=${encodeURIComponent(q.toLowerCase())}`);
        const edgeCache = (globalThis as any).caches?.default;
        if (edgeCache) {
          const hit = await edgeCache.match(cacheKey);
          if (hit) return hit;
        }

        const videos = await searchKaraokeVideos(q);
        const resp = new Response(JSON.stringify({ videos }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=604800, s-maxage=604800',
            ...CORS_HEADERS,
          },
        });
        if (edgeCache && videos.length > 0) {
          try { await edgeCache.put(cacheKey, resp.clone()); } catch (_) {}
        }
        return resp;
      }

      // 2. Instant Pure Lyrics Engine v17.0 (15,601 Sri Lankan Songs RAM Index + Global LRCLIB/Ovh + Pure-Sinhala YT Fallback — Zero Singer Names, Sub-Second!)
      if (url.pathname === '/api/lyrics' && request.method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json({ track: null });

        const sinhalaToSinglish = (input: string) => {
          const indep: Record<string, string> = {
            'අ': 'a', 'ආ': 'a', 'ඇ': 'a', 'ඈ': 'a', 'ඉ': 'i', 'ඊ': 'i', 'උ': 'u', 'ඌ': 'u',
            'ඍ': 'ru', 'එ': 'i', 'ඒ': 'i', 'ඓ': 'ai', 'ඔ': 'u', 'ඕ': 'u', 'ඖ': 'au',
          };
          const cons: Record<string, string> = {
            'ක': 'k', 'ඛ': 'k', 'ග': 'g', 'ඝ': 'g', 'ඞ': 'ng', 'ඟ': 'ng',
            'ච': 'c', 'ඡ': 'c', 'ජ': 'j', 'ඣ': 'j', 'ඤ': 'ny', 'ඥ': 'gn', 'ඦ': 'nj',
            'ට': 't', 'ඨ': 't', 'ඩ': 'd', 'ඪ': 'd', 'ණ': 'n', 'ඬ': 'nd',
            'ත': 't', 'ථ': 't', 'ද': 'd', 'ධ': 'd', 'න': 'n', 'ඳ': 'nd',
            'ප': 'p', 'ඵ': 'p', 'බ': 'b', 'භ': 'b', 'ම': 'm', 'ඹ': 'mb',
            'ය': 'y', 'ර': 'r', 'ල': 'l', 'ව': 'w', 'ශ': 's', 'ෂ': 's', 'ස': 's', 'හ': 'h', 'ළ': 'l', 'ෆ': 'f',
          };
          const signs: Record<string, string> = {
            '\u0DCA': '', '\u0DCF': 'a', '\u0DD0': 'a', '\u0DD1': 'a', '\u0DD2': 'i', '\u0DD3': 'i',
            '\u0DD4': 'u', '\u0DD6': 'u', '\u0DD8': 'ru', '\u0DD9': 'i', '\u0DDA': 'i', '\u0DDB': 'ai',
            '\u0DDC': 'u', '\u0DDD': 'u', '\u0DDE': 'au', '\u0DDF': 'lu',
          };
          let out = '';
          const chars = Array.from(input);
          for (let i = 0; i < chars.length; i++) {
            const ch = chars[i];
            if (indep[ch]) out += indep[ch];
            else if (cons[ch]) {
              const nxt = chars[i + 1] || '';
              if (nxt in signs) { out += cons[ch] + signs[nxt]; i++; }
              else out += cons[ch] + 'a';
            } else if (ch === 'ං' || ch === 'ඃ') out += 'n';
            else if (ch !== '\u200D' && ch !== '\u200C') out += ch;
          }
          return out;
        };

        const cleanQ = q
          .split(/[|•]/)[0]
          .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
          .replace(/\b(karaoke|instrumental|lyrics|lyric|with|on\s+screen|version|official|video|audio|hd|hq|original|key|cover|minus\s+one|without\s+voice|sinhala|new\s+song|teledrama|theme\s+song|track|canlk|etunes)\b/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim() || q;

        const normPhonetic = (s: string) =>
          sinhalaToSinglish(s)
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/th/g, 't')
            .replace(/dh/g, 'd')
            .replace(/sh/g, 's')
            .replace(/ch/g, 'c')
            .replace(/ph/g, 'p')
            .replace(/bh/g, 'b')
            .replace(/kh/g, 'k')
            .replace(/gh/g, 'g')
            .replace(/v/g, 'w')
            .replace(/wu/g, 'u')
            .replace(/wo/g, 'o')
            .replace(/[ei]+/g, 'i')
            .replace(/[ou]+/g, 'u')
            .replace(/a+/g, 'a')
            .replace(/([a-z])\1+/g, '$1')
            .replace(/\s+/g, ' ')
            .trim();

        const qNormKey = normPhonetic(cleanQ);
        if (env.DB && qNormKey) {
          await ensureSchema(env.DB);
          try {
            const d1Hit: any = await env.DB.prepare('SELECT plain_lyrics FROM cached_lyrics WHERE q_norm = ?').bind(qNormKey).first();
            if (d1Hit?.plain_lyrics) {
              return new Response(JSON.stringify({ track: { plainLyrics: d1Hit.plain_lyrics } }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=604800, s-maxage=604800', ...CORS_HEADERS },
              });
            }
          } catch (_) {}
        }

        const cacheKey = new Request(`https://singvaza-cache.local/v17.5/lyrics?q=${encodeURIComponent(cleanQ.toLowerCase())}`);
        const edgeCache = (globalThis as any).caches?.default;
        if (edgeCache) {
          const cachedHit = await edgeCache.match(cacheKey);
          if (cachedHit) return cachedHit;
        }

        const wordsMatch = (sw: string, qw: string) =>
          sw === qw || (qw.length >= 4 && sw.length >= 4 && (sw.startsWith(qw) || qw.startsWith(sw)));

        // Guaranteed 100% singer-name-free, chord-free, ad-free pure Sinhala verse line extractor
        const extractPureSinhalaStanzas = (rawHtmlOrText: string): string => {
          const text = rawHtmlOrText
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|h[1-6]|li|pre|blockquote)>/gi, '\n\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&#8230;|&hellip;/g, '...')
            .replace(/&#8211;|&ndash;/g, '–')
            .replace(/&#8217;|&#39;|&rsquo;/g, "'")
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&');

          const creditSinRe = /(ගායනය|ගැයුම|ගී\s*පද|පද\s*රචන|සංගීතය|තනුව|නිෂ්පාදනය|ප්‍රියතම සිංහල|ප්රියතම සිංහල|අප හා එක්වන්න|දායක වන්න|නාළිකාව)/;
          const out: string[] = [];
          let verseCount = 0;

          for (const rawLine of text.split(/\r?\n/)) {
            const ln = rawLine.replace(/\s+/g, ' ').trim();
            if (!ln) {
              if (out.length && out[out.length - 1] !== '') out.push('');
              continue;
            }
            if (!/[\u0D80-\u0DFF]{2,}/.test(ln)) continue;
            if (/[A-Za-z]{2,}/.test(ln)) continue;
            if (/\d{3}/.test(ln) || ln.length > 80) continue;
            if (creditSinRe.test(ln)) continue;
            out.push(ln);
            verseCount++;
          }

          return verseCount >= 8 ? out.join('\n').replace(/\n{3,}/g, '\n\n').trim() : '';
        };
        if (!memSlIndex) {
          try {
            const assetUrl = new URL('/sl-songs.txt', request.url);
            const idxRes = env.ASSETS ? await env.ASSETS.fetch(assetUrl) : await fetch(assetUrl);
            if (idxRes.ok) {
              const rawTxt = await idxRes.text();
              const parsed: Array<{ t: string; w: string[]; p: string }> = [];
              for (const row of rawTxt.split('\n')) {
                const p1 = row.indexOf('|');
                const p2 = row.indexOf('|', p1 + 1);
                if (p1 < 0 || p2 < 0) continue;
                const t = row.slice(0, p1);
                const titleKey = row.slice(p1 + 1, p2);
                const p = row.slice(p2 + 1).trim();
                const w = normPhonetic(titleKey).split(' ').filter((x) => x.length >= 2);
                if (w.length) parsed.push({ t, w, p });
              }
              if (parsed.length > 1000) memSlIndex = parsed;
            }
          } catch (_) {}
        }

        const lookupInSlIndex = async (candidateQuery: string): Promise<string> => {
          if (!memSlIndex) return '';
          const qWords = normPhonetic(candidateQuery).split(' ').filter((w) => w.length >= 2);
          if (!qWords.length) return '';
          const minReq = qWords.length <= 2 ? qWords.length : Math.ceil(qWords.length * 0.75);

          const top: Array<{ score: number; entry: { t: string; w: string[]; p: string } }> = [];

          for (let i = 0; i < memSlIndex.length; i++) {
            const entry = memSlIndex[i];
            let hits = 0;
            for (let j = 0; j < qWords.length; j++) {
              if (entry.w.some((sw) => wordsMatch(sw, qWords[j]))) hits++;
            }
            if (hits >= minReq) {
              const typeBonus = entry.t === 'H' ? 0.06 : entry.t === 'S' ? 0.04 : 0.01;
              const score = hits / Math.max(qWords.length, entry.w.length * 0.75) + typeBonus;
              if (score >= 0.25) {
                if (top.length < 3) {
                  top.push({ score, entry });
                  top.sort((a, b) => b.score - a.score);
                } else if (score > top[2].score) {
                  top[2] = { score, entry };
                  top.sort((a, b) => b.score - a.score);
                }
              }
            }
          }

          if (!top.length) return '';

          const pages = await Promise.all(
            top.map(async ({ entry }) => {
              const targetUrl =
                entry.t === 'H'
                  ? `https://www.lyrihub.lk/song/${entry.p}/`
                  : entry.t === 'S'
                  ? `https://sinhalasonglyrics.com/wp-json/wp/v2/posts?slug=${encodeURIComponent(entry.p)}&_fields=content`
                  : `https://lyrics-lk.com/song/${entry.p}`;
              try {
                const pr = await fetch(targetUrl, {
                  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36' },
                  signal: AbortSignal.timeout(4000),
                });
                if (!pr.ok) return '';
                if (entry.t === 'S') {
                  const arr: any = await pr.json();
                  const postHtml = String(arr?.[0]?.content?.rendered || '');
                  return postHtml ? extractPureSinhalaStanzas(postHtml) : '';
                }
                const html = await pr.text();
                if (entry.t === 'H') {
                  const bm = html.match(/class="lyri-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
                  if (bm) {
                    const pure = extractPureSinhalaStanzas(bm[1]);
                    if (pure) return pure;
                  }
                }
                return extractPureSinhalaStanzas(html);
              } catch (_) {
                return '';
              }
            })
          );

          return pages.find((x) => x.length > 40) || '';
        };

        let foundTrack: any = null;
        const browserUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
        const cleanLatin = /[\u0D80-\u0DFF]/.test(cleanQ) ? sinhalaToSinglish(cleanQ) : cleanQ;

        // STEP 1 (~250-500ms IN PARALLEL): 15,601 Sri Lankan RAM Index + Global LRCLIB / Lyrics.ovh
        const [slDirect, globalDirect] = await Promise.all([
          lookupInSlIndex(cleanQ),
          (async () => {
            if (/[\u0D80-\u0DFF]/.test(cleanQ)) return null;
            const qWordsRaw = cleanLatin.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
            const [lrcHit, ovhHit] = await Promise.all([
              (async () => {
                try {
                  const r = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(cleanLatin)}`, {
                    headers: { Accept: 'application/json', 'User-Agent': browserUa },
                    signal: AbortSignal.timeout(3000),
                  });
                  if (!r.ok) return null;
                  const list = (await r.json()) as any[];
                  return list.find((item) => {
                    if (!item.plainLyrics && !item.syncedLyrics) return false;
                    const meta = `${item.trackName || ''} ${item.name || ''} ${item.artistName || ''}`.toLowerCase();
                    return qWordsRaw.every((w) => meta.includes(w));
                  }) || null;
                } catch (_) {
                  return null;
                }
              })(),
              (async () => {
                try {
                  const sugRes = await fetch(`https://api.lyrics.ovh/suggest/${encodeURIComponent(cleanLatin)}`, {
                    headers: { Accept: 'application/json', 'User-Agent': browserUa },
                    signal: AbortSignal.timeout(2500),
                  });
                  if (!sugRes.ok) return null;
                  const sugJson: any = await sugRes.json();
                  const cand = (sugJson?.data || []).find((d: any) => {
                    const meta = `${d?.title || ''} ${d?.artist?.name || ''}`.toLowerCase();
                    return qWordsRaw.every((w) => meta.includes(w));
                  });
                  if (!cand?.artist?.name || !cand?.title) return null;
                  const lyrRes = await fetch(
                    `https://api.lyrics.ovh/v1/${encodeURIComponent(cand.artist.name)}/${encodeURIComponent(cand.title)}`,
                    { headers: { Accept: 'application/json', 'User-Agent': browserUa }, signal: AbortSignal.timeout(3000) }
                  );
                  if (!lyrRes.ok) return null;
                  const lyrJson: any = await lyrRes.json();
                  const plain = String(lyrJson?.lyrics || '').replace(/^Paroles de la chanson[^\n]*\n+/i, '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
                  return plain.length > 40 ? { plainLyrics: plain } : null;
                } catch (_) {
                  return null;
                }
              })(),
            ]);
            return lrcHit || ovhHit || null;
          })(),
        ]);

        if (slDirect) {
          foundTrack = { plainLyrics: slDirect };
        } else if (globalDirect) {
          foundTrack = globalDirect;
        }

        // STEP 2 (~650ms — ONLY IF NOT IN 15,601 SL SONGS OR GLOBAL DB, e.g. Teledrama Theme Songs like "Hamadama Oya Daasa"):
        // Uses YouTube to auto-correct spelling -> checks 15,601 SL Index again -> extracts ONLY pure Sinhala verse lines (ZERO English/singer names ever!)
        if (!foundTrack) {
          try {
            const ytRes = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                context: { client: { clientName: 'WEB', clientVersion: '2.20241001.01.00', hl: 'en', gl: 'LK' } },
                query: cleanQ,
              }),
              signal: AbortSignal.timeout(3000),
            });
            if (ytRes.ok) {
              const sJson: any = await ytRes.json();
              const vids: { id: string; title: string }[] = [];
              JSON.stringify(sJson, (_k, v) => {
                if (v && typeof v === 'object' && v.videoRenderer?.videoId) {
                  vids.push({
                    id: v.videoRenderer.videoId,
                    title: (v.videoRenderer.title?.runs || []).map((r: any) => r.text).join(''),
                  });
                }
                return v;
              });

              if (vids.length > 0) {
                const ytTitle = vids[0].title.split(/[|•-]/)[0].replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').trim();
                const slRetry = ytTitle ? await lookupInSlIndex(ytTitle) : '';
                if (slRetry) {
                  foundTrack = { plainLyrics: slRetry };
                } else {
                  const infos = await Promise.all(
                    vids.slice(0, 5).map(async (v) => {
                      try {
                        const ir = await fetch(`https://inv.nadeko.net/api/v1/videos/${encodeURIComponent(v.id)}?fields=description`, {
                          headers: { Accept: 'application/json', 'User-Agent': browserUa },
                          signal: AbortSignal.timeout(3000),
                        });
                        if (ir.ok) {
                          const ij: any = await ir.json();
                          const pure = extractPureSinhalaStanzas(String(ij?.description || ''));
                          if (pure) return pure;
                        }
                      } catch (_) {}
                      return '';
                    })
                  );
                  const cleanSin = infos.find((t) => t.length > 50);
                  if (cleanSin) foundTrack = { plainLyrics: cleanSin };
                }
              }
            }
          } catch (_) {}
        }

        if (foundTrack && env.DB && qNormKey) {
          const textToSave = String(foundTrack.plainLyrics || foundTrack.syncedLyrics || '').trim();
          if (textToSave.length > 40) {
            try {
              await env.DB.prepare('INSERT OR REPLACE INTO cached_lyrics (q_norm, plain_lyrics) VALUES (?, ?)').bind(qNormKey, textToSave).run();
            } catch (_) {}
          }
        }

        const outResp = new Response(JSON.stringify({ track: foundTrack }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': foundTrack ? 'public, max-age=604800, s-maxage=604800' : 'no-store',
            ...CORS_HEADERS,
          },
        });
        if (edgeCache && foundTrack) {
          try { await edgeCache.put(cacheKey, outResp.clone()); } catch (_) {}
        }
        return outResp;
      }

      // 3a. Official Google Sign-In
      if (url.pathname === '/api/auth/google' && request.method === 'POST') {
        await ensureSchema(env.DB);
        const body: any = await request.json();
        const challengeError = await requireAuthChallenge(request, env, body.turnstileToken);
        if (challengeError) return challengeError;
        const credential = String(body.credential || '').trim();
        if (!credential) return json({ error: 'Missing Google credential token.' }, 400);
        if (!env.DB) return json({ error: 'Database unavailable' }, 500);

        const sMap = await getSettingsMap(env.DB);
        const activeGoogleClientId = sMap.google_client_id || env.GOOGLE_CLIENT_ID || '';
        const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
        if (!verifyRes.ok) {
          return json({ error: 'Invalid or expired Google sign-in token.' }, 401);
        }
        const gUser: any = await verifyRes.json();
        if (activeGoogleClientId && gUser.aud !== activeGoogleClientId) {
          return json({ error: 'Google Client ID mismatch.' }, 401);
        }
        const email = String(gUser.email || '').trim().toLowerCase();
        if (!email || String(gUser.email_verified) !== 'true') {
          return json({ error: 'Verified Gmail address required.' }, 401);
        }
        const displayName = String(gUser.name || gUser.given_name || email.split('@')[0] || 'Artist').trim();

        let existing: any = await env.DB.prepare(
          'SELECT id, email, display_name, plan, currency, exports_this_month, pro_until, daily_date, daily_exports FROM users WHERE email = ?'
        ).bind(email).first();

        let isNewUser = false;
        if (!existing) {
          isNewUser = true;
          const userId = crypto.randomUUID();
          const proUntil = Date.now() + THIRTY_DAYS_MS;
          await env.DB.prepare(
            `INSERT INTO users (id, email, password_hash, display_name, plan, currency, exports_this_month, pro_until, daily_date, daily_exports, auth_provider)
             VALUES (?, ?, '', ?, 'free', 'USD', 0, ?, ?, 0, 'google')`
          ).bind(userId, email, displayName, proUntil, tzInfo.localDate).run();
          existing = {
            id: userId, email, display_name: displayName, plan: 'free', currency: 'USD',
            exports_this_month: 0, pro_until: proUntil, daily_date: tzInfo.localDate, daily_exports: 0,
          };
        } else if (!Number(existing.pro_until || 0)) {
          const proUntil = Date.now() + THIRTY_DAYS_MS;
          await env.DB.prepare('UPDATE users SET pro_until = ?, auth_provider = ? WHERE id = ?')
            .bind(proUntil, 'google', existing.id).run();
          existing.pro_until = proUntil;
        }

        const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
        await env.DB.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').bind(token, existing.id).run();
        const quota = buildQuotaSummary(existing, true, tzInfo);
        return json({ ok: true, isNewUser, token, user: existing, quota });
      }

      // 3b. Auth Register
      if (url.pathname === '/api/auth/register' && request.method === 'POST') {
        await ensureSchema(env.DB);
        const body: any = await request.json();
        const challengeError = await requireAuthChallenge(request, env, body.turnstileToken);
        if (challengeError) return challengeError;
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const displayName = String(body.display_name || email.split('@')[0] || 'Artist').trim();

        if (!email || !email.includes('@') || password.length < 4) {
          return json({ error: 'Enter a valid Gmail / email address and password (min 4 characters).' }, 400);
        }
        if (!env.DB) return json({ error: 'Database unavailable' }, 500);

        const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
        if (existing) {
          return json({ error: 'This email is already registered. Please switch to Sign In.' }, 409);
        }

        const userId = crypto.randomUUID();
        const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
        const hash = await sha256Hex(password);
        const proUntil = Date.now() + THIRTY_DAYS_MS;

        await env.DB.prepare(
          `INSERT INTO users (id, email, password_hash, display_name, plan, currency, exports_this_month, pro_until, daily_date, daily_exports, auth_provider)
           VALUES (?, ?, ?, ?, 'free', 'USD', 0, ?, ?, 0, 'email')`
        ).bind(userId, email, hash, displayName, proUntil, tzInfo.localDate).run();

        await env.DB.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').bind(token, userId).run();

        const userObj = {
          id: userId, email, display_name: displayName, plan: 'free', currency: 'USD',
          exports_this_month: 0, pro_until: proUntil, daily_date: tzInfo.localDate, daily_exports: 0,
        };
        return json({
          ok: true,
          isNewUser: true,
          token,
          user: userObj,
          quota: buildQuotaSummary(userObj, true, tzInfo),
        });
      }

      // 4. Auth Login
      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        await ensureSchema(env.DB);
        const body: any = await request.json();
        const challengeError = await requireAuthChallenge(request, env, body.turnstileToken);
        if (challengeError) return challengeError;
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        if (!env.DB) return json({ error: 'Database unavailable' }, 500);

        const hash = await sha256Hex(password);
        const user: any = await env.DB.prepare(
          'SELECT id, email, password_hash, display_name, plan, currency, exports_this_month, pro_until, daily_date, daily_exports FROM users WHERE email = ?'
        ).bind(email).first();

        if (!user || !user.password_hash || user.password_hash !== hash) {
          return json({ error: 'Incorrect email or password.' }, 401);
        }

        if (!Number(user.pro_until || 0)) {
          const proUntil = Date.now() + THIRTY_DAYS_MS;
          await env.DB.prepare('UPDATE users SET pro_until = ? WHERE id = ?').bind(proUntil, user.id).run();
          user.pro_until = proUntil;
        }

        const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
        await env.DB.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').bind(token, user.id).run();
        const { password_hash, ...safeUser } = user;
        return json({ ok: true, token, user: safeUser, quota: buildQuotaSummary(safeUser, true, tzInfo) });
      }

      // 4b. Permanent Account & Data Deletion
      if (url.pathname === '/api/auth/account' && request.method === 'DELETE') {
        const { user: authUser, authenticated } = await resolveUser(request, env);
        if (!authenticated || !authUser || !env.DB) {
          return json({ error: 'Not signed in' }, 401);
        }
        await env.DB.batch([
          env.DB.prepare('DELETE FROM projects WHERE user_id = ?').bind(authUser.id),
          env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(authUser.id),
          env.DB.prepare('DELETE FROM users WHERE id = ?').bind(authUser.id),
        ]);
        return json({ ok: true, deleted: true });
      }

      // 5. State + Global Timezone Daily Quota Status
      if (url.pathname === '/api/state' && request.method === 'GET') {
        if (!env.DB) {
          return json({
            user: { id: 'demo', display_name: 'Guest Artist', plan: 'free', currency: 'USD', exports_this_month: 0 },
            projects: [],
            presets: [],
            d1Connected: false,
            authenticated: false,
            quota: buildQuotaSummary(null, false, tzInfo),
            googleClientId: env.GOOGLE_CLIENT_ID || '',
          });
        }
        await ensureSchema(env.DB);
        const sMap = await getSettingsMap(env.DB);
        const activeGoogleClientId = sMap.google_client_id || env.GOOGLE_CLIENT_ID || '';
        const customDailyLimit = Math.max(1, Math.floor(Number(sMap.daily_free_limit) || DAILY_FREE_LIMIT));
        const { user, authenticated } = await resolveUser(request, env);
        const projects = await env.DB.prepare(
          'SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 25'
        ).bind(user.id).all();
        const presets = await env.DB.prepare(
          'SELECT * FROM custom_presets WHERE is_public = 1 OR user_id = ? ORDER BY created_at DESC LIMIT 20'
        ).bind(user.id).all();

        const quotaObj = buildQuotaSummary(user, authenticated, tzInfo);
        quotaObj.dailyLimit = customDailyLimit;

        return json({
          user,
          projects: projects.results,
          presets: presets.results,
          d1Connected: true,
          authenticated,
          quota: quotaObj,
          googleClientId: activeGoogleClientId,
        });
      }

      // 6. Save Project
      if (url.pathname === '/api/projects' && request.method === 'POST') {
        const body: any = await request.json();
        const id = body.id || crypto.randomUUID();
        if (env.DB) {
          const { user } = await resolveUser(request, env);
          await env.DB.prepare(
            `INSERT INTO projects (id, user_id, title, youtube_url, preset_key, musical_key, musical_scale, vocal_offset_ms, settings_json, duration_sec, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               youtube_url = excluded.youtube_url,
               preset_key = excluded.preset_key,
               musical_key = excluded.musical_key,
               musical_scale = excluded.musical_scale,
               vocal_offset_ms = excluded.vocal_offset_ms,
               settings_json = excluded.settings_json,
               duration_sec = excluded.duration_sec,
               updated_at = CURRENT_TIMESTAMP`
          ).bind(
            id, user.id, body.title || 'Untitled Studio Cover', body.youtube_url || '',
            body.preset_key || 'sinhala_ballad', body.musical_key || 'A', body.musical_scale || 'minor',
            Number(body.vocal_offset_ms || 0), JSON.stringify(body.settings || {}), Number(body.duration_sec || 0)
          ).run();
        }
        return json({ ok: true, id });
      }

      if (url.pathname.startsWith('/api/projects/') && request.method === 'DELETE') {
        const projId = url.pathname.split('/').pop();
        if (env.DB && projId) {
          const { user } = await resolveUser(request, env);
          await env.DB.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').bind(projId, user.id).run();
        }
        return json({ ok: true });
      }

      if (url.pathname === '/api/presets' && request.method === 'POST') {
        const body: any = await request.json();
        const id = crypto.randomUUID();
        if (env.DB) {
          const { user } = await resolveUser(request, env);
          await env.DB.prepare(
            `INSERT INTO custom_presets (id, user_id, name, voice_profile, settings_json, is_public)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(id, user.id, body.name || 'Custom Vocal Chain', body.voice_profile || 'balanced', JSON.stringify(body.settings || {}), body.is_public ? 1 : 0).run();
        }
        return json({ ok: true, id });
      }

      // Shared recorder + remover download counter. Authenticated accounts are
      // updated atomically; guests keep their existing local-browser allowance.
      if (url.pathname === '/api/track-export' && request.method === 'POST') {
        const settings = await getSettingsMap(env.DB);
        const limit = Math.max(1, Math.floor(Number(settings.daily_free_limit) || DAILY_FREE_LIMIT));
        if (env.DB) {
          const { user, authenticated } = await resolveUser(request, env);
          if (!authenticated && request.headers.get('Authorization')) {
            return json({ ok: false, allowed: false, error: 'Your session expired. Please sign in again.' }, 401);
          }
          if (authenticated) {
            const current = buildQuotaSummary(user, true, tzInfo);
            current.dailyLimit = limit;
            // One conditional UPDATE makes two simultaneous requests compete for
            // the last remaining free slot rather than both passing a stale read.
            const update = await env.DB.prepare(
              `UPDATE users SET exports_this_month = COALESCE(exports_this_month, 0) + 1,
                 daily_exports = CASE WHEN daily_date = ? THEN COALESCE(daily_exports, 0) + 1 ELSE 1 END,
                 daily_date = ? WHERE id = ? AND (? = 1 OR COALESCE(daily_date, '') != ? OR COALESCE(daily_exports, 0) < ?)`
            ).bind(tzInfo.localDate, tzInfo.localDate, user.id, current.proActive ? 1 : 0, tzInfo.localDate, limit).run();
            const fresh: any = await env.DB.prepare('SELECT id, plan, pro_until, daily_date, daily_exports FROM users WHERE id = ?').bind(user.id).first();
            const quota = buildQuotaSummary(fresh || user, true, tzInfo);
            quota.dailyLimit = limit;
            if (!update.meta?.changes) return json({ ok: false, allowed: false, quota }, 429);
            return json({ ok: true, allowed: true, quota });
          }
        }
        const quota = buildQuotaSummary(null, false, tzInfo);
        quota.dailyLimit = limit;
        return json({ ok: true, allowed: true, quota });
      }

      if (url.pathname === '/api/upgrade-demo' && request.method === 'POST') {
        const body: any = await request.json();
        const plan = body.plan || 'pro_global';
        if (env.DB) {
          const { user } = await resolveUser(request, env);
          await env.DB.prepare('UPDATE users SET plan = ? WHERE id = ?').bind(plan, user.id).run();
        }
        return json({ ok: true, plan });
      }

      // 8. Support & Feedback Contact Form Endpoint
      if (url.pathname === '/api/contact' && request.method === 'POST') {
        await ensureSchema(env.DB);
        const body: any = await request.json();
        const name = String(body.name || '').trim().slice(0, 120);
        const email = String(body.email || '').trim().slice(0, 160);
        const subject = String(body.subject || 'General Inquiry').trim().slice(0, 160);
        const message = String(body.message || '').trim().slice(0, 3000);
        if (!name || !email.includes('@') || message.length < 5) {
          return json({ error: 'Please fill in your name, email address, and message.' }, 400);
        }
        if (env.DB) {
          await env.DB.prepare(
            'INSERT INTO contact_messages (id, name, email, subject, message) VALUES (?, ?, ?, ?, ?)'
          ).bind(crypto.randomUUID(), name, email, subject, message).run();
        }
        return json({ ok: true, received: true });
      }

      // Admin-saved page edit, if any: the static file is served, then replaced by
      // the stored page so uploads/downloads/rollback work without a redeploy.
      if (env.ASSETS && env.DB && /^\/(index\.html)?$|^\/(about|contact|privacy|terms|refunds)(\.html)?\/?$/.test(cleanPath)) {
        const quickToken = String(request.headers.get('X-Admin-Token') || '').trim();
        let isAdmin = false;
        if (quickToken) {
          isAdmin = await isValidBlogAdmin(new Request(url.toString(), { headers: { Authorization: 'Bearer ' + quickToken } }), env);
          if (!isAdmin) return new Response('Unauthorized', { status: 401 });
        }
        // A signed preview link (created in the admin panel) shows the greeting
        // outside its dates for that one admin. The signature covers the expiry
        // only and is an HMAC of the admin password hash, so it is useless to the
        // public and cannot be forged without the password.
        let previewRequested = false;
        const previewUntil = Number(url.searchParams.get('occasion_preview') || 0);
        const previewSig = String(url.searchParams.get('sig') || '');
        if (previewUntil > Date.now() && previewSig) {
          const settings = await getSettingsMap(env.DB);
          const secret = String(settings.admin_pass_sha256 || DEFAULT_ADMIN_SHA256);
          previewRequested = (await occasionPreviewSignature('until:' + previewUntil, secret)) === previewSig;
        }
        const pagePath = cleanPath === '/' || cleanPath === '/index.html'
          ? '/'
          : '/' + cleanPath.replace(/^\//, '').replace(/\.html$/i, '').replace(/\/$/, '');
        // Ask the static handler for exactly the requested path: asking for
        // /index.html makes Pages answer with a 308 back to / and the worker would
        // bounce the visitor in a redirect loop.
        const assetReq = new Request(new URL(cleanPath, url).toString(), request);
        let assetRes = await env.ASSETS.fetch(assetReq);
        if (assetRes.status >= 300 && assetRes.status < 400) {
          const location = assetRes.headers.get('Location');
          if (!location) return assetRes;
          assetRes = await env.ASSETS.fetch(new Request(new URL(location, url).toString(), request));
        }
        if (assetRes.ok && (assetRes.headers.get('Content-Type') || '').includes('text/html')) {
          const html = await applyPageOverride(pagePath, await assetRes.text(), env, isAdmin, previewRequested);
          const headers = new Headers(assetRes.headers);
          headers.delete('Content-Length');
          return new Response(request.method === 'HEAD' ? null : html, { status: assetRes.status, headers });
        }
        return assetRes;
      }

      // A file published from an uploaded zip (or an updated copy of one) is served
      // here instead of the built-in asset. Only an exact stored row can match, so
      // nothing else changes.
      if (env.DB && (request.method === 'GET' || request.method === 'HEAD')) {
        const relPath = cleanPath.replace(/^\/+/, '');
        if (relPath && !relPath.includes('..') && !relPath.startsWith('api/')) {
          try {
            const row: any = await env.DB.prepare('SELECT v FROM site_settings WHERE k = ?').bind('live_override:' + relPath).first();
            if (row && typeof row.v === 'string') {
              return new Response(request.method === 'HEAD' ? null : row.v, {
                headers: { 'Content-Type': contentTypeFor(relPath), 'Cache-Control': 'no-cache' },
              });
            }
          } catch (_) {}
        }
      }

      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ error: 'Not found' }, 404);
    } catch (err: any) {
      return json({ error: err?.message || 'Internal error' }, 500);
    }
  },
};
