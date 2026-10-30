import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const writerSrc = await readFile(new URL('../public/office-writer.js', import.meta.url), 'utf8');
const tourSrc = await readFile(new URL('../public/tour.js', import.meta.url), 'utf8');

/* The writer needs a DOM to walk, so the full conversion runs in the browser
 * suite. Here we check the contract: real OOXML parts, a correct local ZIP and
 * absolutely no network. */
test('the office writer builds real docx / xlsx / pptx parts', () => {
  for (const marker of [
    'word/document.xml',
    'xl/workbook.xml',
    'ppt/presentation.xml',
    '[Content_Types].xml',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]) {
    assert.ok(writerSrc.includes(marker), 'missing ' + marker);
  }
  assert.ok(writerSrc.includes('w:sectPr'), 'docx page setup'); 
  assert.ok(writerSrc.includes('pgSz'), 'paper size reaches Word');
  assert.ok(writerSrc.includes("'Heading'"), 'docx heading styles');
  assert.ok(writerSrc.includes('crc32'), 'writes ZIP checksums');
  assert.ok(writerSrc.includes('0x02014b50'), 'writes a ZIP central directory');
});

test('the office writer never uploads and needs no library', () => {
  assert.ok(!/fetch\(|XMLHttpRequest|FormData|WebSocket|importScripts/.test(writerSrc), 'nothing may leave the device');
  assert.ok(!/<script src=|<link rel="stylesheet"/.test(writerSrc), 'no external assets');
  assert.ok(!/\brequire\(['"][a-z]/.test(writerSrc), 'the writer is standalone');
});

test('the guided tour is shared, remembers itself and needs no network', () => {
  assert.ok(tourSrc.includes('SingVazaTour'), 'exposes a module');
  assert.ok(tourSrc.includes('localStorage'), 'remembers that the tour was seen');
  assert.ok(tourSrc.includes('#tourSpot') && tourSrc.includes('#tourArrow'), 'spotlight plus a walking arrow');
  assert.ok(!/fetch\(|XMLHttpRequest/.test(tourSrc), 'no network');
  assert.ok(tourSrc.includes('scrollIntoView'), 'slides a wide panel into view on a phone');
});

test('the tour never dims the tool on a phone by itself', () => {
  assert.ok(tourSrc.includes('roomForTour'), 'a screen-size check guards the auto-open');
  assert.ok(/realW\s*>=\s*900/.test(tourSrc), 'only a wide screen opens it unasked');
  assert.ok(tourSrc.includes('screen.width'), 'the declared width=1180 must not fake a desktop');
  assert.ok(!/rgba\(6,6,6,\.74\)/.test(tourSrc), 'the dim is lighter, so the tool stays readable');
});

test('every format the UI offers is implemented', () => {
  for (const kind of ['docx', 'xlsx', 'pptx']) {
    assert.ok(writerSrc.includes("kind === '" + kind + "'"), 'missing ' + kind + ' branch');
  }
});

test('the HTML to PDF page exposes the Office downloads', async () => {
  const page = await readFile(new URL('../public/studio/html-to-pdf.html', import.meta.url), 'utf8');
  for (const id of ['btnDocx', 'btnXlsx', 'btnPptx', 'btnPdf', 'btnPrintDoc', 'btnHtml']) {
    assert.ok(page.includes('id="' + id + '"'), 'missing button ' + id);
  }
  assert.ok(page.includes('/office-writer.js'), 'the writer is loaded');
  // the old fixed 1180px canvas shrank the whole tool on a phone and cut the
  // buttons in half; a phone now gets its own one-part-at-a-time layout
  assert.ok(page.includes('name="viewport" content="width=device-width'), 'the phone decides the scale');
  assert.ok(!page.includes('width=1180'), 'no forced desktop canvas on a phone');
  for (const id of ['railEditor', 'railPreview', 'railTools', 'dragEditor', 'dragTools']) {
    assert.ok(page.includes('id="' + id + '"'), 'missing drag/rail control ' + id);
  }
  assert.ok(page.includes('bindDrag'), 'panels can be dragged away');
  assert.ok(page.includes('collapse('), 'a dragged-away panel collapses to a slim rail');
  assert.ok(!/#38bdf8|#0b1020|#1a2236/.test(page), 'the glowing blue palette is gone');
  assert.ok((page.match(/class="homebig/g) || []).length >= 2, 'big Home buttons on the tools panel');
  for (const id of ['btnToggleCode', 'btnToggleTools', 'btnHideCode']) {
    assert.ok(page.includes('id="' + id + '"'), 'one-tap panel toggle ' + id);
  }
  assert.ok(page.includes('/tour.js'), 'the shared guided tour is loaded');
  assert.ok(/@media \(max-width:820px\)/.test(page) && /flex-wrap:wrap/.test(page), 'on a phone the parts stack and the page scrolls, so nothing is locked out of reach');

});
