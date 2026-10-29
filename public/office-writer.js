/*!
 * SingVaza office-writer — HTML in, real .docx / .xlsx / .pptx bytes out.
 * Pure browser JavaScript: no libraries, no network, no upload. Everything is
 * zipped on the device with a stored (uncompressed) ZIP writer, which every
 * Microsoft Office, LibreOffice and Google Docs reader accepts.
 *
 *   window.SingVazaOfficeWrite.write('docx'|'xlsx'|'pptx', { title, html, paper, ori, footer })
 *     -> Promise<Blob>
 */
(function (root) {
  'use strict';

  /* ---------------- tiny DOM helpers (work with a detached <div>) ---------------- */
  var TEXT_TAGS = { P: 1, DIV: 1, LI: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, BLOCKQUOTE: 1, PRE: 1, TD: 1, TH: 1, FIGCAPTION: 1, DD: 1, DT: 1 };
  var BLOCK_TAGS = { P: 1, DIV: 1, LI: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, BLOCKQUOTE: 1, PRE: 1, TABLE: 1, UL: 1, OL: 1, HR: 1, FIGURE: 1 };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function normSpace(s) { return String(s || '').replace(/\u00a0/g, ' ').replace(/[ \t\r\n]+/g, ' '); }

  function isBlockish(el) {
    if (el.nodeType !== 1) return false;
    return !!BLOCK_TAGS[el.tagName];
  }
  /* Walk a subtree and return [{text, b, i, u, s, code, link, br}] runs, one array per block. */
  function collectBlocks(node, inherited) {
    inherited = inherited || {};
    var blocks = [], current = [];
    function pushRun(run) {
      if (!run.text) return;
      current.push(run);
    }
    function flush() {
      if (!current.length) return;
      // trim empty runs at both ends
      blocks.push(current);
      current = [];
    }
    function walk(n, st) {
      if (n.nodeType === 3) {
        var t = normSpace(n.nodeValue);
        if (!t || !t.trim()) { if (t && current.length) pushRun(mix({ text: ' ' }, st)); return; }
        pushRun(mix({ text: t }, st));
        return;
      }
      if (n.nodeType !== 1) return;
      var tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      if (tag === 'BR') { pushRun(mix({ text: '\n', br: true }, st)); return; }
      if (tag === 'IMG') {
        var alt = n.getAttribute('alt');
        if (alt) pushRun(mix({ text: '[' + alt + ']' }, st));
        return;
      }
      if (tag === 'HR') { flush(); blocks.push([{ text: '\u2014\u2014\u2014', b: false, i: false, u: false, s: false }]); return; }
      if (tag === 'TABLE') { flush(); collectTable(n, st, blocks); return; }
      if (tag === 'UL' || tag === 'OL') { flush(); collectList(n, st, blocks); return; }
      if (isBlockish(n) && tag !== 'TD' && tag !== 'TH') {
        var before = current.length;
        walkChildren(n, nextState(tag, n, st));
        if (current.length > before) flush();
        else if (tag === 'P' || tag === 'DIV') { /* stay silent for empty block */ }
        return;
      }
      walkChildren(n, nextState(tag, n, st));
    }
    function walkChildren(n, st) {
      for (var i = 0; i < n.childNodes.length; i++) walk(n.childNodes[i], st);
    }
    function nextState(tag, n, st) {
      var s = { b: st.b, i: st.i, u: st.u, s: st.s, code: st.code, link: st.link, heading: st.heading, quote: st.quote, style: st.style };
      if (tag === 'STRONG' || tag === 'B') s.b = true;
      if (tag === 'EM' || tag === 'I') s.i = true;
      if (tag === 'U' || tag === 'INS') s.u = true;
      if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') s.s = true;
      if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') s.code = true;
      if (tag === 'PRE') s.code = true;
      if (tag === 'A') s.link = n.getAttribute('href') || '';
      if (/^H[1-6]$/.test(tag)) s.heading = Number(tag.charAt(1));
      if (tag === 'BLOCKQUOTE') s.quote = true;
      if (tag === 'LI') s.li = true;
      if (n.className && /(^|\s)(center|text-center)(\s|$)/.test(String(n.className))) s.style = 'center';
      return s;
    }
    function mix(run, st) {
      return {
        text: run.text, br: run.br || false,
        b: !!st.b, i: !!st.i, u: !!st.u, s: !!st.s, code: !!st.code,
        link: st.link || '', heading: st.heading || 0, quote: !!st.quote, align: st.style || ''
      };
    }
    function collectList(listEl, st, blocks) {
      var ordered = listEl.tagName === 'OL', n = 1;
      var items = listEl.children;
      for (var i = 0; i < items.length; i++) {
        var li = items[i];
        if (li.tagName !== 'LI') continue;
        var saved = current; current = [];
        var marker = ordered ? (n++) + '. ' : '\u2022 ';
        current.push({ text: marker, b: false, i: false, u: false, s: false, li: true, level: 1 });
        for (var k = 0; k < li.childNodes.length; k++) walk(li.childNodes[k], st);
        if (current.length <= 1) current.push({ text: normSpace(li.textContent).trim(), b: false, i: false, u: false, s: false, li: true, level: 1 });
        if (current.length) blocks.push(current);
        current = saved;
      }
    }
    function collectTable(tableEl, st, blocks) {
      var rows = tableEl.querySelectorAll('tr');
      var grid = [];
      for (var r = 0; r < rows.length; r++) {
        var cells = rows[r].children, line = [];
        for (var c = 0; c < cells.length; c++) {
          var cell = cells[c];
          if (cell.tagName !== 'TD' && cell.tagName !== 'TH') continue;
          var txt = normSpace(cell.textContent).trim();
          line.push({ text: txt, head: cell.tagName === 'TH' || !!(rows[r].parentNode && rows[r].parentNode.tagName === 'THEAD') });
        }
        if (line.length) grid.push(line);
      }
      if (grid.length) blocks.push({ table: grid });
    }
    walkChildren(node, inherited);
    flush();
    return blocks;
  }

  /* ---------------- DOCX ---------------- */
  function docxRun(r) {
    var props = '';
    if (r.b) props += '<w:b/>';
    if (r.i) props += '<w:i/>';
    if (r.u) props += '<w:u w:val="single"/>';
    if (r.s) props += '<w:strike/>';
    if (r.code) props += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:fill="F2F4F9"/>';
    if (r.heading) props += '<w:color w:val="111827"/>';
    if (r.link) props += '<w:color w:val="0B61C4"/><w:u w:val="single"/>';
    var body = String(r.text).split('\n').map(function (line, i) {
      return (i ? '<w:br/>' : '') + '<w:t xml:space="preserve">' + esc(line) + '</w:t>';
    }).join('');
    return '<w:r>' + (props ? '<w:rPr>' + props + '</w:rPr>' : '') + body + '</w:r>';
  }
  function docxParagraph(runs, opts) {
    opts = opts || {};
    var pPr = '';
    var style = opts.heading ? 'Heading' + opts.heading : (opts.quote ? 'Quote' : (opts.list ? 'ListParagraph' : ''));
    if (style) pPr += '<w:pStyle w:val="' + style + '"/>';
    if (opts.list) pPr += '<w:ind w:left="360" w:hanging="200"/>';
    if (opts.align === 'center') pPr += '<w:jc w:val="center"/>';
    if (opts.spacingAfter != null) pPr += '<w:spacing w:after="' + opts.spacingAfter + '"/>';
    return '<w:p>' + (pPr ? '<w:pPr>' + pPr + '</w:pPr>' : '') + runs.map(docxRun).join('') + '</w:p>';
  }
  function docxTable(grid) {
    var cols = 0;
    grid.forEach(function (row) { cols = Math.max(cols, row.length); });
    if (!cols) return '';
    var width = Math.floor(9360 / cols);
    var xml = '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>'
      + '<w:tblBorders>'
      + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (side) {
        return '<w:' + side + ' w:val="single" w:sz="6" w:space="0" w:color="CFD8E6"/>';
      }).join('')
      + '</w:tblBorders></w:tblPr><w:tblGrid>';
    for (var c = 0; c < cols; c++) xml += '<w:gridCol w:w="' + width + '"/>';
    xml += '</w:tblGrid>';
    grid.forEach(function (row) {
      xml += '<w:tr>';
      for (var i = 0; i < cols; i++) {
        var cell = row[i] || { text: '', head: false };
        var shade = cell.head ? '<w:shd w:val="clear" w:fill="F1F5FB"/>' : '';
        xml += '<w:tc><w:tcPr><w:tcW w:w="' + width + '" w:type="dxa"/>' + shade + '</w:tcPr>'
          + docxParagraph([{ text: cell.text, b: !!cell.head }]) + '</w:tc>';
      }
      xml += '</w:tr>';
    });
    return xml + '</w:tbl>';
  }
  function docxBody(blocks) {
    var xml = '';
    blocks.forEach(function (b) {
      if (b.table) { xml += docxTable(b.table); return; }
      var first = b[0] || {};
      var isList = b.some(function (r) { return r.li; });
      xml += docxParagraph(b.map(function (r) {
        return { text: r.text, b: r.b, i: r.i, u: r.u, s: r.s, code: r.code, link: r.link, heading: r.heading };
      }), { heading: first.heading, quote: first.quote, list: isList, align: first.align || '' });
    });
    return xml;
  }

  var DOCX_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Iskoola Pota"/><w:sz w:sz="22"/><w:szCs w:sz="22"/></w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    + [[1, 32], [2, 28], [3, 24], [4, 22], [5, 21], [6, 20]].map(function (h) {
      return '<w:style w:type="paragraph" w:styleId="Heading' + h[0] + '"><w:name w:val="heading ' + h[0] + '"/>'
        + '<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="' + (h[0] - 1) + '"/></w:pPr>'
        + '<w:rPr><w:b/><w:sz w:val="' + h[1] + '"/><w:szCs w:val="' + h[1] + '"/></w:rPr></w:style>';
    }).join('')
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>'
    + '<w:pPr><w:ind w:left="480"/></w:pPr><w:rPr><w:i/><w:color w:val="41506A"/></w:rPr></w:style>'
    + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>'
    + '<w:tblPr><w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (s) {
      return '<w:' + s + ' w:val="single" w:sz="6" w:space="0" w:color="CFD8E6"/>';
    }).join('') + '</w:tblBorders></w:tblPr></w:style>'
    + '</w:styles>';

  function docxDocument(blocks, o) {
    var page = pageTwips(o);
    var footer = '';
    if (o.footer) {
      footer = '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="16"/><w:color w:val="7A879E"/></w:rPr><w:t xml:space="preserve">'
        + esc(o.footer) + '</w:t></w:r></w:p>';
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<w:body>' + docxBody(blocks)
      + '<w:sectPr>' + (footer ? '<w:footerReference w:type="default" r:id="rIdFooter1"/>' : '')
      + '<w:pgSz w:w="' + page.w + '" w:h="' + page.h + '"' + (o.ori === 'landscape' ? ' w:orient="landscape"' : '') + '/>'
      + '<w:pgMar w:top="' + page.m + '" w:right="' + page.m + '" w:bottom="' + page.m + '" w:left="' + page.m + '" w:header="720" w:footer="720" w:gutter="0"/>'
      + '</w:sectPr></w:body></w:document>';
  }
  function pageTwips(o) {
    var MM = 1440 / 25.4;
    var SIZES = { a4: [210, 297], a5: [148, 210], a3: [297, 420], letter: [215.9, 279.4], legal: [215.9, 355.6] };
    var s = SIZES[o.paper] || SIZES.a4;
    var w = Math.round((o.ori === 'landscape' ? s[1] : s[0]) * MM), h = Math.round((o.ori === 'landscape' ? s[0] : s[1]) * MM);
    return { w: w, h: h, m: Math.round((Number(o.margin) || 20) * MM) };
  }

  /* ---------------- XLSX ---------------- */
  function xlsxParts(blocks, o) {
    var rows = [], merges = [];
    blocks.forEach(function (b) {
      if (b.table) {
        b.table.forEach(function (row) {
          var r = row.map(function (cell) { return { v: cell.text, head: !!cell.head }; });
          // a blank spacer row between two tables keeps them readable
          if (rows.length && rows[rows.length - 1].some(function (c) { return c && c.v; })) rows.push([]);
          r.forEach(function (c, i) { c.col = i; });
          rows.push(r);
        });
        return;
      }
      var text = b.map(function (r) { return r.text; }).join('');
      var first = b[0] || {};
      if (!text.trim()) return;
      var row = [{ v: text.trim(), bold: !!(first.heading || first.b), heading: first.heading || 0 }];
      rows.push(row);
    });
    // widest table decides the column count
    var maxCols = 1;
    rows.forEach(function (r) { maxCols = Math.max(maxCols, r.length); });

    function colName(n) {
      var s = '';
      n += 1;
      while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
      return s;
    }
    var sheetRows = rows.map(function (row, ri) {
      var cells = row.map(function (c, ci) {
        var ref = colName(ci) + (ri + 1);
        if (!c || c.v === '') return '';
        var style = c.head ? '3' : c.heading === 1 ? '1' : c.heading === 2 ? '2' : c.bold ? '4' : '0';
        return '<c r="' + ref + '" t="inlineStr" s="' + style + '"><is><t xml:space="preserve">' + esc(c.v) + '</t></is></c>';
      }).join('');
      var height = row.length === 1 && row[0] && row[0].heading ? ' ht="26" customHeight="1"' : '';
      return '<row r="' + (ri + 1) + '"' + height + '>' + cells + '</row>';
    }).join('');

    var cols = '';
    for (var c = 0; c < maxCols; c++) cols += '<col min="' + (c + 1) + '" max="' + (c + 1) + '" width="' + (maxCols === 1 ? 90 : 24) + '" customWidth="1"/>';
    var title = o.title || 'Sheet1';
    var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><cols>' + cols + '</cols>'
      + '<sheetData>' + sheetRows + '</sheetData>'
      + '<printOptions horizontalCentered="0"/>'
      + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
      + '<pageSetup paperSize="' + paperCode(o.paper) + '" orientation="' + (o.ori === 'landscape' ? 'landscape' : 'portrait') + '" fitToWidth="1" fitToHeight="0"/>'
      + '</worksheet>';

    var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="6">'
      + '<font><sz val="11"/><name val="Calibri"/></font>'
      + '<font><b/><sz val="16"/><color rgb="FF111827"/><name val="Calibri"/></font>'
      + '<font><b/><sz val="13"/><color rgb="FF1F2937"/><name val="Calibri"/></font>'
      + '<font><b/><sz val="11"/><color rgb="FF1F2937"/><name val="Calibri"/></font>'
      + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
      + '<font><sz val="11"/><color rgb="FF111827"/><name val="Calibri"/></font>'
      + '</fonts>'
      + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
      + '<fill><patternFill patternType="solid"><fgColor rgb="FFEFF4FB"/><bgColor indexed="64"/></patternFill></fill></fills>'
      + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
      + '<border><left style="thin"><color rgb="FFB9C6DA"/></left><right style="thin"><color rgb="FFB9C6DA"/></right>'
      + '<top style="thin"><color rgb="FFB9C6DA"/></top><bottom style="thin"><color rgb="FFB9C6DA"/></bottom><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="5">'
      + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
      + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'
      + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'
      + '<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'
      + '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
      + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

    var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="' + esc(sheetName(title)) + '" sheetId="1" r:id="rId1"/></sheets></workbook>';

    var wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>';

    return {
      '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + '</Types>',
      '_rels/.rels': relsXml([['rId1', 'officeDocument', 'xl/workbook.xml']]),
      'xl/workbook.xml': workbook,
      'xl/_rels/workbook.xml.rels': wbRels,
      'xl/worksheets/sheet1.xml': sheet,
      'xl/styles.xml': styles
    };
  }
  function sheetName(s) {
    return String(s || 'Sheet1').replace(/[\\\/\?\*\[\]:']/g, ' ').slice(0, 31) || 'Sheet1';
  }
  function paperCode(p) {
    return { letter: 1, legal: 5, a3: 8, a4: 9, a5: 11 }[p] || 9;
  }

  /* ---------------- PPTX ---------------- */
  function pptxParts(blocks, o) {
    // group blocks into slides: a heading 1/2 starts a new slide
    var slides = [], cur = null;
    blocks.forEach(function (b) {
      if (b.table) {
        if (!cur) { cur = { title: o.title || 'Untitled', items: [] }; slides.push(cur); }
        cur.items.push({ kind: 'table', grid: b.table });
        return;
      }
      var text = normSpace(b.map(function (r) { return r.text; }).join('')).trim();
      if (!text) return;
      var h = (b[0] && b[0].heading) || 0;
      if (h === 1 || h === 2 || !cur || cur.items.length > 7) {
        cur = { title: text, items: [] };
        slides.push(cur);
        return;
      }
      cur.items.push({ kind: 'text', text: text, level: b[0] && b[0].li ? 1 : 0, bold: !!(b[0] && b[0].b) });
    });
    if (!slides.length) slides.push({ title: o.title || 'Untitled', items: [] });
    if (slides.length === 1 && !slides[0].title) slides[0].title = o.title || 'Untitled';

    var parts = {};
    var overrides = ['<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'];
    var sldRels = [];
    slides.forEach(function (slide, i) {
      var n = i + 1;
      overrides.push('<Override PartName="/ppt/slides/slide' + n + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>');
      sldRels.push('<Relationship Id="rId' + n + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + n + '.xml"/>');
      parts['ppt/slides/slide' + n + '.xml'] = slideXml(slide, o);
      parts['ppt/slides/_rels/slide' + n + '.xml.rels'] = relsXml([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]);
    });

    parts['[Content_Types].xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + overrides.join('')
      + '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
      + '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
      + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
      + '</Types>';
    parts['_rels/.rels'] = relsXml([['rId1', 'officeDocument', 'ppt/presentation.xml']]);
    parts['ppt/_rels/presentation.xml.rels'] = relsXml(sldRels.map(function (x) {
      var m = x.match(/Id="([^"]+)"[^>]*Target="([^"]+)"/); return [m[1], 'slide', m[2]];
    }).concat([['rIdMaster', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rIdTheme', 'theme', 'theme/theme1.xml']]));

    var sldIds = slides.map(function (s, i) { return '<p:sldId id="' + (256 + i) + '" r:id="rId' + (i + 1) + '"/>'; }).join('');
    parts['ppt/presentation.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
      + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst>'
      + '<p:sldIdLst>' + sldIds + '</p:sldIdLst>'
      + '<p:sldSz cx="' + (o.ori === 'landscape' ? 12192000 : 9144000) + '" cy="' + (o.ori === 'landscape' ? 6858000 : 12192000) + '"/>'
      + '<p:notesSz cx="6858000" cy="9144000"/></p:presentation>';

    parts['ppt/slideMasters/slideMaster1.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
      + '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
      + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
      + '</p:spTree></p:cSld>'
      + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" '
      + 'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
      + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';
    parts['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = relsXml([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]);
    parts['ppt/slideLayouts/slideLayout1.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">'
      + '<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
      + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
      + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
    parts['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = relsXml([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]);
    parts['ppt/theme/theme1.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="SingVaza">'
      + '<a:themeElements><a:clrScheme name="SingVaza">'
      + '<a:dk1><a:srgbClr val="111827"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>'
      + '<a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F6F7FB"/></a:lt2>'
      + '<a:accent1><a:srgbClr val="F59E0B"/></a:accent1><a:accent2><a:srgbClr val="0EA5E9"/></a:accent2>'
      + '<a:accent3><a:srgbClr val="10B981"/></a:accent3><a:accent4><a:srgbClr val="EF4444"/></a:accent4>'
      + '<a:accent5><a:srgbClr val="8B5CF6"/></a:accent5><a:accent6><a:srgbClr val="64748B"/></a:accent6>'
      + '<a:hlink><a:srgbClr val="0B61C4"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink>'
      + '</a:clrScheme>'
      + '<a:fontScheme name="SingVaza"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface="Iskoola Pota"/></a:majorFont>'
      + '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface="Iskoola Pota"/></a:minorFont></a:fontScheme>'
      + '<a:fmtScheme name="SingVaza"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
      + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
      + '<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
      + '<a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
      + '<a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
      + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>'
      + '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
      + '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
      + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>'
      + '</a:fmtScheme></a:themeElements></a:theme>';
    return parts;
  }
  function slideXml(slide, o) {
    var wide = o.ori === 'landscape';
    var W = wide ? 12192000 : 9144000, H = wide ? 6858000 : 12192000;
    var margin = 457200;
    var shapes = [];
    var id = 2;
    // title
    shapes.push('<p:sp><p:nvSpPr><p:cNvPr id="' + (id++) + '" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
      + '<p:spPr><a:xfrm><a:off x="' + margin + '" y="' + margin + '"/><a:ext cx="' + (W - 2 * margin) + '" cy="914400"/></a:xfrm>'
      + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
      + '<p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>'
      + '<a:p><a:r><a:rPr lang="en-US" sz="3200" b="1"><a:solidFill><a:srgbClr val="111827"/></a:solidFill></a:rPr>'
      + '<a:t>' + esc(slide.title) + '</a:t></a:r></a:p></p:txBody></p:sp>');
    // body
    var bodyY = margin + 1219200;
    var bodyH = H - bodyY - margin;
    var paras = slide.items.filter(function (i) { return i.kind === 'text'; }).map(function (it) {
      return '<a:p><a:pPr lvl="' + (it.level ? 1 : 0) + '"/>'
        + '<a:r><a:rPr lang="en-US" sz="1800"' + (it.bold ? ' b="1"' : '') + '><a:solidFill><a:srgbClr val="1F2937"/></a:solidFill></a:rPr>'
        + '<a:t>' + esc(it.text.slice(0, 600)) + '</a:t></a:r></a:p>';
    }).join('');
    if (paras) {
      shapes.push('<p:sp><p:nvSpPr><p:cNvPr id="' + (id++) + '" name="Body"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        + '<p:spPr><a:xfrm><a:off x="' + margin + '" y="' + bodyY + '"/><a:ext cx="' + (W - 2 * margin) + '" cy="' + bodyH + '"/></a:xfrm>'
        + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
        + '<p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>' + paras + '</p:txBody></p:sp>');
    }
    // a table becomes a simple grid of text boxes (kept to the first rows that fit)
    var table = slide.items.filter(function (i) { return i.kind === 'table'; })[0];
    if (table && table.grid.length) {
      var rows = table.grid.slice(0, 8);
      var cols = Math.max.apply(null, rows.map(function (r) { return r.length; }));
      var tblW = W - 2 * margin, tblH = Math.min(bodyH, rows.length * 380000);
      var rowH = Math.floor(tblH / rows.length), colW = Math.floor(tblW / cols);
      var trs = rows.map(function (row, ri) {
        var tcs = [];
        for (var c = 0; c < cols; c++) {
          var cell = row[c] || { text: '', head: false };
          tcs.push('<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>'
            + '<a:rPr lang="en-US" sz="1200"' + (cell.head || ri === 0 ? ' b="1"' : '') + '><a:solidFill><a:srgbClr val="1F2937"/></a:solidFill></a:rPr>'
            + '<a:t>' + esc(String(cell.text).slice(0, 120)) + '</a:t></a:r></a:p></a:txBody>'
            + '<a:tcPr marL="45720" marR="45720" marT="22860" marB="22860" anchor="ctr"/>'
            + (ri === 0 ? '<a:solidFill><a:srgbClr val="EFF4FB"/></a:solidFill>' : '')
            + '</a:tc>');
        }
        return '<a:tr h="' + rowH + '">' + tcs.join('') + '</a:tr>';
      }).join('');
      shapes.push('<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="' + (id++) + '" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
        + '<p:xfrm><a:off x="' + margin + '" y="' + bodyY + '"/><a:ext cx="' + tblW + '" cy="' + tblH + '"/></p:xfrm>'
        + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">'
        + '<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>'
        + new Array(cols + 1).join('<a:gridCol w="' + colW + '"/>')
        + '</a:tblGrid>' + trs + '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>');
    }
    // footer
    if (o.footer) {
      shapes.push('<p:sp><p:nvSpPr><p:cNvPr id="' + (id++) + '" name="Footer"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        + '<p:spPr><a:xfrm><a:off x="' + margin + '" y="' + (H - margin - 300000) + '"/><a:ext cx="' + (W - 2 * margin) + '" cy="300000"/></a:xfrm>'
        + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
        + '<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>'
        + '<a:p><a:r><a:rPr lang="en-US" sz="1100"><a:solidFill><a:srgbClr val="7A879E"/></a:solidFill></a:rPr>'
        + '<a:t>' + esc(o.footer) + '</a:t></a:r></a:p></p:txBody></p:sp>');
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
      + '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
      + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
      + shapes.join('') + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
  }

  /* ---------------- shared OOXML plumbing ---------------- */
  function relsXml(entries) {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + entries.map(function (e) {
        return '<Relationship Id="' + e[0] + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + e[1] + '" Target="' + e[2] + '"/>';
      }).join('')
      + '</Relationships>';
  }
  function docxParts(blocks, o) {
    var parts = {};
    var overrides = ['<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'];
    var docRels = [['rId1', 'styles', 'styles.xml']];
    if (o.footer) {
      overrides.push('<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>');
      docRels.push(['rIdFooter1', 'footer', 'footer1.xml']);
      parts['word/footer1.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>'
        + '<w:r><w:rPr><w:sz w:val="16"/><w:color w:val="7A879E"/></w:rPr><w:t xml:space="preserve">' + esc(o.footer) + '</w:t></w:r>'
        + '<w:r><w:rPr><w:sz w:val="16"/><w:color w:val="7A879E"/></w:rPr><w:t xml:space="preserve">   </w:t></w:r>'
        + '<w:r><w:rPr><w:sz w:val="16"/><w:color w:val="7A879E"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>'
        + '<w:r><w:rPr><w:sz w:val="16"/><w:color w:val="7A879E"/></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
        + '<w:r><w:rPr><w:sz w:val="16"/><w:color w:val="7A879E"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r>'
        + '</w:p></w:ftr>';
    }
    parts['[Content_Types].xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + overrides.join('') + '</Types>';
    parts['_rels/.rels'] = relsXml([['rId1', 'officeDocument', 'word/document.xml']]);
    parts['word/document.xml'] = docxDocument(blocks, o);
    parts['word/_rels/document.xml.rels'] = relsXml(docRels);
    parts['word/styles.xml'] = DOCX_STYLES;
    if (o.title) {
      overrides.push('');
      parts['docProps/core.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        + 'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>' + esc(o.title) + '</dc:title>'
        + '<dc:creator>SingVaza</dc:creator></cp:coreProperties>';
      parts['_rels/.rels'] = relsXml([['rId1', 'officeDocument', 'word/document.xml'], ['rId2', 'metadata/core-properties', 'docProps/core.xml']]);
      parts['[Content_Types].xml'] = parts['[Content_Types].xml'].replace('</Types>',
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>');
    }
    return parts;
  }

  /* ---------------- stored (no compression) ZIP writer ---------------- */
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zip(files) {
    var encoder = new TextEncoder(), chunks = [], central = [], offset = 0;
    Object.keys(files).forEach(function (name) {
      var nameBytes = encoder.encode(name);
      var data = typeof files[name] === 'string' ? encoder.encode(files[name]) : files[name];
      var crc = crc32(data);
      var local = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);            // version needed
      dv.setUint16(6, 0, true);             // flags
      dv.setUint16(8, 0, true);             // method: stored
      dv.setUint16(10, 0, true);            // time
      dv.setUint16(12, 0x21, true);         // date: 1980-01-01
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      chunks.push(local, data);

      var cd = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);
      offset += local.length + data.length;
    });
    var centralSize = central.reduce(function (n, c2) { return n + c2.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    return new Blob(chunks.concat(central, [end]), { type: 'application/zip' });
  }

  /* ---------------- public API ---------------- */
  var MIME = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  };

  function htmlBlocks(html) {
    var host = document.createElement('div');
    host.innerHTML = String(html || '');
    host.querySelectorAll('script,style,noscript').forEach(function (n) { n.remove(); });
    return collectBlocks(host, {});
  }

  root.SingVazaOfficeWrite = {
    write: function (kind, opts) {
      return new Promise(function (resolve, reject) {
        try {
          opts = opts || {};
          var blocks = htmlBlocks(opts.html);
          var parts = kind === 'docx' ? docxParts(blocks, opts)
            : kind === 'xlsx' ? xlsxParts(blocks, opts)
              : kind === 'pptx' ? pptxParts(blocks, opts) : null;
          if (!parts) throw new Error('unknown format: ' + kind);
          var blob = zip(parts);
          resolve(new Blob([blob], { type: MIME[kind] }));
        } catch (err) { reject(err); }
      });
    },
    htmlBlocks: htmlBlocks,
    mime: MIME
  };
  if (typeof module === 'object' && module.exports) module.exports = root.SingVazaOfficeWrite;
})(typeof window !== 'undefined' ? window : this);
