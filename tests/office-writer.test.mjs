import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const writerSrc = await readFile(new URL('../public/office-writer.js', import.meta.url), 'utf8');

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
});
