import { builtinPage, builtinResponse } from '../src/builtin-pages';
import worker from './api/_worker_core';

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
        return new Response(html, { status: res.status, headers: res.headers });
      }
    } catch (_) {}
    return res;
  }

  return context.next();
};
