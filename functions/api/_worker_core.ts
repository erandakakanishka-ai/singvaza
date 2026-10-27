import { handleSecurityRoute, requiresEntrySession, requireEntrySession, requireAuthChallenge, type SecurityEnv } from '../../src/security';

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
const DAILY_FREE_LIMIT = 2;
const DEFAULT_ADMIN_SHA256 = 'b5098ccafc515b07d2d7033a3102e61dcd6ea5d61e91b77d1fce82a4cc3cac16';

let schemaChecked = false;
let memSlIndex: Array<{ t: string; w: string[]; p: string }> | null = null;

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
  for (const sql of statements) {
    try { await db.prepare(sql).run(); } catch (_) {}
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
  <script defer src="/guard.js?v=1"></script>
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
    h1 { font-size:clamp(25px,4vw,35px); line-height:1.22; margin-bottom:12px; }
    h2 { font-size:20px; margin:20px 0 8px; color:var(--amber); }
    h3 { font-size:17px; margin:16px 0 6px; color:var(--text); }
    p { color:#cbd5e1; margin-bottom:14px; font-size:15px; }
    .card { background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:24px; margin-bottom:18px; }
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
        <a href="/">Open Studio</a>
        <a href="/blog" style="color:var(--amber);font-weight:700;">Blog</a>
        <a href="/about">About</a>
        <a href="/contact">Contact</a>
        <button onclick="if(navigator.share){navigator.share({title:document.title,url:location.href}).catch(()=>{});}else{navigator.clipboard?.writeText(location.href);alert('Link copied: '+location.href);}" style="background:rgba(251,191,36,0.14);border:1px solid rgba(251,191,36,0.4);color:var(--amber);border-radius:8px;padding:4px 10px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;">Share ↗</button>
      </nav>
    </header>
    ${opts.bodyHtml}
    <footer>
      <div>
        <a href="/">Home Studio</a> •
        <a href="/blog">Blog</a> •
        <a href="/about">About Us</a> •
        <a href="/contact">Contact Support</a> •
        <a href="/privacy">Privacy Policy</a> •
        <a href="/terms">Terms of Service</a>
      </div>
      <div style="margin-top:8px;">© 2026 SingVaza</div>
    </footer>
  </div>
</body>
</html>`;
}

/** Add the shared visitor gate even to standalone editor-supplied HTML. */
function addGuardToStandaloneHtml(html: string): string {
  const assets = '<link rel="stylesheet" href="/guard.css?v=1" /><script defer src="/guard.js?v=1"></script>';
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, (tag) => assets + tag);
  if (/<body\b[^>]*>/i.test(html)) return html.replace(/<body\b[^>]*>/i, (tag) => tag + assets);
  return assets + html;
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode('karomix_salt_v1:' + input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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
              env.DB.prepare('SELECT slug, title, excerpt, updated_at FROM blog_posts ORDER BY updated_at DESC LIMIT 200').all(),
              env.DB.prepare('SELECT slug, title, description, updated_at FROM html_tools ORDER BY updated_at DESC LIMIT 200').all(),
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
          postUrls += `\n  <url>\n    <loc>${escapeHtml(url.origin)}/tools</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.9</priority>\n  </url>`;
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
            ? await env.DB.prepare('SELECT id, slug, title, category, icon, description, views, created_at FROM html_tools ORDER BY created_at DESC LIMIT 200').all()
            : { results: [] };
          const list = (rows.results || []) as any[];
          const bodyHtml = `
            <h1>Online Tools</h1>
            <p style="color:var(--muted);margin-bottom:24px;">Fast browser-based utilities and interactive web tools.</p>
            ${list.length === 0
              ? `<div class="card"><p style="margin:0;">New tools are coming soon. <a href="/" style="color:var(--amber);">Back to Home →</a></p></div>`
              : `<div class="grid">${list.map((t) => `
                <a class="post-card" href="/tools/${escapeHtml(t.slug)}" style="padding:20px;">
                  <div style="font-size:28px;margin-bottom:10px;">${escapeHtml(t.icon || '⚡')}</div>
                  <div class="tag">${escapeHtml(t.category || 'Web Tool')}</div>
                  <h2 style="font-size:17.5px;color:var(--text);margin:6px 0 8px;">${escapeHtml(t.title)}</h2>
                  <p style="font-size:13.5px;color:var(--muted);margin:0;">${escapeHtml(t.description || '')}</p>
                </a>`).join('')}</div>`
            }${beaconTag}`;
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
            ? await env.DB.prepare('SELECT id, slug, title, category, cover_image, excerpt, author_name, created_at FROM blog_posts ORDER BY created_at DESC LIMIT 100').all()
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

      // HTML Web Tools CRUD API (/api/tools)
      if (url.pathname === '/api/tools' && request.method === 'GET') {
        await ensureSchema(env.DB);
        if (!env.DB) return json({ tools: [] });
        const rows = await env.DB.prepare('SELECT * FROM html_tools ORDER BY created_at DESC LIMIT 200').all();
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

        await env.DB.prepare(
          `INSERT INTO html_tools (id, slug, title, category, icon, description, seo_tags, html_code, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(id) DO UPDATE SET
             slug = excluded.slug,
             title = excluded.title,
             category = excluded.category,
             icon = excluded.icon,
             description = excluded.description,
             seo_tags = excluded.seo_tags,
             html_code = excluded.html_code,
             updated_at = CURRENT_TIMESTAMP`
        ).bind(id, rawSlug, title, category, icon, description, seoTags, htmlCode).run();

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

        return json({ ok: true, id, slug: rawSlug, url: `/tools/${rawSlug}` });
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
        const rows = await env.DB.prepare('SELECT * FROM blog_posts ORDER BY created_at DESC LIMIT 100').all();
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

        await env.DB.prepare(
          `INSERT INTO blog_posts (id, slug, title, category, cover_image, excerpt, seo_tags, content, content_format, author_name, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
             updated_at = CURRENT_TIMESTAMP`
        ).bind(id, rawSlug, title, category, coverImage, excerpt, seoTags, content, contentFormat, authorName).run();

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

        return json({ ok: true, id, slug: rawSlug, url: `/blog/${rawSlug}` });
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
        const customDailyLimit = Math.max(1, Number(sMap.daily_free_limit || DAILY_FREE_LIMIT));
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

      // 7. Timezone-Aware Daily Export Counter
      if (url.pathname === '/api/track-export' && request.method === 'POST') {
        if (env.DB) {
          const { user, authenticated } = await resolveUser(request, env);
          if (authenticated) {
            const currentQuota = buildQuotaSummary(user, true, tzInfo);
            if (!currentQuota.proActive && currentQuota.dailyUsed >= DAILY_FREE_LIMIT) {
              return json({ ok: false, allowed: false, quota: currentQuota }, 429);
            }
            const nextDaily = user.daily_date === tzInfo.localDate ? Number(user.daily_exports || 0) + 1 : 1;
            await env.DB.prepare(
              'UPDATE users SET exports_this_month = exports_this_month + 1, daily_date = ?, daily_exports = ? WHERE id = ?'
            ).bind(tzInfo.localDate, nextDaily, user.id).run();
            user.daily_date = tzInfo.localDate;
            user.daily_exports = nextDaily;
            return json({ ok: true, allowed: true, quota: buildQuotaSummary(user, true, tzInfo) });
          }
        }
        return json({ ok: true, allowed: true, quota: buildQuotaSummary(null, false, tzInfo) });
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

      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ error: 'Not found' }, 404);
    } catch (err: any) {
      return json({ error: err?.message || 'Internal error' }, 500);
    }
  },
};
