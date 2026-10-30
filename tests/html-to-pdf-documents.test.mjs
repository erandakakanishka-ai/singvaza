import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

/* What the operator hit with a real letter: a whole HTML file (doctype, <head>,
 * <style>, one ".sheet" wrapper) came out with the markup tags printed as text,
 * the CSS visible as a wall of code, every paragraph run together and the whole
 * letter squeezed onto the first page. */

const engineSrc = await readFile(new URL('../public/pdf-engine.js', import.meta.url), 'utf8');
const win = { document: { createElement: () => ({ style: {} }) } };
win.window = win;
vm.createContext(win);
vm.runInContext(engineSrc, win);
const E = win.SingVazaPDF;

const LETTER = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Letter (A4)</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<style>
@page { size: A4; margin: 0; }
:root { --ink: #1d2730; --teal: #0e5a5a; }
body { margin: 0; padding: 14px 0; }
.sheet { width: 210mm; margin: 0 auto; font-family: "Source Serif 4", Georgia, serif; }
h1 { color: var(--teal); }
</style>
</head>
<body>
<div class="sheet">
  <h1>Your Name</h1>
  <p>Dear Sir / Madam,</p>
  <p>I am writing regarding the job.</p>
</div>
</body>
</html>`;

test('a whole HTML file is recognised as a document, a snippet is not', () => {
  assert.equal(E.isFullDocument(LETTER), true);
  assert.equal(E.isFullDocument('<h1>Hi</h1><p>hello</p>'), false);
  assert.equal(E.isFullDocument('<p>just text</p>'), false);
});

test('only the body is printed — never the head, the CSS or the tags', () => {
  const body = E.bodyOf(LETTER);
  assert.match(body, /Your Name/, 'the content survives');
  assert.match(body, /Dear Sir \/ Madam/, 'paragraphs survive');
  for (const junk of ['<!DOCTYPE', '<html', '<head', '<style', 'font-family', '@page', '<title']) {
    assert.ok(!body.toLowerCase().includes(junk.toLowerCase()), `"${junk}" must not be printed`);
  }
});

test('an unclosed <style> block is cut out too', () => {
  const messy = '<!doctype html><html><head><title>x</title><style>\nbody{color:red}\n</head>\n<body><p>Only this</p></body></html>';
  const body = E.bodyOf(messy);
  assert.match(body, /Only this/);
  assert.ok(!/color:red/.test(body), 'the CSS does not leak into the page');
});

test("the document's own font stays first, so a letter keeps its typeface", () => {
  const fonts = E.documentCss(LETTER);
  assert.ok(fonts.length >= 1, 'the pasted stylesheet is read');
  assert.match(fonts[0], /Source Serif 4/, 'the letter font is kept');
  assert.match(fonts[0], /Georgia/, 'with its fallbacks');
});

test('page layout can see paragraphs inside a wrapper', () => {
  // flattenBlocks works on a real DOM; its contract is pinned here on the source,
  // because the page-plan walks only the top-level children of the document.
  assert.match(engineSrc, /function flattenBlocks\(root\)/);
  assert.match(engineSrc, /flattenBlocks\(clone\)/, 'it runs before the page plan is made');
  assert.match(engineSrc, /while \(el\.firstChild\) parent\.insertBefore\(el\.firstChild, el\)/, 'wrappers are replaced by their children');
});

test("a pasted page's CSS never reaches the tool, so the tool cannot go dark", () => {
  // the reported bug: importing a file recoloured the editor — the file's own
  // :root/body rules replaced the tool palette (--ink), so labels printed in near
  // black on a near-black panel
  const paste = '<style>:root{--ink:#1d2730}body{background:#e6eaed}</style><p>Hello</p>';
  const clean = E.sanitizeHtml(paste);
  assert.ok(!/<style/i.test(clean), 'the style block is dropped');
  assert.ok(!/--ink/.test(clean), 'its colours cannot leak');
  assert.match(clean, /Hello/, 'the content stays');
  assert.ok(!/<link/i.test(E.sanitizeHtml('<link rel="stylesheet" href="x.css"><p>ok</p>')), 'no external stylesheet either');
  // the tool's own colours are still applied to the printed page
  assert.match(E.bodyCss({ fontFamily: () => ({ value: 'sans' }), fontSize: () => ({ value: '11' }), lineHeight: () => ({ value: '1.55' }), margin: () => ({ value: '18' }), mode: () => 'pdf' }, false), /color:#111/);
});
