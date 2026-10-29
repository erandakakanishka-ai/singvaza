/* =====================================================================
 * SingVaza office reader — .docx / .xlsx / .pptx -> printable HTML.
 *
 * A modern Office file is a ZIP full of XML, so this file is two small pieces:
 * a ZIP reader (inflate via the browser's DecompressionStream) and three
 * readers that turn the XML of each part into the same DOM the PDF engine
 * already knows how to draw. Nothing is uploaded and no library is needed.
 * ===================================================================== */
(function (global) {
  'use strict';

  /* ---------------- ZIP reader ---------------- */
  function u16(v, o) { return v.getUint16(o, true); }
  function u32(v, o) { return v.getUint32(o, true); }

  function readZip(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer), view = new DataView(arrayBuffer);
    // find the end-of-central-directory record (last 64 KB)
    var eocd = -1, min = Math.max(0, bytes.length - 66000);
    for (var i = bytes.length - 22; i >= min; i--) {
      if (u32(view, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This does not look like an Office file (it is not a ZIP archive).');
    var entries = u16(view, eocd + 10), cdOffset = u32(view, eocd + 16);
    var files = {};
    var p = cdOffset;
    for (var e = 0; e < entries; e++) {
      if (u32(view, p) !== 0x02014b50) break;
      var method = u16(view, p + 10);
      var compSize = u32(view, p + 20);
      var rawSize = u32(view, p + 24);
      var nameLen = u16(view, p + 28), extraLen = u16(view, p + 30), commentLen = u16(view, p + 32);
      var localOff = u32(view, p + 42);
      var name = '';
      for (var n = 0; n < nameLen; n++) name += String.fromCharCode(bytes[p + 46 + n]);
      files[name] = { method: method, compSize: compSize, rawSize: rawSize, localOff: localOff };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return {
      names: Object.keys(files),
      has: function (name) { return Boolean(files[name]); },
      read: function (name) {
        var f = files[name];
        if (!f) return Promise.resolve(null);
        var lh = f.localOff;
        var lNameLen = u16(view, lh + 26), lExtraLen = u16(view, lh + 28);
        var start = lh + 30 + lNameLen + lExtraLen;
        var data = bytes.subarray(start, start + (f.compSize || f.rawSize));
        if (f.method === 0) return Promise.resolve(new TextDecoder('utf-8').decode(data));
        if (typeof DecompressionStream === 'undefined') {
          return Promise.reject(new Error('This browser cannot unpack Office files. Use Chrome, or export the file as PDF first.'));
        }
        var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).arrayBuffer().then(function (buf) {
          return new TextDecoder('utf-8').decode(buf);
        });
      },
      readBytes: function (name) {
        var f = files[name];
        if (!f) return Promise.resolve(null);
        var lh = f.localOff;
        var lNameLen = u16(view, lh + 26), lExtraLen = u16(view, lh + 28);
        var start = lh + 30 + lNameLen + lExtraLen;
        var data = bytes.subarray(start, start + (f.compSize || f.rawSize));
        if (f.method === 0) return Promise.resolve(data.slice());
        var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
      },
      size: Object.keys(files).length
    };
  }

  /* ---------------- XML helpers (no DOMParser surprises) ---------------- */
  function parseXml(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('This file contains unreadable XML.');
    return doc;
  }
  function localName(node) {
    return (node.localName || node.nodeName || '').replace(/^.*:/, '');
  }
  function childrenOf(node, name) {
    var out = [];
    for (var i = 0; i < node.childNodes.length; i++) {
      var c = node.childNodes[i];
      if (c.nodeType === 1 && (!name || localName(c) === name)) out.push(c);
    }
    return out;
  }
  function firstChild(node, name) { return childrenOf(node, name)[0] || null; }
  function descendants(node, name) {
    var out = [], all = node.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) if (localName(all[i]) === name) out.push(all[i]);
    return out;
  }
  function attr(node, name) {
    if (!node) return null;
    return node.getAttribute(name) || node.getAttribute('w:' + name) || node.getAttribute('r:' + name) || null;
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------------- DOCX ---------------- */
  function docxToHtml(zip) {
    return Promise.all([zip.read('word/document.xml'), zip.read('word/styles.xml'), zip.read('word/numbering.xml')]).then(function (parts) {
      if (!parts[0]) throw new Error('This Word file has no document body. It may be a template or a protected file.');
      var doc = parseXml(parts[0]);
      var body = descendants(doc, 'body')[0];
      if (!body) throw new Error('This Word file has no readable body text.');
      var out = [];
      var listDepth = 0;
      childrenOf(body).forEach(function (block) {
        var tag = localName(block);
        if (tag === 'p') {
          var html = paragraphHtml(block);
          if (!html) return;
          var pPr = firstChild(block, 'pPr');
          var style = pPr ? firstChild(pPr, 'pStyle') : null;
          var styleId = style ? attr(style, 'val') : '';
          var numPr = pPr ? firstChild(pPr, 'numPr') : null;
          var heading = /^Heading([1-6])$/i.exec(styleId || '');
          var level = pPr ? firstChild(pPr, 'outlineLvl') : null;
          if (!heading && level) {
            var lv = parseInt(attr(level, 'val'), 10);
            if (!isNaN(lv) && lv < 6) heading = [null, '1', '2', '3', '4', '5', '6'][lv + 1] ? [null, lv + 1] : null;
          }
          if (numPr) { html = '<li>' + html + '</li>'; }
          if (heading) {
            var h = heading[1] ? Number(heading[1]) : (heading[0] ? Number(heading[0].replace(/[^1-6]/g, '')) : 2);
            out.push('<h' + Math.min(4, Math.max(1, h || 2)) + '>' + html + '</h' + Math.min(4, Math.max(1, h || 2)) + '>');
          } else if (numPr) {
            out.push('<ul class="docx-list">' + html + '</ul>');
          } else if (/^Title$/i.test(styleId || '')) {
            out.push('<h1>' + html + '</h1>');
          } else {
            out.push('<p>' + html + '</p>');
          }
        } else if (tag === 'tbl') {
          out.push(tableHtml(block));
        }
      });
      return out.join('\n');
    });
  }
  function paragraphHtml(p) {
    var runs = [];
    childrenOf(p).forEach(function (child) {
      var t = localName(child);
      if (t === 'r') {
        var text = '';
        childrenOf(child).forEach(function (rc) {
          var rt = localName(rc);
          if (rt === 't') text += rc.textContent;
          else if (rt === 'tab') text += '\t';
          else if (rt === 'br' || rt === 'cr') text += '\n';
          else if (rt === 'drawing' || rt === 'pict') text += '';
        });
        if (!text) return;
        var rPr = firstChild(child, 'rPr');
        var bold = rPr && firstChild(rPr, 'b') && attr(firstChild(rPr, 'b'), 'val') !== '0';
        var ital = rPr && firstChild(rPr, 'i') && attr(firstChild(rPr, 'i'), 'val') !== '0';
        var under = rPr && firstChild(rPr, 'u') && attr(firstChild(rPr, 'u'), 'val') !== 'none';
        var strike = rPr && firstChild(rPr, 'strike');
        var code = false, vert = '', color = null, size = null;
        if (rPr) {
          var rFonts = firstChild(rPr, 'rFonts');
          if (rFonts && /mono|courier|consolas/i.test(attr(rFonts, 'ascii') || '')) code = true;
          var va = firstChild(rPr, 'vertAlign');
          vert = va ? attr(va, 'val') : '';
          var col = firstChild(rPr, 'color');
          color = col ? attr(col, 'val') : null;
          var sz = firstChild(rPr, 'sz');
          size = sz ? Number(attr(sz, 'val')) / 2 : null;
        }
        var piece = esc(text);
        if (code) piece = '<code>' + piece + '</code>';
        if (bold) piece = '<strong>' + piece + '</strong>';
        if (ital) piece = '<em>' + piece + '</em>';
        if (under) piece = '<u>' + piece + '</u>';
        if (strike) piece = '<s>' + piece + '</s>';
        if (vert === 'superscript') piece = '<sup>' + piece + '</sup>';
        if (vert === 'subscript') piece = '<sub>' + piece + '</sub>';
        var styles = [];
        if (color && /^[0-9a-f]{6}$/i.test(color)) styles.push('color:#' + color);
        if (size && (size > 15 || size < 9)) styles.push('font-size:' + Math.min(30, Math.max(7, size)) + 'pt');
        if (styles.length) piece = '<span style="' + styles.join(';') + '">' + piece + '</span>';
        runs.push(piece);
      } else if (t === 'hyperlink') {
        var txt = descendants(child, 't').map(function (n) { return n.textContent; }).join('');
        if (txt) runs.push('<a href="#">' + esc(txt) + '</a>');
      }
    });
    var joined = runs.join('').replace(/\n/g, '<br>');
    return joined.trim() ? joined : '';
  }
  function tableHtml(tbl) {
    var rows = childrenOf(tbl, 'tr');
    var out = ['<table>'];
    rows.forEach(function (tr, ri) {
      var cells = childrenOf(tr, 'tc');
      out.push('<tr>');
      cells.forEach(function (tc) {
        var txt = [], span = 1;
        var tcPr = firstChild(tc, 'tcPr');
        if (tcPr) {
          var gs = firstChild(tcPr, 'gridSpan');
          if (gs) span = Math.max(1, Number(attr(gs, 'val')) || 1);
        }
        childrenOf(tc, 'p').forEach(function (p) {
          var t = descendants(p, 't').map(function (n) { return n.textContent; }).join('');
          if (t.trim()) txt.push(t);
        });
        var tag = ri === 0 ? 'th' : 'td';
        out.push('<' + tag + (span > 1 ? ' colspan="' + span + '"' : '') + '>' + esc(txt.join(' ')) + '</' + tag + '>');
      });
      out.push('</tr>');
    });
    out.push('</table>');
    return out.join('');
  }

  /* ---------------- XLSX ---------------- */
  function colToIndex(ref) {
    var m = /^([A-Z]+)(\d+)$/.exec(ref || '');
    if (!m) return { c: 0, r: 0 };
    var c = 0;
    for (var i = 0; i < m[1].length; i++) c = c * 26 + (m[1].charCodeAt(i) - 64);
    return { c: c - 1, r: Number(m[2]) - 1 };
  }
  function xlsxToHtml(zip) {
    var sharedP = zip.read('xl/sharedStrings.xml');
    var wbP = zip.read('xl/workbook.xml');
    var relsP = zip.read('xl/_rels/workbook.xml.rels');
    return Promise.all([sharedP, wbP, relsP]).then(function (parts) {
      if (!parts[1]) throw new Error('This is not a readable Excel file.');
      var shared = [];
      if (parts[0]) {
        var sdoc = parseXml(parts[0]);
        descendants(sdoc, 'si').forEach(function (si) {
          shared.push(descendants(si, 't').map(function (t) { return t.textContent; }).join(''));
        });
      }
      var idToPath = {};
      if (parts[2]) {
        var rdoc = parseXml(parts[2]);
        var all = rdoc.getElementsByTagName('*');
        for (var i = 0; i < all.length; i++) {
          var node = all[i];
          if (localName(node) === 'Relationship') {
            var id = node.getAttribute('Id'), target = node.getAttribute('Target') || '';
            if (id) idToPath[id] = target.replace(/^\//, '').replace(/^xl\//, '');
          }
        }
      }
      var wdoc = parseXml(parts[1]);
      var sheets = descendants(wdoc, 'sheet').map(function (s) {
        var name = attr(s, 'name') || 'Sheet';
        var rid = s.getAttribute('r:id') || s.getAttribute('id') || '';
        var path = idToPath[rid] || '';
        return { name: name, path: path ? ('xl/' + path) : '' };
      });
      if (!sheets.length) throw new Error('This workbook has no sheets.');
      var reads = sheets.map(function (s) {
        if (s.path && zip.has(s.path)) return zip.read(s.path);
        var guess = 'xl/worksheets/sheet1.xml';
        return zip.has(guess) ? zip.read(guess) : Promise.resolve(null);
      });
      return Promise.all(reads).then(function (xmls) {
        var out = [];
        xmls.forEach(function (xml, si) {
          if (!xml) return;
          var doc = parseXml(xml);
          var rows = descendants(doc, 'row').map(function (row) {
            var cells = [];
            descendants(row, 'c').forEach(function (c) {
              var ref = attr(c, 'r') || '';
              var type = attr(c, 't') || '';
              var vEl = firstChild(c, 'v');
              var value = vEl ? vEl.textContent : '';
              if (type === 's') value = shared[Number(value)] || '';
              else if (type === 'inlineStr') value = descendants(c, 't').map(function (t) { return t.textContent; }).join('');
              else if (type === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
              cells.push({ col: colToIndex(ref).c, value: value, bold: /\bbold\b/i.test(c.getAttribute('s') || '') });
            });
            return cells;
          }).filter(function (cells) { return cells.length; });
          var html = ['<h3>' + esc(sheets[si].name) + '</h3>'];
          if (!rows.length) { html.push('<p><em>This sheet is empty.</em></p>'); out.push(html.join('')); return; }
          var maxCol = 0;
          rows.forEach(function (cells) { cells.forEach(function (c) { maxCol = Math.max(maxCol, c.col); }); });
          html.push('<table>');
          rows.slice(0, 400).forEach(function (cells, ri) {
            html.push('<tr>');
            var byCol = {};
            cells.forEach(function (c) { byCol[c.col] = c; });
            for (var ci = 0; ci <= maxCol; ci++) {
              var cell = byCol[ci];
              var tag = ri === 0 ? 'th' : 'td';
              html.push('<' + tag + '>' + esc(cell ? cell.value : '') + '</' + tag + '>');
            }
            html.push('</tr>');
          });
          html.push('</table>');
          if (rows.length > 400) html.push('<p><em>Showing the first 400 rows.</em></p>');
          out.push(html.join(''));
        });
        return out.join('<hr>');
      });
    });
  }

  /* ---------------- PPTX ---------------- */
  function pptxToHtml(zip) {
    var slides = zip.names.filter(function (n) { return /^ppt\/slides\/slide\d+\.xml$/.test(n); })
      .sort(function (a, b) { return Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')); });
    if (!slides.length) throw new Error('This presentation has no slides.');
    return Promise.all(slides.map(function (n) { return zip.read(n); })).then(function (xmls) {
      var out = [];
      xmls.forEach(function (xml, i) {
        var doc = parseXml(xml);
        var title = '';
        var paras = [];
        descendants(doc, 'sp').forEach(function (sp) {
          var ph = descendants(sp, 'ph')[0];
          var phType = ph ? (attr(ph, 'type') || 'body') : 'body';
          var isTitle = /title/i.test(phType);
          descendants(sp, 'p').forEach(function (p) {
            var text = descendants(p, 't').map(function (t) { return t.textContent; }).join('');
            if (!text.trim()) return;
            if (isTitle && !title) title = text.trim();
            else paras.push(text.trim());
          });
        });
        out.push('<h2>Slide ' + (i + 1) + (title ? ': ' + esc(title) : '') + '</h2>');
        if (paras.length) {
          out.push('<ul>' + paras.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>');
        } else if (!title) {
          out.push('<p><em>No text on this slide (it may be an image or a chart).</em></p>');
        }
      });
      return out.join('\n');
    });
  }

  /* ---------------- entry point ---------------- */
  function readOfficeFile(arrayBuffer, ext) {
    var zip = readZip(arrayBuffer);
    var kind = (ext || '').toLowerCase().replace('.', '');
    if (!kind) {
      if (zip.has('word/document.xml')) kind = 'docx';
      else if (zip.has('xl/workbook.xml')) kind = 'xlsx';
      else if (zip.names.some(function (n) { return /^ppt\/slides\/slide\d+\.xml$/.test(n); })) kind = 'pptx';
    }
    if (kind === 'docx') return docxToHtml(zip).then(function (h) { return { kind: kind, html: h }; });
    if (kind === 'xlsx') return xlsxToHtml(zip).then(function (h) { return { kind: kind, html: h }; });
    if (kind === 'pptx') return pptxToHtml(zip).then(function (h) { return { kind: kind, html: h }; });
    return Promise.reject(new Error('Only .docx, .xlsx and .pptx are supported. Old .doc/.xls/.ppt files must be saved as the newer format (or as PDF) first.'));
  }

  global.SingVazaOffice = { readOfficeFile: readOfficeFile, readZip: readZip };
})(window);
