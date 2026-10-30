import { builtinPage, builtinResponse } from '../src/builtin-pages';
import { insertBeforeBodyClose } from '../src/html-insert';
import worker from './api/_worker_core';

const request_HEAD = (request: Request) => request.method === 'HEAD';

export const onRequest: PagesFunction<any> = async (context) => {
  const url = new URL(context.request.url);
  let cleanPath = url.pathname;
  try {
    cleanPath = decodeURIComponent(url.pathname).replace(/^\/\s+/, '/').replace(/\s+$/, '');
  } catch (_) {}

  if ((context.request.method === 'GET' || context.request.method === 'HEAD') && builtinPage(cleanPath)) {
    const rewritten = new Request(new URL('/', url).toString(), context.request);
    const response = await context.next(rewritten);
    return builtinResponse(response, context.request);
  }

  if (
    cleanPath === '/sitemap.xml' ||
    cleanPath === '/rss.xml' ||
    cleanPath === '/8dc68fc0e32ac33e8dc68fc0e32ac33e.txt' ||
    cleanPath === '/google8dc68fc0e32ac33e.html' ||
    cleanPath === '/blog' ||
    cleanPath === '/blog/' ||
    cleanPath.startsWith('/blog/') ||
    cleanPath === '/tools' ||
    cleanPath === '/tools/' ||
    cleanPath.startsWith('/tools/')
  ) {
    return worker.fetch(context.request, context.env);
  }

  // Main-site page uploads (download / replace / private / restore) live in the
  // Worker, which can rewrite the static asset. Delegate only when an upload or a
  // private flag actually exists, so the default homepage keeps its own SEO
  // injection below and nothing changes for sites that never use the feature.
  if ((context.request.method === 'GET' || context.request.method === 'HEAD') && context.env?.DB) {
    const pagePath = cleanPath === '/' || cleanPath === '/index.html'
      ? '/'
      : ['/about', '/about.html', '/contact', '/contact.html', '/privacy', '/privacy.html', '/terms', '/terms.html', '/refunds', '/refunds.html'].includes(cleanPath)
        ? '/' + cleanPath.replace(/^\//, '').replace(/\.html$/i, '')
        : '';
    if (pagePath) {
      try {
        const keys = ['page_override:' + pagePath, 'page_visibility:' + pagePath, 'occasion_config'];
        const rows = await context.env.DB.prepare('SELECT k, v FROM site_settings WHERE k IN (?, ?, ?)').bind(keys[0], keys[1], keys[2]).all();
        const found = ((rows.results || []) as any[]).filter((r) => keys.includes(String(r?.k)));
        if (found.length) return await worker.fetch(context.request, context.env);
      } catch (_) {
        // No settings table yet, or the worker could not answer: use the static page.
      }
    }
  }

  // A static file that was replaced by an upload (the "whole site" zip) is served by
  // the Worker instead of the built-in asset. The list of replaced files is kept in
  // one setting and cached at the edge for a minute, so an ordinary asset request
  // costs nothing when the feature has never been used.
  if ((context.request.method === 'GET' || context.request.method === 'HEAD') && !cleanPath.startsWith('/api/') && /\.[a-z0-9]+$/i.test(cleanPath) && context.env?.DB) {
    const rel = cleanPath.replace(/^\/+/, '');
    try {
      const cache = (globalThis as any).caches?.default;
      const key = new Request(new URL('/__sv_live_overrides', url).toString());
      let list: string[] | null = null;
      const hit = cache ? await cache.match(key) : null;
      if (hit) {
        list = await hit.json() as string[];
      } else {
        const row: any = await context.env.DB.prepare('SELECT v FROM site_settings WHERE k = ?').bind('live_overrides_list').first();
        list = JSON.parse(String(row?.v || '[]'));
        if (cache) {
          await cache.put(key, new Response(JSON.stringify(list), { headers: { 'Cache-Control': 'max-age=60', 'Content-Type': 'application/json' } }));
        }
      }
      if (Array.isArray(list) && list.includes(rel)) return worker.fetch(context.request, context.env);
    } catch (_) {
      // No table, no cache binding, or bad JSON: serve the built-in asset.
    }
  }

  // Seasonal decoration: a tiny script on every page. It asks the server whether
  // today is a holiday USING THE VISITOR'S DATE, so "Happy Christmas" appears when
  // it is Christmas where the visitor is. It adds a greeting bar and snow on top of
  // the page and never touches the layout; with no holiday it does nothing at all.
  const isHomePath = cleanPath === '/' || cleanPath === '/index.html';
  if ((context.request.method === 'GET' || context.request.method === 'HEAD') && !isHomePath && !cleanPath.startsWith('/api/') && !cleanPath.startsWith('/model/')) {
    const res = await context.next();
    const type = res.headers.get('Content-Type') || '';
    if (!res.ok || !type.includes('text/html') || cleanPath === '/admin' || cleanPath.startsWith('/admin')) return res;
    try {
      let html = await res.text();
      // Never insert by regex: a page may contain '</body>' inside a script.
      if (!html.includes('/holiday.js')) html = insertBeforeBodyClose(html, '<script src="/holiday.js?v=1" defer></script>');
      const headers = new Headers(res.headers);
      headers.delete('Content-Length');
      headers.delete('ETag');
      return new Response(request_HEAD(context.request) ? null : html, { status: res.status, headers });
    } catch (_) {
      return res;
    }
  }

  // Dynamic Homepage YouTube-Style Title, Description & Tags Injection from /admin Settings!
  if ((cleanPath === '/' || cleanPath === '/index.html') && context.request.method === 'GET' && context.env?.DB) {
    const res = await context.next();
    try {
      const rows = await context.env.DB.prepare(
        `SELECT k, v FROM site_settings WHERE k IN ('seo_home_title', 'seo_home_description', 'seo_home_tags')`
      ).all();
      const map: Record<string, string> = {};
      for (const r of (rows.results || []) as any[]) {
        if (r?.k && r?.v) map[String(r.k)] = String(r.v);
      }
      if (map.seo_home_title || map.seo_home_description || map.seo_home_tags) {
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        let html = await res.text();
        if (map.seo_home_title) {
          html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(map.seo_home_title)}</title>`);
        }
        if (map.seo_home_description) {
          html = html.replace(/<meta name="description" content="[^"]*"\s*\/?>/i, `<meta name="description" content="${esc(map.seo_home_description)}" />`);
        }
        if (map.seo_home_tags) {
          html = html.replace(/<meta name="keywords" content="[^"]*"\s*\/?>/i, `<meta name="keywords" content="${esc(map.seo_home_tags)}" />`);
        }
        if (!html.includes('/holiday.js')) html = insertBeforeBodyClose(html, '<script src="/holiday.js?v=1" defer></script>');
        const outHeaders = new Headers(res.headers);
        outHeaders.delete('Content-Length');
        outHeaders.delete('ETag');
        return new Response(html, { status: res.status, headers: outHeaders });
      }
    } catch (_) {}
    if (context.request.method === 'GET') {
      // No SEO overrides: still add the seasonal tag once.
      try {
        const page = await res.clone().text();
        if (page.includes('/holiday.js')) return res;
        const headers = new Headers(res.headers);
        headers.delete('Content-Length');
        headers.delete('ETag');
        return new Response(insertBeforeBodyClose(page, '<script src="/holiday.js?v=1" defer></script>'), { status: res.status, headers });
      } catch (_) {}
    }
    return res;
  }

  return context.next();
};
