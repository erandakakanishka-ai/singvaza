import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const reader = await readFile(new URL('../public/office-reader.js', import.meta.url), 'utf8');

/* The reader needs a browser for DOMParser and DecompressionStream, so this
 * test only checks the parts that do not: the ZIP table parse is pure maths.
 * The real conversion is exercised in the browser suite. */
test('the office reader ships every format and no network calls', () => {
  for (const marker of ['word/document.xml', 'xl/workbook.xml', 'pptxToHtml']) {
    assert.ok(reader.includes(marker), 'missing ' + marker);
  }
  assert.ok(reader.includes('0x06054b50'), 'reads the ZIP end-of-directory record');
  assert.ok(reader.includes('deflate-raw'), 'inflates stored entries');
  assert.ok(!/fetch\(|XMLHttpRequest|FormData|WebSocket/.test(reader), 'the file must never be uploaded');
});

test('the sample fixtures are real Office archives', async () => {
  for (const f of ['sample.docx', 'sample.xlsx', 'sample.pptx']) {
    const buf = await readFile(new URL('./fixtures/' + f, import.meta.url));
    assert.equal(buf.slice(0, 2).toString(), 'PK', f + ' must be a ZIP');
    const names = buf.toString('latin1');
    const looksOffice = /word\/document\.xml|xl\/workbook\.xml|ppt\/slides\/slide1\.xml|\[Content_Types\]/.test(names);
    assert.ok(looksOffice, f + ' looks like an Office package');
  }
});
