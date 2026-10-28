/** Deep links for the two built-in tools. Custom /tools/:slug URLs stay untouched. */
export function builtinPage(path: string) {
  const clean = path.replace(/\/$/, '');
  if (clean === '/studio/vocal-remover') return {
    title: 'Vocal Remover — Make Karaoke Online | SingVaza',
    description: 'Remove vocals from any song with an AI model that runs in your browser. Download a karaoke backing track or sing over it in SingVaza Recorder.',
    path: '/studio/vocal-remover',
  };
  if (clean === '/studio/karaoke-recorder') return {
    title: 'Karaoke Recorder & Mix Studio | SingVaza',
    description: 'Sing with karaoke, record your voice and mix your performance in your browser with SingVaza.',
    path: '/studio/karaoke-recorder',
  };
  return null;
}

export async function builtinResponse(response: Response, request: Request): Promise<Response> {
  const page = builtinPage(new URL(request.url).pathname);
  if (!page || !response.ok || request.method === 'HEAD') return response;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const canonical = esc(new URL(page.path, request.url).href);
  const title = esc(page.title), desc = esc(page.description);
  let html = await response.text();
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/i, `<meta name="description" content="${desc}" />`)
    .replace(/<link rel="canonical" href="[^"]*"\s*\/?>/i, `<link rel="canonical" href="${canonical}" />`)
    .replace(/<meta property="og:title" content="[^"]*"\s*\/?>/i, `<meta property="og:title" content="${title}" />`)
    .replace(/<meta property="og:description" content="[^"]*"\s*\/?>/i, `<meta property="og:description" content="${desc}" />`)
    .replace(/<meta property="og:url" content="[^"]*"\s*\/?>/i, `<meta property="og:url" content="${canonical}" />`);
  const headers = new Headers(response.headers);
  headers.delete('content-length'); headers.delete('etag');
  return new Response(html, { status: response.status, headers });
}
