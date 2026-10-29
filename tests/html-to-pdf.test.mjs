import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../public/studio/html-to-pdf.html', import.meta.url), 'utf8');
const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('the HTML to PDF tool offers every page format the user asked for', () => {
  for (const paper of ['a4', 'a5', 'letter', 'legal', 'a3']) {
    assert.ok(page.includes(`value="${paper}"`), `missing paper size ${paper.toUpperCase()}`);
  }
  assert.ok(page.includes('id="oriPortrait"') && page.includes('id="oriLand"'), 'portrait and landscape switches');
  assert.ok(page.includes('id="modePrint"') && page.includes('id="modePdf"'), 'printable and plain PDF modes');
  assert.ok(page.includes('id="optPageNumbers"'), 'page numbers option');
});

test('the PDF is written in the browser, not uploaded', () => {
  assert.ok(page.includes('function wrapPdf('), 'the PDF writer must be local');
  assert.ok(page.includes("'%PDF-1.4"), 'it writes real PDF bytes');
  assert.ok(!/action="[^"]*upload/i.test(page), 'no upload form');
  assert.ok(page.includes('canvasToPdfImage'), 'pages are rasterised on the device');
});

test('page breaks are planned from the layout instead of cutting through lines', () => {
  assert.ok(page.includes('function layoutPages('), 'pagination must be planned');
  assert.ok(page.includes('preRange'), 'long code blocks split at line boundaries');
  assert.ok(page.includes('plan[pi]'), 'each page draws its own slice');
});

test('the homepage links to the new tool', () => {
  assert.ok(index.includes('href="/studio/html-to-pdf.html"'), 'tool card link');
});
