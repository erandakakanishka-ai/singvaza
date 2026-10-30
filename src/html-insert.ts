/* Where to insert a tag, in HTML that may contain scripts.
 *
 * A plain `html.replace(/<\/body>/i, ...)` is wrong: a page can contain the text
 * "</body>" inside a <script> (the studio tools build printable documents as
 * strings). Inserting there splits the string and the rest of the script ends up
 * printed as page text — which is exactly the bug this file exists to prevent.
 *
 * So the last REAL </body> is found by walking the document and skipping
 * <script>, <style>, comments and the other raw-text elements. */

const RAW_TEXT_ELEMENTS = ['script', 'style', 'textarea', 'title', 'noscript', 'template', 'xmp'];

/** The index of the last real `</body` (the start of the tag), or -1 when the page
 *  has no closing body at all. */
export function findBodyClose(html: string): number {
  const lower = html.toLowerCase();
  let i = 0;
  let last = -1;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    // Comments and doctype/CDATA are skipped whole.
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    if (html.startsWith('<![', lt) || html.startsWith('<!', lt)) {
      const end = html.indexOf('>', lt);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    // A raw-text element is skipped to its own closing tag.
    let skipped = false;
    for (const tag of RAW_TEXT_ELEMENTS) {
      if (lower.startsWith('<' + tag, lt)) {
        const close = lower.indexOf('</' + tag, lt);
        if (close === -1) { i = html.length; skipped = true; break; }
        const closeEnd = html.indexOf('>', close);
        i = closeEnd === -1 ? html.length : closeEnd + 1;
        skipped = true;
        break;
      }
    }
    if (skipped) continue;
    if (lower.startsWith('</body', lt)) {
      const end = html.indexOf('>', lt);
      if (end === -1) break;
      // Keep the START of the tag: "</body >" must stay as it is.
      last = lt;
    }
    const gt = html.indexOf('>', lt);
    i = gt === -1 ? html.length : gt + 1;
  }
  return last;
}

/** Insert `snippet` just before the last real `</body>`. If the page has none,
 *  the snippet is appended — never inside a script. */
export function insertBeforeBodyClose(html: string, snippet: string): string {
  const at = findBodyClose(html);
  if (at === -1) return html + snippet;
  return html.slice(0, at) + snippet + html.slice(at);
}
