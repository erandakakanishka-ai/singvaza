/* The whole static site as ONE file, and the way back.
 *
 * Why: the operator wants a single click that hands over the complete static site
 * (minus the live tools and articles, which live in the database, and minus the
 * private admin panel), so it can be given to an AI assistant in one piece. The
 * updated copy is then uploaded back and only the files that really changed are
 * published — nothing else is touched.
 *
 * Rules kept from the rest of the project:
 *   - no dependency, no native code, everything works on the edge;
 *   - text files only on the way back (HTML, CSS, JS, JSON, TXT, XML); images and
 *     audio are refused, because a few megabytes in D1 would be the wrong place;
 *   - a publish can be undone in one click (the previous copy is kept). */

/** Never part of the download. */
export function isDownloadableSiteFile(path: string): boolean {
  const clean = path.replace(/^\/+/, '');
  if (!clean) return false;
  // The karaoke model is 46 MB of binaries served by its own function and never
  // edited by hand — including it would only make the archive unusable.
  if (clean.startsWith('model/')) return false;
  // The panel is private, and the search-engine verification file is not a page.
  if (/^admin\.html$/i.test(clean)) return false;
  if (/^google[0-9a-f]+\.html$/i.test(clean)) return false;
  return true;
}

/** Text files that may come back from the AI and go live. */
export const TEXT_EXTENSIONS = ['html', 'htm', 'css', 'js', 'mjs', 'json', 'txt', 'xml', 'webmanifest', 'svg'];

export function isPublishableTextFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return TEXT_EXTENSIONS.includes(ext);
}

export const MAX_TEXT_FILE_BYTES = 512 * 1024;
export const MAX_FILES_PER_UPLOAD = 60;

/** Where a changed file is kept once published, and where its previous copy is
 *  parked so the whole update can be undone. */
export const liveKey = (path: string) => 'live_override:' + normalizeSitePath(path);
export const undoKey = (path: string) => 'live_undo:' + normalizeSitePath(path);
export const stageKey = (path: string) => 'zip_stage:' + normalizeSitePath(path);

export function normalizeSitePath(path: string): string {
  let clean = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  // An AI sometimes wraps everything in a folder of the same name; unwrap it.
  const wrap = /^singvaza-site[^/]*\//i.test(clean);
  if (wrap) clean = clean.replace(/^singvaza-site[^/]*\//i, '');
  return clean;
}

/** Does an uploaded file path name a page the static site already serves? */
export function pagePathForFile(path: string): string | null {
  const clean = normalizeSitePath(path);
  if (/^index\.html$/i.test(clean)) return '/';
  const m = /^(about|contact|privacy|terms|refunds)\.html$/i.exec(clean);
  if (m) return '/' + m[1].toLowerCase();
  return null;
}

export interface ChangedFile {
  path: string;
  bytes: number;
  status: 'changed' | 'new' | 'same';
}

export function summarizeChanges(
  uploaded: { path: string; content: string }[],
  current: Record<string, string>
): ChangedFile[] {
  return uploaded.map((file) => {
    const path = normalizeSitePath(file.path);
    const bytes = new TextEncoder().encode(file.content).length;
    const before = current[path];
    const status: ChangedFile['status'] = before === undefined ? 'new' : before === file.content ? 'same' : 'changed';
    return { path, bytes, status };
  });
}

/** Content type for a published static file. */
export function contentTypeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    webmanifest: 'application/manifest+json; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    ico: 'image/x-icon',
    mp3: 'audio/mpeg',
  };
  return map[ext] || 'application/octet-stream';
}
