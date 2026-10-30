import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

/* The bug this pins: a page whose <script> builds a printable document as a string
 * contains the text "</body>" — inserting a tag with a plain replace put the tag in
 * the middle of that string, and the rest of the script was printed on the page.
 * The studio tools (Word/Excel → PDF, HTML → PDF) do exactly this. */

async function load(entry) {
  const out = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

const { insertBeforeBodyClose, findBodyClose } = await load('src/html-insert.ts');
const TAG = '<script src="/holiday.js" defer></script>';

test('a plain page gets the tag right before the real </body>', () => {
  const page = '<html><body><h1>hi</h1></body></html>';
  assert.equal(insertBeforeBodyClose(page, TAG), '<html><body><h1>hi</h1>' + TAG + '</body></html>');
});

test('a </body> inside a script is left alone', () => {
  const page = `<html><body><h1>hi</h1><script>var s='</body></html>';</script><p>end</p></body></html>`;
  const out = insertBeforeBodyClose(page, TAG);
  assert.ok(out.includes(`var s='</body></html>';`), 'the script string is untouched');
  assert.ok(out.indexOf(TAG) > out.indexOf('</script>'), 'the tag comes after the script');
  assert.ok(out.endsWith(TAG + '</body></html>'), 'and before the real close');
});

test('the studio tools are handled: their printable document strings stay intact', async () => {
  for (const file of ['../public/studio/office-to-pdf.html', '../public/studio/html-to-pdf.html']) {
    const html = await readFile(new URL(file, import.meta.url), 'utf8');
    const out = insertBeforeBodyClose(html, TAG);
    assert.equal(out.split(TAG).length - 1, 1, `${file}: exactly one tag`);
    assert.ok(out.trimEnd().endsWith('</body>\n</html>') || out.includes(TAG + '</body>'), `${file}: tag at the end`);
    // every occurrence of the string form is still inside a <script>
    const before = html.split("'</body></html>'").length - 1;
    const after = out.split("'</body></html>'").length - 1;
    assert.equal(after, before, `${file}: no script string was split`);
  }
});

test('an upper-case or spaced close tag is fine', () => {
  assert.ok(insertBeforeBodyClose('<html><BODY><p>x</p></BODY></HTML>', TAG).includes(TAG + '</BODY>'));
  assert.ok(insertBeforeBodyClose('<html><body><p>x</p></body ></html>', TAG).includes(TAG + '</body >'));
});

test('a page with no body close gets the tag appended, never inside a script', () => {
  const page = '<div>fragment</div><script>var x = "</body>";</script>';
  const out = insertBeforeBodyClose(page, TAG);
  assert.ok(out.endsWith(TAG), 'appended at the very end');
  assert.ok(out.includes('var x = "</body>";'), 'the script is untouched');
});

test('the last real close wins when there are several', () => {
  const page = '<html><body><p>a</p></body><template><p>b</p></template></body></html>';
  const at = findBodyClose(page);
  assert.equal(page.slice(at, at + 7).toLowerCase(), '</body>');
  // the chosen close must be the outer one, i.e. after the template
  assert.ok(page.slice(0, at).includes('<template>'));
});

test('an unterminated script gets the tag appended, not injected into the code', () => {
  const page = '<html><body><p>x</p><script>var a = 1;';
  const out = insertBeforeBodyClose(page, TAG);
  // No closing body exists outside the script, so the safe answer is to append.
  assert.ok(out.endsWith(TAG), 'appended at the end');
  assert.ok(out.startsWith(page), 'the page is untouched');
});

test('the greeting bar is still inserted after <body>, never over the page', async () => {
  const occasions = await readFile(new URL('../src/occasions.ts', import.meta.url), 'utf8');
  assert.ok(occasions.includes("const match = /<body[^>]*>/i.exec(html)"), 'the opening tag is used');
  assert.match(occasions, /html\.slice\(0, at\) \+ banner \+ html\.slice\(at\)/, 'insertion only');
});
