/*!
 * SingVaza tour — a calm, app-style walkthrough: a spotlight, a walking arrow
 * and one short card at a time. Used by every /studio tool.
 *
 *   SingVazaTour.start([{el, title, text, place}, ...], { key: 'singvaza-tour-x', auto: true })
 *
 * The CSS lives here too, so a page only needs one <script> tag. It never
 * blocks the page: Skip, Esc, or the last step closes it, and it is remembered.
 */
(function (root) {
  'use strict';
  var STYLE_ID = 'sv-tour-style';
  var CSS = [
    '#tourLayer{position:fixed;inset:0;z-index:90;display:none;pointer-events:none;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Sinhala",sans-serif}',
    '#tourLayer.on{display:block}',
    '#tourSpot{position:fixed;border:2px solid #f2a93b;border-radius:10px;box-shadow:0 0 0 9999px rgba(6,6,6,.74);transition:all .25s ease;pointer-events:none}',
    '#tourCard{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;width:min(480px,calc(100% - 24px));background:#1d1d1d;border:1px solid #3d3d3d;border-radius:14px;padding:14px 14px 12px;box-shadow:0 18px 50px rgba(0,0,0,.6);pointer-events:auto;color:#ededed}',
    '#tourCard h4{margin:0 0 5px;font-size:14.5px;color:#ededed;display:flex;align-items:center;gap:8px;line-height:1.3}',
    '#tourCard h4 .step{font-size:10.5px;font-weight:800;color:#f2a93b;letter-spacing:.1em;white-space:nowrap;flex:none}',
    '#tourCard p{margin:0 0 10px;font-size:12.5px;line-height:1.55;color:#a3a3a3}',
    '#tourCard .row{display:flex;align-items:center;gap:7px}',
    '#tourCard .row .spacer{flex:1}',
    '#tourCard button{border:1px solid #3d3d3d;background:#262626;color:#ededed;border-radius:9px;padding:8px 12px;font-size:12.5px;font-weight:700;cursor:pointer}',
    '#tourCard button:disabled{opacity:.4;cursor:default}',
    '#tourCard button.go{background:linear-gradient(180deg,#f6bd63,#e39422);color:#1b1207;border-color:#e39422}',
    '#tourCard button.skip{background:transparent;border-color:transparent;color:#a3a3a3}',
    '#tourArrow{position:fixed;width:74px;height:74px;margin:-37px 0 0 -37px;pointer-events:none;transition:all .25s ease;filter:drop-shadow(0 4px 10px rgba(0,0,0,.5))}',
    '#tourArrow svg{width:100%;height:100%;stroke:#f2a93b;fill:none;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}',
    '#tourArrow .pulse{animation:svTourPulse 1.1s ease-in-out infinite;transform-origin:50% 50%}',
    '@keyframes svTourPulse{0%,100%{transform:scale(1);opacity:.95}50%{transform:scale(1.09);opacity:1}}',
    '#tourStart{position:fixed;right:12px;bottom:12px;z-index:60;display:flex;align-items:center;gap:7px;border:1px solid #4a4a4a;background:#222;color:#ededed;border-radius:999px;padding:9px 14px;font-size:12.5px;font-weight:800;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.45);font-family:inherit}',
    '#tourStart:hover{background:#2c2c2c}',
    '#tourStart svg{width:16px;height:16px;stroke:#f2a93b;fill:none;stroke-width:2.2}',
    '@media(max-width:520px){#tourCard{bottom:10px;padding:12px}#tourArrow{width:60px;height:60px;margin:-30px 0 0 -30px}}'
  ].join('\n');

  var steps = [], index = 0, storageKey = 'singvaza-tour', layer, spot, arrow, card;

  function inject() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  function build() {
    if (layer) return;
    layer = document.createElement('div');
    layer.id = 'tourLayer';
    layer.setAttribute('aria-live', 'polite');
    layer.innerHTML = '<div id="tourSpot"></div>'
      + '<div id="tourArrow"><svg viewBox="0 0 64 64"><g class="pulse"><path d="M8 52C16 28 32 16 54 14"/><path d="M42 9l12 5-5 12"/></g></svg></div>'
      + '<div id="tourCard" role="dialog" aria-label="Guided tour"><h4><span class="step" id="tourStep">1</span><span id="tourTitle"></span></h4>'
      + '<p id="tourText"></p><div class="row"><button class="skip" id="tourSkip">Skip</button><span class="spacer"></span>'
      + '<button id="tourBack">Back</button><button class="go" id="tourNext">Next</button></div></div>';
    document.body.appendChild(layer);
    spot = layer.querySelector('#tourSpot');
    arrow = layer.querySelector('#tourArrow');
    card = layer.querySelector('#tourCard');
    layer.querySelector('#tourNext').addEventListener('click', next);
    layer.querySelector('#tourBack').addEventListener('click', prev);
    layer.querySelector('#tourSkip').addEventListener('click', function () { stop(true); });
    document.addEventListener('keydown', function (e) {
      if (!isOpen()) return;
      if (e.key === 'Escape') stop(true);
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      else if (e.key === 'ArrowLeft') prev();
    });
    window.addEventListener('resize', function () { if (isOpen()) show(index); });
  }
  function isOpen() { return layer && layer.classList.contains('on'); }
  function box(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return (r.width && r.height) ? r : null;
  }
  function show(i, secondPass) {
    index = Math.max(0, Math.min(steps.length - 1, i));
    var step = steps[index] || {};
    var el = typeof step.el === 'string' ? document.querySelector(step.el) : step.el;
    var r = box(el);
    // the panels are wider than a phone screen: slide the target into view first
    if (r && !secondPass && (r.left < 8 || r.right > window.innerWidth - 8)) {
      if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'center' });
      setTimeout(function () { show(i, true); }, 260);
      return;
    }
    layer.querySelector('#tourStep').textContent = (index + 1) + ' / ' + steps.length;
    layer.querySelector('#tourTitle').textContent = step.title || '';
    layer.querySelector('#tourText').textContent = step.text || '';
    var back = layer.querySelector('#tourBack');
    back.disabled = index === 0;
    layer.querySelector('#tourNext').textContent = index === steps.length - 1 ? (step.done || 'Done') : (step.next || 'Next');
    if (!r) { spot.style.opacity = '0'; arrow.style.opacity = '0'; return; }
    spot.style.opacity = '1'; arrow.style.opacity = '1';
    var pad = 6, vw = window.innerWidth, vh = window.innerHeight;
    // a panel can be wider than a phone screen: spotlight only the part you can see
    var left = Math.max(4, r.left - pad), right = Math.min(vw - 4, r.right + pad);
    var top = Math.max(4, r.top - pad), bottom = Math.min(vh - 4, r.bottom + pad);
    spot.style.left = left + 'px';
    spot.style.top = top + 'px';
    spot.style.width = Math.max(24, right - left) + 'px';
    spot.style.height = Math.max(24, bottom - top) + 'px';
    var cx = (left + right) / 2, cy = top + Math.min((bottom - top) / 2, 170);
    var ax = cx, ay = cy;
    if (step.place === 'right') { ax = right + 44; ay = cy; }
    else if (step.place === 'left') { ax = left - 44; ay = cy; }
    else if (step.place === 'bottom') { ax = cx; ay = bottom + 44; }
    else if (step.place === 'top') { ax = cx; ay = top - 44; }
    ax = Math.max(46, Math.min(window.innerWidth - 46, ax));
    ay = Math.max(46, Math.min(window.innerHeight - 46, ay));
    arrow.style.left = ax + 'px';
    arrow.style.top = ay + 'px';
    var angle = Math.atan2(cy - ay, cx - ax) * 180 / Math.PI + 45;
    arrow.style.transform = 'rotate(' + angle + 'deg)';
  }
  function next() {
    if (index >= steps.length - 1) { stop(true); return; }
    show(index + 1);
  }
  function prev() { show(index - 1); }
  function start(list, opts) {
    opts = opts || {};
    if (!list || !list.length) return;
    inject(); build();
    steps = list;
    storageKey = opts.key || storageKey;
    if (!opts.restart) {
      var btn = document.getElementById('tourStart');
      if (btn && btn.style.display === 'none') btn.style.display = '';
    }
    layer.classList.add('on');
    var startBtn = document.getElementById('tourStart');
    if (startBtn) startBtn.style.display = 'none';
    show(0);
  }
  function stop(remember) {
    if (!layer) return;
    layer.classList.remove('on');
    var btn = document.getElementById('tourStart');
    if (btn) btn.style.display = '';
    if (remember) { try { localStorage.setItem(storageKey, '1'); } catch (e) {} }
  }
  /* wraps an existing "How it works" button, and opens the tour once for a new visitor */
  function wire(list, opts) {
    opts = opts || {};
    inject();
    var key = opts.key || storageKey;
    var btn = document.getElementById('tourStart');
    if (btn) btn.addEventListener('click', function () { start(list, { key: key, restart: true }); });
    var seen = false;
    try { seen = !!localStorage.getItem(key); } catch (e) {}
    if (opts.auto !== false && !seen) {
      setTimeout(function () { if (!isOpen()) start(list, { key: key }); }, opts.delay || 800);
    }
  }

  root.SingVazaTour = { start: start, stop: stop, wire: wire, steps: function (l) { steps = l; } };
})(typeof window !== 'undefined' ? window : this);
