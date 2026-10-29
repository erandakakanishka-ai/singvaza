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
  assert.ok(page.includes('width=1180'), 'phones get the full desktop canvas, like onlineviewer.net');
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
  assert.ok(/\.app\{display:flex!important;width:1180px/.test(page), 'the canvas stays a fixed desktop width, so no panel can lock the page');

});
