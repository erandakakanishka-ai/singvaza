/* =====================================================================
 * SingVaza document engine — shared by /studio/html-to-pdf and
 * /studio/office-to-pdf. It renders a DOM document onto canvas pages (no
 * library, no server) and writes a real PDF byte by byte.
 *
 * Everything that the page used to read from its own inputs now comes from
 * the LV object, so one engine serves both tools:
 *   LV.src() LV.type() LV.paper() LV.mode() LV.ori() LV.margin() LV.fontSize()
 *   LV.lineHeight() LV.fontFamily() LV.title() LV.footer() LV.opt(name)
 *   LV.lang() LV.highlight() LV.host()
 * ===================================================================== */
(function (global) {
  var A4PX = 96 / 25.4;
  var PAPER = { a4: { w: 210, h: 297 }, a5: { w: 148, h: 210 }, a3: { w: 297, h: 420 }, letter: { w: 215.9, h: 279.4 }, legal: { w: 215.9, h: 355.6 } };
  /* ---------------- helpers ---------------- */
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function binaries(str) { var out = new Uint8Array(str.length); for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 255; return out; }

  /* ---------------- Markdown ---------------- */
  function inlineMd(text, o) {
    var t = esc(text);
    if (o && o.smartQuotes) t = t.replace(/(^|[\s(\[])"([^"\n]+)"/g, '$1\u201c$2\u201d').replace(/(^|[\s(\[])'([^'\n]+)'/g, '$1\u2018$2\u2019');
    t = t.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>'; });
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, function (_, alt, url) { return /^(https?:|data:image\/)/i.test(url) ? '<img src="' + url + '" alt="' + alt + '">' : esc(alt); });
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, function (_, label, url) { return '<a href="' + url + '">' + label + '</a>'; });
    t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^_])__([^_]+)__/g, '$1<strong>$2</strong>');
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return t;
  }
  function markdownToHtml(md, o) {
    var lines = String(md).replace(/\r\n?/g, '\n').split('\n'), out = [], i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      var fence = line.match(/^\s*(```|~~~)\s*([\w+#.-]*)/);
      if (fence) {
        var lang = fence[2] || '', buf = []; i++;
        while (i < lines.length && !new RegExp('^\\s*' + fence[1]).test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<pre><code>' + (o && o.highlight ? highlightCode(buf.join('\n'), lang || 'auto') : esc(buf.join('\n'))) + '</code></pre>');
        continue;
      }
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { out.push('<h' + h[1].length + '>' + inlineMd(h[2], o) + '</h' + h[1].length + '>'); i++; continue; }
      if (/^\s*([-*_])\s*\1\s*\1[\s-]*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(line)) {
        var q = []; while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push('<blockquote>' + markdownToHtml(q.join('\n'), o) + '</blockquote>'); continue;
      }
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        var head = line.split('|').map(function (c) { return c.trim(); });
        if (head[0] === '') head.shift(); if (head[head.length - 1] === '') head.pop();
        i += 2;
        var rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
          var cells = lines[i].split('|').map(function (c) { return c.trim(); });
          if (cells[0] === '') cells.shift(); if (cells[cells.length - 1] === '') cells.pop();
          rows.push(cells); i++;
        }
        var t = '<table><thead><tr>' + head.map(function (c) { return '<th>' + inlineMd(c, o) + '</th>'; }).join('') + '</tr></thead><tbody>';
        rows.forEach(function (r) { t += '<tr>' + r.map(function (c) { return '<td>' + inlineMd(c, o) + '</td>'; }).join('') + '</tr>'; });
        out.push(t + '</tbody></table>'); continue;
      }
      var lm = line.match(/^(\s*)([-*+]|\d+[.)])\s+/);
      if (lm) {
        var ordered = /\d/.test(lm[2]), baseIndent = lm[1].length, items = [];
        while (i < lines.length) {
          var m2 = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (m2 && m2[1].length === baseIndent) {
            var itemLines = [m2[3]]; i++;
            while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) { itemLines.push(lines[i].trim()); i++; }
            items.push(itemLines.join(' ')); continue;
          }
          if (m2 && m2[1].length > baseIndent) {
            var nested = [], ni = m2[1].length;
            while (i < lines.length) {
              var m3 = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+.*$/);
              if (!m3 || m3[1].length < ni) break;
              nested.push(lines[i].slice(ni)); i++;
            }
            items[items.length - 1] += '\n' + nested.join('\n'); continue;
          }
          break;
        }
        var lt = ordered ? '<ol>' : '<ul>';
        items.forEach(function (it) {
          if (it.indexOf('\n') >= 0) { var parts = it.split('\n'); lt += '<li>' + inlineMd(parts[0], o) + markdownToHtml(parts.slice(1).join('\n'), o) + '</li>'; }
          else lt += '<li>' + inlineMd(it, o) + '</li>';
        });
        out.push(lt + (ordered ? '</ol>' : '</ul>')); continue;
      }
      var para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*(#{1,6})\s/.test(lines[i]) && !/^\s*(```|~~~)/.test(lines[i])) { para.push(lines[i]); i++; }
      out.push('<p>' + inlineMd(para.join(' '), o) + '</p>');
    }
    return out.join('\n');
  }

  /* ---------------- syntax colours ---------------- */
  var KEYWORDS = {
    js: 'const let var function return if else for while do switch case break continue class extends new this typeof instanceof try catch finally throw async await import from export default null undefined true false of in delete void yield static get set super',
    ts: 'const let var function return if else for while class interface type enum export import from public private protected readonly async await new this try catch implements extends null undefined true false as of in',
    py: 'def class return if elif else for while in not and or import from as try except finally with lambda None True False yield global nonlocal pass raise assert del is async await print self',
    java: 'public private protected static final class interface extends implements return if else for while new try catch finally import package void int long double float boolean char String null true false this super throw throws abstract synchronized',
    c: 'int long short char float double void struct union enum typedef static const unsigned signed return if else for while do switch case break continue sizeof goto extern inline class public private new delete nullptr true false using namespace template typename',
    cs: 'public private protected internal static class struct interface return if else for foreach while new try catch finally using namespace void int string bool double float var null true false this base override virtual async await',
    php: 'function class return if else elseif foreach for while switch new try catch finally echo print public private protected static const use namespace null true false array isset unset',
    go: 'package import func var const type struct interface return if else for range switch case break continue go defer chan select map nil true false make new',
    rs: 'fn let mut pub struct enum impl trait use mod return if else for while loop match break continue const static async await move ref where self Self Some None Ok Err true false',
    sql: 'SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET CREATE TABLE ALTER DROP INDEX AS AND OR NOT NULL PRIMARY KEY FOREIGN DISTINCT COUNT SUM AVG MIN MAX CASE WHEN THEN ELSE END',
    sh: 'if then else elif fi for while do done case esac function return echo export local cd ls cat grep sed awk rm cp mv mkdir sudo set source exit',
    json: 'true false null'
  };
  function detectLang(code) {
    if (/^\s*</.test(code) && /<\/[a-z]/i.test(code)) return 'html';
    if (/^\s*\{[\s\S]*\}\s*$/.test(code) && /"[^"]+"\s*:/.test(code)) return 'json';
    if (/^\s*(def |import |from |class |elif |print\()/m.test(code)) return 'py';
    if (/(function |const |=>|let |console\.log)/.test(code)) return 'js';
    if (/(public |private |void |System\.out)/.test(code)) return 'java';
    if (/(#include|std::|printf\()/.test(code)) return 'c';
    if (/(\$\w+\s*=|<\?php|namespace )/.test(code)) return 'php';
    if (/(func |package |:=\s)/.test(code)) return 'go';
    if (/(fn |let mut |impl )/.test(code)) return 'rs';
    if (/(SELECT |INSERT INTO|CREATE TABLE)/i.test(code)) return 'sql';
    if (/^\s*(#!\/|sudo |apt |npm |\$ )/m.test(code)) return 'sh';
    if (/(\{[\s\S]*:[^;]+;\s*\})/.test(code)) return 'css';
    return 'js';
  }
  function highlightCode(code, lang) {
    var l = (!lang || lang === 'auto') ? detectLang(code) : lang;
    if (l === 'html') {
      var t = esc(code);
      t = t.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-c">$1</span>');
      t = t.replace(/(&lt;\/?)([\w:-]+)/g, '$1<span class="tok-t">$2</span>');
      t = t.replace(/([\w:-]+)=(&quot;[^&]*?&quot;)/g, '<span class="tok-k">$1</span>=<span class="tok-s">$2</span>');
      return t;
    }
    if (l === 'json') {
      return esc(code).replace(/"([^"\\]*)"(\s*:)?/g, function (m, str, colon) {
        return colon ? '<span class="tok-t">"' + str + '"</span>' + colon : '<span class="tok-s">"' + str + '"</span>';
      }).replace(/\b(true|false|null)\b/g, '<span class="tok-k">$1</span>');
    }
    var map = {}, kws = (KEYWORDS[l] || KEYWORDS.js).split(/\s+/);
    for (var ki = 0; ki < kws.length; ki++) map[kws[ki]] = 1;
    var out = '', i = 0, n = code.length;
    var lineComment = (l === 'py' || l === 'sh') ? '#' : '//';
    var blockComments = !(l === 'py' || l === 'sh');
    while (i < n) {
      var c = code[i];
      if (blockComments && code.substr(i, 2) === '/*') {
        var e0 = code.indexOf('*/', i + 2); e0 = e0 < 0 ? n : e0 + 2;
        out += '<span class="tok-c">' + esc(code.slice(i, e0)) + '</span>'; i = e0; continue;
      }
      if (code.startsWith(lineComment, i)) {
        var e1 = code.indexOf('\n', i); e1 = e1 < 0 ? n : e1;
        out += '<span class="tok-c">' + esc(code.slice(i, e1)) + '</span>'; i = e1; continue;
      }
      if (c === '"' || c === "'" || (c === '`' && (l === 'js' || l === 'ts'))) {
        var j = i + 1;
        while (j < n) { if (code[j] === '\\') { j += 2; continue; } if (code[j] === c) { j++; break; } if (code[j] === '\n' && c !== '`') break; j++; }
        out += '<span class="tok-s">' + esc(code.slice(i, j)) + '</span>'; i = j; continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        var k = i; while (k < n && /[A-Za-z0-9_$]/.test(code[k])) k++;
        var word = code.slice(i, k);
        if (map[word]) out += '<span class="tok-k">' + esc(word) + '</span>';
        else if (/^[A-Z]/.test(word) && word.length > 1) out += '<span class="tok-t">' + esc(word) + '</span>';
        else out += esc(word);
        i = k; continue;
      }
      if (/[0-9]/.test(c)) {
        var k2 = i; while (k2 < n && /[0-9a-fAxX._]/.test(code[k2])) k2++;
        out += '<span class="tok-n">' + esc(code.slice(i, k2)) + '</span>'; i = k2; continue;
      }
      out += esc(c); i++;
    }
    return out;
  }

  /* ---------------- document ---------------- */

  /* Full export: lay out, rasterise each page, wrap in a PDF. The page passes
   * its own DOM getters plus the source-to-HTML step for its file type. */
  function buildPdf(LV, fn) {
    var size = fn.paperMm(), m = fn.marginMm();
    var pageW = size.w * A4PX, pageH = size.h * A4PX, marginPx = m * A4PX, usableH = pageH - 2 * marginPx;
    var host = LV.host();
    host.innerHTML = '';
    var clone = document.createElement('div');
    clone.style.cssText = 'width:' + (pageW - 2 * marginPx) + 'px;background:#fff;color:#111;' + bodyCss(LV, false);
    clone.innerHTML = fn.decorate(fn.sourceHtml(LV.src().value, fn.opts()), false, LV);
    var frame = document.createElement('div');
    frame.style.cssText = 'width:' + pageW + 'px;padding:' + marginPx + 'px;background:#fff';
    frame.appendChild(clone);
    host.appendChild(frame);

    return loadImages(clone).then(function () {
      var plan = layoutPages(clone, usableH), count = plan.length;
      var scale = count > 120 ? 1.15 : count > 60 ? 1.4 : count > 24 ? 1.7 : 2.1;
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(pageW * scale);
      canvas.height = Math.round(pageH * scale);
      var ctx = canvas.getContext('2d');
      var title = LV.title().value.trim() || 'Document';
      var pages = [], step = Promise.resolve();
      for (var p = 0; p < count; p++) {
        step = step.then(function (pi) { return function () {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.save();
          ctx.scale(scale, scale);
          ctx.beginPath(); ctx.rect(0, marginPx, pageW, usableH); ctx.clip();
          ctx.translate(marginPx, marginPx);
          drawDom(ctx, clone, 0, 0, plan[pi]);
          ctx.restore();
          if (LV.mode() === 'print') {
            ctx.save();
            ctx.scale(scale, scale);
            ctx.fillStyle = '#7d8aa0';
            ctx.font = '8.5px system-ui,sans-serif';
            if (LV.opt('header').checked) {
              ctx.fillText(title, marginPx, marginPx - 7);
              var d = new Date().toLocaleDateString();
              ctx.fillText(d, pageW - marginPx - ctx.measureText(d).width, marginPx - 7);
              ctx.strokeStyle = '#e2e8f2'; ctx.lineWidth = 0.8;
              ctx.beginPath(); ctx.moveTo(marginPx, marginPx - 3.5); ctx.lineTo(pageW - marginPx, marginPx - 3.5); ctx.stroke();
            }
            ctx.fillText(LV.footer().value.trim() || title, marginPx, pageH - marginPx + 13);
            if (LV.opt('pageNumbers').checked) {
              var label = 'Page ' + (pi + 1) + ' / ' + count;
              ctx.fillText(label, pageW - marginPx - ctx.measureText(label).width, pageH - marginPx + 13);
            }
            ctx.restore();
          }
          return canvasToPdfImage(canvas).then(function (img) { pages.push(img); });
        }; }(p));
      }
      return step.then(function () {
        host.innerHTML = '';
        return wrapPdf(pages, size);
      });
    });
  }
  
  /* ---------------- PDF writing ---------------- */
  function sourceHtml(text, o, LV) {
    o = o || {};
    if (!text.trim()) return '<p style="color:#8894a8"><em>Nothing to convert yet — paste something on the left.</em></p>';
    if (o.type === 'html') return text;
    if (o.type === 'markdown') return markdownToHtml(text, o);
    if (o.type === 'code') return '<pre><code>' + (o.highlight ? highlightCode(text, (LV && LV.lang) ? LV.lang().value : 'auto') : esc(text)) + '</code></pre>';
    return text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map(function (p) { return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
  }
  function sanitizeHtml(html) {
    return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/<object[\s\S]*?<\/object>/gi, '').replace(/<embed[^>]*>/gi, '')
      .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '').replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
      .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '').replace(/javascript:/gi, '');
  }
  function paperMm(LV) {
    var p = PAPER[LV.paper().value] || PAPER.a4;
    return LV.ori() === 'landscape' ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
  }
  function marginMm(LV) {
    var m = Math.max(0, Number(LV.margin().value) || 0);
    return LV.mode() === 'pdf' ? m : Math.max(8, m);
  }
  function bodyCss(LV, extraMargin) {
    var font = LV.fontFamily().value === 'serif' ? 'Georgia,"Times New Roman",serif'
      : LV.fontFamily().value === 'mono' ? 'ui-monospace,Menlo,Consolas,monospace'
      : 'system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Sinhala",sans-serif';
    var fs = Number(LV.fontSize().value) || 11;
    return 'font:400 ' + fs + 'pt/' + (Number(LV.lineHeight().value) || 1.55) + ' ' + font + ';color:#111'
      + (extraMargin ? ';padding:' + marginMm(LV) + 'mm' : '');
  }
  function decorate(html, keepHeader, LV) {
    var title = LV.title().value.trim() || 'Document';
    var body = sanitizeHtml(html);
    if (LV.opt('avoidBreak').checked) {
      body = body.replace(/<pre/g, '<pre style="page-break-inside:avoid;break-inside:avoid"')
                 .replace(/<tr/g, '<tr style="page-break-inside:avoid;break-inside:avoid"')
                 .replace(/<img/g, '<img style="page-break-inside:avoid;break-inside:avoid"');
    }
    if (LV.opt('linkFootnotes').checked) {
      var links = [], seen = {};
      body.replace(/href="([^"]+)"/g, function (_, url) { if (/^https?:/i.test(url) && !seen[url]) { seen[url] = 1; links.push(url); } return _; });
      if (links.length) {
        body += '<hr><p style="font-size:.8em;color:#5d6b83;margin-top:14px"><strong>Links</strong></p><ol style="font-size:.8em;color:#2b3a52">'
          + links.map(function (u) { return '<li>' + esc(u) + '</li>'; }).join('') + '</ol>';
      }
    }
    var head = '';
    if (keepHeader && LV.mode() === 'print' && LV.opt('header').checked) {
      head = '<div class="dochead"><span>' + esc(title) + '</span><span>' + new Date().toLocaleDateString() + '</span></div>';
    }
    return head + body;
  }
  /* ---------------- PDF writing ---------------- */
  function canvasFont(cs) {
    var style = cs.fontStyle && cs.fontStyle !== 'normal' ? cs.fontStyle + ' ' : '';
    return style + (cs.fontWeight || '400') + ' ' + (cs.fontSize || '11pt') + ' ' + (cs.fontFamily || 'sans-serif');
  }
  function loadImages(root) {
    var imgs = Array.prototype.slice.call(root.querySelectorAll('img'));
    return Promise.all(imgs.map(function (img) {
      if (img.complete) return Promise.resolve();
      return new Promise(function (res) { img.onload = img.onerror = function () { res(); }; setTimeout(res, 4000); });
    }));
  }
  /* A small DOM -> canvas renderer, so the export needs no library and no
   * network. It covers what a printable document uses: headings, paragraphs,
   * lists, tables, code blocks, rules, quotes, images and inline styles. */
  function drawDom(ctx, root, ox, oy, plan) {
    ctx.fillStyle = '#111';
    ctx.textBaseline = 'alphabetic';
    var y = oy, maxW = root.clientWidth || 600;
    function fontOf(el) { return canvasFont(getComputedStyle(el)); }
    function cssPx(el, prop) { return parseFloat(getComputedStyle(el)[prop]) || 0; }
    function wrapRuns(runs, width) {
      var lines = [[]], cur = 0;
      runs.forEach(function (run) {
        ctx.font = run.font;
        run.text.split(/(\s+)/).forEach(function (word) {
          if (!word) return;
          var ww = ctx.measureText(word).width;
          if (cur + ww > width && word.trim()) { lines.push([]); cur = 0; }
          var last = lines[lines.length - 1];
          if (last.length && last[last.length - 1].font === run.font && word !== '\n') last[last.length - 1].text += word;
          else last.push({ text: word, font: run.font, color: run.color });
          cur += ww;
        });
      });
      return lines;
    }
    function collectRuns(node, parentFont, parentColor, bold, italic) {
      var runs = [];
      Array.prototype.forEach.call(node.childNodes, function (n) {
        if (n.nodeType === 3) {
          var f = parentFont;
          if (bold) f = f.replace(/\b([1-9]00)\b/, function (m) { return String(Math.min(900, Number(m) + 200)); });
          if (italic) f = 'italic ' + f.replace(/^italic /, '');
          runs.push({ text: n.nodeValue.replace(/\s+/g, ' '), font: f, color: parentColor });
          return;
        }
        if (n.nodeType !== 1) return;
        var tag = n.tagName.toLowerCase();
        if (tag === 'br') { runs.push({ text: '\n', font: parentFont, color: parentColor }); return; }
        if (tag === 'script' || tag === 'style') return;
        var cs = getComputedStyle(n);
        if (cs.display === 'none') return;
        if (tag === 'img') { runs.push({ image: n, font: parentFont, color: parentColor }); return; }
        var f2 = canvasFont(cs), c2 = cs.color || parentColor;
        if (tag === 'code' || tag === 'kbd' || tag === 'samp') f2 = (italic ? 'italic ' : '') + '400 ' + cs.fontSize + ' ui-monospace,Menlo,Consolas,monospace';
        runs = runs.concat(collectRuns(n, f2, c2, bold || Number(cs.fontWeight) >= 600, italic || cs.fontStyle === 'italic'));
      });
      return runs;
    }
    function drawLines(lines, startY, lineH, leftPad) {
      lines.forEach(function (line, li) {
        var x = ox + leftPad;
        line.forEach(function (r) {
          if (r.text === '\n') return;
          ctx.font = r.font; ctx.fillStyle = r.color || '#111';
          ctx.fillText(r.text, x, startY + lineH * 0.8 + li * lineH);
          x += ctx.measureText(r.text).width;
        });
      });
    }
    function drawBlock(el, startY, preRange) {
      var tag = el.tagName.toLowerCase(), cs = getComputedStyle(el);
      if (cs.display === 'none') return;
      y = typeof startY === 'number' ? startY : y;
      var mt = typeof startY === 'number' ? 0 : cssPx(el, 'marginTop');
      var mb = cssPx(el, 'marginBottom'), ml = cssPx(el, 'marginLeft');
      if (tag === 'hr') {
        y += mt;
        ctx.strokeStyle = '#dbe2ee'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(ox, y + 0.5); ctx.lineTo(ox + maxW, y + 0.5); ctx.stroke();
        y += 8 + mb; return;
      }
      if (tag === 'img') {
        y += mt;
        try {
          var w = Math.min(el.naturalWidth || (maxW - ml), maxW - ml);
          var ratio = el.naturalWidth ? el.naturalHeight / el.naturalWidth : 0.6;
          ctx.drawImage(el, ox + ml, y, w, w * ratio);
          y += w * ratio + mb;
        } catch (_) {}
        return;
      }
      if (tag === 'pre') {
        y += mt || 4;
        var text = (el.innerText || '').replace(/\t/g, '  ');
        var fs = parseFloat(cs.fontSize) || 10, lh = fs * 1.45;
        ctx.font = '400 ' + fs + 'px ui-monospace,Menlo,Consolas,monospace';
        var raw = text.split('\n');
        if (preRange) raw = raw.slice(preRange[0], preRange[1]);
        var pad = 8, wrapped = [];
        raw.forEach(function (line) {
          if (!line) { wrapped.push(''); return; }
          var cur = '';
          line.split(/(\s+)/).forEach(function (wd) {
            if (ctx.measureText(cur + wd).width > maxW - 2 * pad - ml && cur.trim()) { wrapped.push(cur); cur = wd; }
            else cur += wd;
          });
          wrapped.push(cur);
        });
        var boxH = wrapped.length * lh + 2 * pad;
        ctx.fillStyle = '#f4f6fa'; ctx.fillRect(ox + ml, y, maxW - ml, boxH);
        ctx.strokeStyle = '#dfe5ef'; ctx.lineWidth = 1; ctx.strokeRect(ox + ml + 0.5, y + 0.5, maxW - ml - 1, boxH - 1);
        ctx.fillStyle = '#1c2637'; ctx.font = '400 ' + fs + 'px ui-monospace,Menlo,Consolas,monospace';
        wrapped.forEach(function (line, i) { ctx.fillText(line, ox + ml + pad, y + pad + lh * (i + 0.78)); });
        y += boxH + mb + 6; return;
      }
      if (tag === 'table') {
        y += mt;
        var rows = Array.prototype.slice.call(el.querySelectorAll('tr')), cols = 0;
        rows.forEach(function (r) { cols = Math.max(cols, r.children.length); });
        var colW = (maxW - ml) / Math.max(1, cols);
        var fsT = parseFloat(cs.fontSize) || 11;
        rows.forEach(function (r) {
          var cells = Array.prototype.slice.call(r.children);
          var linesNeeded = 1;
          cells.forEach(function (c) {
            ctx.font = (Number(getComputedStyle(c).fontWeight) >= 600 ? '600 ' : '400 ') + fsT + 'px system-ui,sans-serif';
            linesNeeded = Math.max(linesNeeded, Math.ceil(ctx.measureText(c.innerText || '').width / (colW - 12)));
          });
          var rowH = linesNeeded * 15 + 10;
          if (r.querySelector('th')) { ctx.fillStyle = '#f1f5fb'; ctx.fillRect(ox + ml, y, maxW - ml, rowH); }
          ctx.strokeStyle = '#cfd8e6'; ctx.lineWidth = 1;
          ctx.strokeRect(ox + ml + 0.5, y + 0.5, maxW - ml - 1, rowH - 1);
          cells.forEach(function (c, ci) {
            var boldT = Number(getComputedStyle(c).fontWeight) >= 600;
            ctx.font = (boldT ? '600 ' : '400 ') + fsT + 'px system-ui,sans-serif';
            ctx.fillStyle = '#111';
            ctx.fillText((c.innerText || '').slice(0, 120), ox + ml + ci * colW + 6, y + 16);
            if (ci < cells.length - 1) {
              ctx.beginPath(); ctx.moveTo(ox + ml + (ci + 1) * colW + 0.5, y); ctx.lineTo(ox + ml + (ci + 1) * colW + 0.5, y + rowH); ctx.stroke();
            }
          });
          y += rowH;
        });
        y += mb; return;
      }
      if (tag === 'ul' || tag === 'ol') {
        y += mt;
        var idx = 1;
        Array.prototype.forEach.call(el.children, function (li) {
          if (li.tagName.toLowerCase() !== 'li') return;
          var bullet = tag === 'ol' ? (idx++) + '.' : '•', indent = 18;
          var lines = wrapRuns(collectRuns(li, fontOf(li), '#111', false, false), maxW - ml - indent);
          ctx.font = '400 ' + (parseFloat(cs.fontSize) || 11) + 'px system-ui,sans-serif';
          ctx.fillStyle = '#111';
          ctx.fillText(bullet, ox + ml, y + 14);
          drawLines(lines, y, 17, indent + ml);
          y += Math.max(1, lines.length) * 17 + 2;
        });
        y += mb + 2; return;
      }
      if (tag === 'blockquote') {
        y += mt;
        var qLines = wrapRuns(collectRuns(el, fontOf(el), '#41506a', false, true), maxW - ml - 14);
        ctx.fillStyle = '#c7d3e6'; ctx.fillRect(ox + ml, y, 3, qLines.length * 18 + 4);
        drawLines(qLines, y, 18, 14 + ml);
        y += qLines.length * 18 + 6 + mb; return;
      }
      y += mt;
      var runs2 = collectRuns(el, fontOf(el), '#111', false, false);
      if (!runs2.length) { y += mb; return; }
      var fs2 = parseFloat(cs.fontSize) || 15;
      var lineH = parseFloat(cs.lineHeight) || fs2 * 1.55;
      var lines2 = wrapRuns(runs2, maxW - ml);
      drawLines(lines2, y, lineH, ml);
      y += lines2.length * lineH + mb;
    }
    if (plan) {
      plan.forEach(function (item) { drawBlock(item.el, oy + item.y, item.preRange || null); });
      return;
    }
    Array.prototype.forEach.call(root.children, function (el) { drawBlock(el); });
  }
  /* Page plan from the real DOM heights: breaks land between blocks, and code
   * blocks taller than a page are split at their own line boundaries. */
  function layoutPages(root, usableH) {
    var blocks = Array.prototype.slice.call(root.children), pages = [], page = [], y = 0, pageH = usableH;
    function newPage() { if (page.length) pages.push(page); page = []; y = 0; }
    blocks.forEach(function (el) {
      var cs = getComputedStyle(el);
      if (cs.display === 'none') return;
      var mt = parseFloat(cs.marginTop) || 0, mb = parseFloat(cs.marginBottom) || 0;
      var h = el.getBoundingClientRect().height || 18, total = mt + h + mb;
      if (el.tagName === 'PRE' && total > pageH * 0.92) {
        var lines = (el.innerText || '').split('\n');
        var approxLine = Math.max(10, h / Math.max(1, lines.length));
        var perPage = Math.max(4, Math.floor((pageH - 8) / approxLine) - 2);
        for (var i = 0; i < lines.length; i += perPage) {
          if (y + 60 > pageH) newPage();
          page.push({ el: el, y: y, preRange: [i, Math.min(lines.length, i + perPage)] });
          y += Math.min(perPage, lines.length - i) * approxLine + 14;
          if (y + 40 > pageH) newPage();
        }
        y += mb;
        return;
      }
      if (y > 0 && y + total > pageH) newPage();
      if (total > pageH) { page.push({ el: el, y: y }); newPage(); return; }
      page.push({ el: el, y: y + mt });
      y += total;
    });
    if (page.length) pages.push(page);
    return pages.length ? pages : [[]];
  }
  /* Canvas -> PDF image: pixels are filtered (Up predictor) and deflated with
   * the built-in CompressionStream, which keeps text lossless and the file
   * small. A JPEG is used when CompressionStream is missing. */
  function canvasToPdfImage(canvas) {
    if (typeof CompressionStream === 'undefined') {
      return Promise.resolve({ bytes: binaries(atob(canvas.toDataURL('image/jpeg', 0.92).split(',')[1])), filter: '/DCTDecode', parms: '', w: canvas.width, h: canvas.height });
    }
    var w = canvas.width, h = canvas.height;
    var data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    var rowLen = w * 3 + 1;
    var raw = new Uint8Array(rowLen * h), prev = new Uint8Array(w * 3);
    for (var y2 = 0; y2 < h; y2++) {
      var off = y2 * rowLen, s0 = y2 * w * 4;
      raw[off] = 2;
      for (var x = 0; x < w; x++) {
        var i = s0 + x * 4, o = off + 1 + x * 3, p3 = x * 3;
        var r = data[i], g = data[i + 1], b = data[i + 2];
        raw[o] = (r - prev[p3]) & 255; raw[o + 1] = (g - prev[p3 + 1]) & 255; raw[o + 2] = (b - prev[p3 + 2]) & 255;
        prev[p3] = r; prev[p3 + 1] = g; prev[p3 + 2] = b;
      }
    }
    var stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Response(stream).arrayBuffer().then(function (ab) {
      var packed = new Uint8Array(ab);
      if (packed[0] !== 0x78) {
        // raw deflate: wrap it in the zlib container PDF expects
        var a = 1, b2 = 0;
        for (var k = 0; k < raw.length; k++) { a = (a + raw[k]) % 65521; b2 = (b2 + a) % 65521; }
        var adler = ((b2 << 16) | a) >>> 0;
        var out = new Uint8Array(packed.length + 6);
        out[0] = 0x78; out[1] = 0x9c; out.set(packed, 2);
        out[packed.length + 2] = (adler >>> 24) & 255; out[packed.length + 3] = (adler >>> 16) & 255;
        out[packed.length + 4] = (adler >>> 8) & 255; out[packed.length + 5] = adler & 255;
        packed = out;
      }
      return { bytes: packed, filter: '/FlateDecode', parms: ' /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ' + w + ' >>', w: w, h: h };
    });
  }
  function wrapPdf(images, size) {
    var mmToPt = 72 / 25.4, wPt = size.w * mmToPt, hPt = size.h * mmToPt;
    var objs = [], pageIds = [];
    objs[1] = { dict: '<< /Type /Catalog /Pages 2 0 R >>' };
    objs[2] = { dict: null };
    for (var i = 0; i < images.length; i++) {
      var base = 3 + i * 3, pageId = base, contentId = base + 1, imgId = base + 2;
      var ops = 'q ' + wPt.toFixed(2) + ' 0 0 ' + hPt.toFixed(2) + ' 0 0 cm /Im0 Do Q';
      objs[pageId] = { dict: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + wPt.toFixed(2) + ' ' + hPt.toFixed(2) + '] /Resources << /XObject << /Im0 ' + imgId + ' 0 R >> /ProcSet [/PDF /ImageC] >> /Contents ' + contentId + ' 0 R >>' };
      objs[contentId] = { dict: '<< /Length ' + ops.length + ' >>', stream: binaries(ops) };
      var im = images[i];
      objs[imgId] = { dict: '<< /Type /XObject /Subtype /Image /Width ' + im.w + ' /Height ' + im.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ' + im.filter + (im.parms || '') + ' /Length ' + im.bytes.length + ' >>', stream: im.bytes };
      pageIds.push(pageId);
    }
    objs[2].dict = '<< /Type /Pages /Count ' + pageIds.length + ' /Kids [' + pageIds.map(function (id) { return id + ' 0 R'; }).join(' ') + '] >>';
    var chunks = [], pos = 0, offsets = [];
    function pushStr(s2) { chunks.push(s2); pos += s2.length; }
    function pushBytes(arr) { chunks.push(arr); pos += arr.length; }
    pushStr('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    for (var id = 1; id < objs.length; id++) {
      var o = objs[id];
      offsets[id] = pos;
      if (o.stream) { pushStr(id + ' 0 obj\n' + o.dict + '\nstream\n'); pushBytes(o.stream); pushStr('\nendstream\nendobj\n'); }
      else pushStr(id + ' 0 obj\n' + o.dict + '\nendobj\n');
    }
    var xrefPos = pos, xref = 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n';
    for (var k = 1; k < objs.length; k++) xref += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
    pushStr(xref);
    pushStr('trailer\n<< /Size ' + objs.length + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n');
    return new Blob(chunks.map(function (c) { return typeof c === 'string' ? binaries(c) : c; }), { type: 'application/pdf' });
  }
  global.SingVazaPDF = {
    esc: esc, binaries: binaries, markdownToHtml: markdownToHtml, inlineMd: inlineMd,
    highlightCode: highlightCode, detectLang: detectLang, sourceHtml: sourceHtml,
    sanitizeHtml: sanitizeHtml, bodyCss: bodyCss, paperMm: paperMm, marginMm: marginMm,
    decorate: decorate, drawDom: drawDom, layoutPages: layoutPages,
    canvasToPdfImage: canvasToPdfImage, wrapPdf: wrapPdf, buildPdf: buildPdf, loadImages: loadImages,
  };
})(window);
