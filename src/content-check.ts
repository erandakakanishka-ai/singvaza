/* Content safety checks for everything the admin publishes.
 *
 * Every uploaded tool, article and main-site page goes through this before it can
 * be published: it reports hard errors (things that will break the page) and
 * warnings (things worth a second look), plus a fingerprint so a re-upload can be
 * compared with the file that is already live. That comparison is what stops an
 * "update" from silently wiping half of the existing content.
 *
 * Pure string work - no DOM, no fetch - so it runs in the Worker, in node tests
 * and (through the API) in the admin panel.
 */

export type IssueLevel = 'error' | 'warn' | 'info';

export interface ContentIssue {
  level: IssueLevel;
  code: string;
  message: string;
}

export interface ContentFingerprint {
  title: string;
  headings: string[];
  ids: string[];
  textLength: number;
  scripts: number;
  styles: number;
  images: number;
  forms: number;
  links: number;
}

export interface ContentReport {
  ok: boolean;
  kind: string;
  bytes: number;
  stats: {
    scripts: number;
    inlineScripts: number;
    externalScripts: string[];
    styles: number;
    images: number;
    links: number;
    forms: number;
    iframes: number;
  };
  /** Local (same-origin) asset paths the caller should verify with a HEAD request. */
  localRefs: string[];
  fingerprint: ContentFingerprint;
  issues: ContentIssue[];
}

const MAX_BYTES = 640 * 1024;

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function count(html: string, re: RegExp): number {
  return (html.match(re) || []).length;
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

export function fingerprint(html: string): ContentFingerprint {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const headings = Array.from(html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi))
    .map((m) => stripTags(m[2]))
    .filter(Boolean);
  const ids = Array.from(html.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)).map((m) => m[1]);
  return {
    title: titleMatch ? stripTags(titleMatch[1]) : '',
    headings: dedupe(headings).slice(0, 40),
    ids,
    textLength: stripTags(html).length,
    scripts: count(html, /<script/gi),
    styles: count(html, /<style/gi),
    images: count(html, /<img\b/gi),
    forms: count(html, /<form\b/gi),
    links: count(html, /<a\b/gi),
  };
}

/** Collect same-origin asset paths so the caller can check that they exist. */
export function localReferences(html: string): string[] {
  const refs: string[] = [];
  for (const m of html.matchAll(/(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)) {
    const value = m[1].trim();
    if (!value || value.startsWith('#') || value.startsWith('data:')) continue;
    if (/^(https?:)?\/\//i.test(value) || /^(mailto|tel|javascript):/i.test(value)) continue;
    if (!value.startsWith('/')) continue;
    const path = value.split('?')[0].split('#')[0];
    if (path && path !== '/') refs.push(path);
  }
  return dedupe(refs).slice(0, 60);
}

function externalScripts(html: string): string[] {
  const found: string[] = [];
  for (const m of html.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    if (/^(https?:)?\/\//i.test(m[1])) found.push(m[1]);
  }
  return dedupe(found);
}

export function analyzeContent(html: string, kind: 'tool' | 'blog' | 'page' = 'tool'): ContentReport {
  const raw = String(html || '');
  const issues: ContentIssue[] = [];
  const bytes = new TextEncoder().encode(raw).length;
  const text = stripTags(raw);
  const extScripts = externalScripts(raw);
  const refs = localReferences(raw);

  const add = (level: IssueLevel, code: string, message: string) => issues.push({ level, code, message });

  if (!raw.trim()) add('error', 'empty', 'The file is empty.');
  else if (text.length < 30 && count(raw, /<(input|button|canvas|textarea|select)\b/gi) === 0) {
    add('error', 'no-content', 'There is almost no readable content (under 30 characters of text).');
  }

  if (bytes > MAX_BYTES) add('warn', 'too-large', `The file is ${(bytes / 1024).toFixed(0)} KB; pages over 640 KB load slowly on phones.`);

  if (kind === 'tool') {
    if (!/<html[\s>]/i.test(raw)) add('error', 'no-html-tag', 'A tool must be a full HTML document (missing <html>).');
    if (!/<head[\s>]/i.test(raw)) add('warn', 'no-head', 'No <head> section, so SEO tags cannot be inserted.');
  }
  if (kind === 'blog' && !/<html[\s>]/i.test(raw) && /<h1[\s>]/i.test(raw) === false) {
    add('warn', 'no-heading', 'No <h1> found — the article has no main heading.');
  }

  const openScripts = count(raw, /<script\b/gi);
  const closeScripts = count(raw, /<\/script>/gi);
  if (openScripts !== closeScripts) {
    add('error', 'script-mismatch', `${openScripts} <script> tags but ${closeScripts} closing tags — the page will break.`);
  }
  const openStyle = count(raw, /<style\b/gi);
  const closeStyle = count(raw, /<\/style>/gi);
  if (openStyle !== closeStyle) {
    add('error', 'style-mismatch', `${openStyle} <style> tags but ${closeStyle} closing tags — the styling will break.`);
  }
  if (count(raw, /<html[\s>]/gi) > 1) add('warn', 'nested-html', 'More than one <html> tag — the browser will ignore the extras.');

  const idList = Array.from(raw.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)).map((m) => m[1]);
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of idList) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  if (dupes.size) add('warn', 'duplicate-ids', `Duplicate element ids: ${Array.from(dupes).slice(0, 5).join(', ')}`);

  if (/document\.write\s*\(/i.test(raw)) add('warn', 'document-write', 'Uses document.write(), which can wipe the page after load.');
  if (/<base\b/i.test(raw)) add('warn', 'base-tag', 'Contains a <base> tag, which can break relative links.');

  for (const img of raw.matchAll(/<img\b[^>]*>/gi)) {
    if (!/\ssrc\s*=/i.test(img[0])) add('warn', 'img-no-src', 'An <img> tag has no src attribute.');
  }

  if (extScripts.length) {
    add('warn', 'external-script', `Loads ${extScripts.length} external script(s) (${extScripts.slice(0, 3).join(', ')}). The site rule is: no CDN libraries.`);
  }
  if (/\son(click|error|load)\s*=\s*["'][^"']*eval\s*\(/i.test(raw)) {
    add('warn', 'eval', 'Uses eval() inside an attribute.');
  }

  if (kind === 'page' && /<script[^>]+src=["']\/app\.js/i.test(raw) === false) {
    add('info', 'no-app', 'This page does not load /app.js, so the studio views will not work on it.');
  }

  const errors = issues.filter((i) => i.level === 'error').length;
  return {
    ok: errors === 0,
    kind,
    bytes,
    stats: {
      scripts: openScripts,
      inlineScripts: Math.max(0, openScripts - extScripts.length),
      externalScripts: extScripts,
      styles: openStyle,
      images: count(raw, /<img\b/gi),
      links: count(raw, /<a\b/gi),
      forms: count(raw, /<form\b/gi),
      iframes: count(raw, /<iframe\b/gi),
    },
    localRefs: refs,
    fingerprint: fingerprint(raw),
    issues,
  };
}

/**
 * Compare a new upload with the version that is already stored, so an update can
 * never quietly throw away most of the live content.
 */
export function compareVersions(beforeHtml: string, afterHtml: string): ContentIssue[] {
  const before = fingerprint(String(beforeHtml || ''));
  const after = fingerprint(String(afterHtml || ''));
  const issues: ContentIssue[] = [];
  const add = (level: IssueLevel, code: string, message: string) => issues.push({ level, code, message });

  if (before.textLength >= 400 && after.textLength < before.textLength * 0.6) {
    add('error', 'content-shrunk',
      `Readable text dropped from ${before.textLength} to ${after.textLength} characters — most of the page would be lost.`);
  } else if (before.textLength >= 200 && after.textLength < before.textLength * 0.85) {
    add('warn', 'content-smaller',
      `Readable text dropped from ${before.textLength} to ${after.textLength} characters.`);
  }

  const beforeIds = new Set(before.ids);
  const afterIds = new Set(after.ids);
  const lostIds = [...beforeIds].filter((id) => !afterIds.has(id));
  if (beforeIds.size >= 3 && lostIds.length > beforeIds.size * 0.3) {
    add('error', 'ids-lost',
      `${lostIds.length} of ${beforeIds.size} element ids disappeared (e.g. ${lostIds.slice(0, 4).join(', ')}) — scripts that target them will fail.`);
  }

  const lostHeadings = before.headings.filter((h) => !after.headings.includes(h));
  if (before.headings.length >= 3 && lostHeadings.length > before.headings.length * 0.4) {
    add('warn', 'headings-lost', `${lostHeadings.length} headings were removed (e.g. "${lostHeadings.slice(0, 2).join('", "')}").`);
  }

  if (before.forms > 0 && after.forms === 0) add('warn', 'forms-lost', 'The previous version had a form; the new one has none.');
  if (before.images > 0 && after.images === 0) add('warn', 'images-lost', 'All images were removed.');
  if (before.scripts > 0 && after.scripts === 0) add('warn', 'scripts-lost', 'All scripts were removed, so interactive parts may stop working.');
  if (before.title && after.title && before.title !== after.title) {
    add('info', 'title-changed', `Title changed from "${before.title}" to "${after.title}".`);
  }
  if (!before.title && after.title) add('info', 'title-added', `Title set to "${after.title}".`);

  return issues;
}

export function mergeIssues(a: ContentIssue[], b: ContentIssue[]): ContentIssue[] {
  const order: Record<IssueLevel, number> = { error: 0, warn: 1, info: 2 };
  const all = [...a, ...b];
  const keyed = new Map<string, ContentIssue>();
  for (const issue of all) keyed.set(issue.code + '|' + issue.message, issue);
  return Array.from(keyed.values()).sort((x, y) => order[x.level] - order[y.level]);
}
