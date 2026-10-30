import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../public/studio/html-to-pdf.html', import.meta.url), 'utf8');
const engineSrc = await readFile(new URL('../public/pdf-engine.js', import.meta.url), 'utf8');
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
  assert.ok(engineSrc.includes('function wrapPdf('), 'the PDF writer must be local');
  assert.ok(engineSrc.includes("'%PDF-1.4"), 'it writes real PDF bytes');
  assert.ok(!/action="[^"]*upload/i.test(page), 'no upload form');
  assert.ok(engineSrc.includes('canvasToPdfImage'), 'pages are rasterised on the device');
  assert.ok(!/fetch\(|XMLHttpRequest|FormData/.test(engineSrc), 'the engine must never send the document anywhere');
});

test('page breaks are planned from the layout instead of cutting through lines', () => {
  assert.ok(engineSrc.includes('function layoutPages('), 'pagination must be planned');
  assert.ok(engineSrc.includes('preRange'), 'long code blocks split at line boundaries');
  assert.ok(engineSrc.includes('plan[pi]'), 'each page draws its own slice');
});

test('the homepage links to the new tool', () => {
  assert.ok(index.includes('href="/studio/html-to-pdf.html"'), 'tool card link');
});

test('the shared PDF engine is used by both document tools', async () => {
  const engine = await readFile(new URL('../public/pdf-engine.js', import.meta.url), 'utf8');
  const office = await readFile(new URL('../public/studio/office-to-pdf.html', import.meta.url), 'utf8');
  assert.ok(engine.includes('global.SingVazaPDF'), 'the engine must be exported for reuse');
  assert.ok(page.includes('/pdf-engine.js'), 'the HTML tool loads the engine');
  assert.ok(office.includes('/pdf-engine.js'), 'the Office tool loads the same engine');
  assert.ok(engine.includes('function buildPdf('), 'page building lives in the engine');
  assert.ok(!office.includes('function wrapPdf('), 'the Office tool must not fork the PDF writer');
});

test('Office files are read in the browser, including the ZIP container', async () => {
  const reader = await readFile(new URL('../public/office-reader.js', import.meta.url), 'utf8');
  assert.ok(reader.includes('DecompressionStream'), 'the ZIP is inflated with the built-in API');
  assert.ok(reader.includes('word/document.xml'), 'docx support');
  assert.ok(reader.includes('xl/workbook.xml'), 'xlsx support');
  assert.ok(/ppt\\\/slides\\\/slide/.test(reader), 'pptx support');
  assert.ok(!/fetch\(|XMLHttpRequest|FormData/.test(reader), 'no upload path may exist');
});

test('on a phone the preview fits the whole sheet, not just its width', () => {
  // the reported bug: at 390px the preview slot is tall and narrow, so fitting the
  // width alone cut the bottom of the A4 page off in the preview
  assert.match(page, /function fitZoom\(\)/, 'there is a fit function');
  assert.match(page, /byHeight/, 'it measures the height too');
  assert.match(page, /realW < 900/, 'the phone path is explicit');
  assert.match(page, /#previewBox\{height:70vh/, 'the preview slot gets the height of a phone screen and a half');
});
