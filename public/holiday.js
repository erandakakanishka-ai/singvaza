/* Seasonal decoration for SingVaza.
 *
 * The calendar lives on the server (src/holidays.ts); this file only asks "is
 * today a holiday?" using the VISITOR'S date, then paints a greeting bar, a small
 * scene, and (when the season grants it) a claimable Pro week.
 *
 * Rules it follows:
 *   - decoration only: nothing about the page's layout, colours or text changes;
 *   - anything it adds can be closed, and stays closed for that session;
 *   - it removes itself completely when the season is over — no state to clean up;
 *   - it never runs twice, never blocks the page, and respects reduced-motion.
 */
(function () {
  'use strict';
  if (window.__svHolidayLoaded) return;
  window.__svHolidayLoaded = true;

  var STORE_KEY = 'sv_holiday_seen';
  var CLOSED_KEY = 'sv_holiday_closed';
  var THEME_DARK_FALLBACK = '#0f1523';

  function todayLocal() {
    var now = new Date();
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  }

  function el(tag, css, html) {
    var node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function closedThisSession(windowId) {
    try { return sessionStorage.getItem(CLOSED_KEY) === windowId; } catch (_) { return false; }
  }

  function markClosed(windowId) {
    try { sessionStorage.setItem(CLOSED_KEY, windowId); } catch (_) {}
  }

  function queryPreview() {
    try {
      var params = new URLSearchParams(location.search);
      var id = params.get('holiday_preview') || '';
      if (!id) return '';
      // The link carries its own expiry and signature; pass them straight through,
      // the server decides whether they are real.
      return '&preview=' + encodeURIComponent(id) +
        '&hp=' + encodeURIComponent(params.get('hp') || '') +
        '&hs=' + encodeURIComponent(params.get('hs') || '');
    } catch (_) { return ''; }
  }

  // ---------------------------------------------------------------- effects

  /** All the animation lives in one style tag, added once. */
  function ensureStyles() {
    if (document.getElementById('sv-holiday-style')) return;
    var style = document.createElement('style');
    style.id = 'sv-holiday-style';
    style.textContent =
      '@keyframes sv-fall{0%{transform:translate3d(0,-12vh,0)}100%{transform:translate3d(var(--drift,0),112vh,0)}}' +
      '@keyframes sv-sway{0%,100%{transform:translateX(-5px) rotate(-2deg)}50%{transform:translateX(5px) rotate(2deg)}}' +
      '@keyframes sv-twin{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:1;transform:scale(1.4)}}' +
      '@keyframes sv-spark{0%{transform:scale(.15) rotate(var(--rot,0deg)) translateY(-26px);opacity:0}18%{opacity:1}100%{transform:scale(1.9) rotate(var(--rot,0deg)) translateY(-26px);opacity:0}}' +
      '@keyframes sv-fade{0%,12%{opacity:0}22%{opacity:1}70%{opacity:.55}100%{opacity:0}}' +
      '@media (prefers-reduced-motion: reduce){.sv-flake,.sv-twin,.sv-burst,.sv-spark{animation:none!important;opacity:.55!important}}';
    document.head.appendChild(style);
  }

  function seedRandom(seed) {
    var s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  }

  /** Snow: a fixed layer of falling flakes over the whole page. The flakes carry a
   *  soft blue shadow so they are visible on the light theme as well as the dark
   *  one, and the layer never takes a tap. */
  function snowScene(accent) {
    ensureStyles();
    var count = window.innerWidth < 480 ? 46 : 70;
    var layer = el('div', 'position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:2147483000;');
    layer.setAttribute('aria-hidden', 'true');
    layer.className = 'sv-holiday-layer';
    var rand = seedRandom(20261225);
    for (var i = 0; i < count; i += 1) {
      var size = 2.5 + rand() * 5;
      var flake = el('span', [
        'position:absolute',
        'top:-8vh',
        'left:' + (rand() * 100).toFixed(2) + '%',
        'width:' + size.toFixed(1) + 'px',
        'height:' + size.toFixed(1) + 'px',
        'border-radius:50%',
        'background:#fff',
        'box-shadow:0 0 ' + (3 + size).toFixed(0) + 'px ' + (accent || '#bbf7d0') + ', 0 0 2px rgba(56,189,248,.75)',
        'opacity:' + (0.5 + rand() * 0.45).toFixed(2),
        '--drift:' + (rand() * 70 - 35).toFixed(1) + 'px',
        'animation:sv-fall ' + (7 + rand() * 10).toFixed(1) + 's linear ' + (-rand() * 14).toFixed(1) + 's infinite',
      ].join(';') + ';');
      flake.className = 'sv-flake';
      layer.appendChild(flake);
    }
    document.body.appendChild(layer);
    return layer;
  }

  /** A string of little lights under the greeting bar. */
  function lightsScene(accent) {
    var row = el('div', 'display:flex;justify-content:center;gap:7px;padding:0 0 2px;pointer-events:none;');
    row.setAttribute('aria-hidden', 'true');
    var colors = ['#f87171', '#fbbf24', '#34d399', '#60a5fa', '#f472b6'];
    for (var i = 0; i < 18; i += 1) {
      var bulb = el('span', [
        'width:6px', 'height:6px', 'border-radius:50%',
        'background:' + colors[i % colors.length],
        'box-shadow:0 0 6px ' + colors[i % colors.length],
        'opacity:.85',
        'animation:sv-sway ' + (2 + (i % 5) * 0.4) + 's ease-in-out infinite',
      ].join(';'));
      row.appendChild(bulb);
    }
    return row;
  }

  /** Fireworks: a handful of small bursts that spark out and fade, high on the page. */
  function fireworksScene() {
    var layer = el('div', 'position:fixed;top:0;left:0;right:0;height:46vh;pointer-events:none;overflow:hidden;z-index:2147483000;');
    layer.setAttribute('aria-hidden', 'true');
    layer.className = 'sv-holiday-layer';
    ensureStyles();
    var rand = seedRandom(20270101);
    var colors = ['#fbbf24', '#f87171', '#60a5fa', '#34d399', '#f472b6'];
    for (var i = 0; i < 5; i += 1) {
      var color = colors[i % colors.length];
      var burst = el('div', [
        'position:absolute',
        'top:' + (8 + rand() * 22).toFixed(1) + '%',
        'left:' + (14 + rand() * 70).toFixed(1) + '%',
        'width:0', 'height:0',
        'animation:sv-fade ' + (6.5 + rand() * 2).toFixed(1) + 's ease-out ' + (i * 1.4).toFixed(1) + 's infinite',
      ].join(';'));
      burst.className = 'sv-burst';
      for (var k = 0; k < 12; k += 1) {
        var dot = el('span', [
          'position:absolute',
          'width:3px', 'height:3px', 'margin:-1.5px',
          'border-radius:50%',
          'background:' + color,
          'box-shadow:0 0 7px ' + color,
          '--rot:' + (k * 30) + 'deg',
          'animation:sv-spark ' + (1.7 + rand() * 0.5).toFixed(1) + 's ease-out ' + (k * 0.02).toFixed(2) + 's infinite',
        ].join(';'));
        dot.className = 'sv-spark';
        burst.appendChild(dot);
      }
      layer.appendChild(burst);
    }
    document.body.appendChild(layer);
    return layer;
  }

  /** Lanterns / diyas: small warm lights hanging down from the top edge. */
  function lanternsScene(accent, diyas) {
    var layer = el('div', 'position:fixed;top:0;left:0;right:0;pointer-events:none;z-index:2147483000;display:flex;justify-content:space-around;');
    layer.className = 'sv-holiday-layer';
    layer.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 7; i += 1) {
      var drop = el('span', [
        'font-size:' + (14 + (i % 3) * 5) + 'px',
        'opacity:.9',
        'filter:drop-shadow(0 0 8px ' + accent + ')',
        'transform-origin:top center',
        'animation:sv-sway ' + (3 + i * 0.35).toFixed(1) + 's ease-in-out infinite',
      ].join(';'), diyas ? '🪔' : '🏮');
      layer.appendChild(drop);
    }
    document.body.appendChild(layer);
    return layer;
  }

  function buntingScene(accent) {
    var row = el('div', 'display:flex;justify-content:center;gap:10px;pointer-events:none;', '');
    row.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 9; i += 1) row.appendChild(el('span', 'font-size:15px;opacity:.9;color:' + accent + ';', '◆'));
    return row;
  }

  // ---------------------------------------------------------------- greeting

  function greetingBar(data, onClose) {
    var dark = data.effect === 'fireworks';
    var bar = el('div', 'position:relative;z-index:2147482000;overflow:hidden;' +
      'background:linear-gradient(100deg,' + data.colors.from + ' 0%,' + data.colors.to + ' 100%);' +
      'color:#fff;font:600 13.5px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;');
    bar.id = 'sv-holiday-bar';
    bar.setAttribute('role', 'status');

    var row = el('div', 'position:relative;display:flex;align-items:center;justify-content:center;gap:11px;' +
      'padding:14px 46px 10px 14px;text-align:center;');
    row.innerHTML = '<span aria-hidden="true" style="font-size:23px;line-height:1;filter:drop-shadow(0 0 10px rgba(255,255,255,.45));">' + data.emoji + '</span>' +
      '<span style="min-width:0;">' +
      '<span style="display:block;font-size:15px;font-weight:800;letter-spacing:.02em;">' + escapeText(data.greeting) + '</span>' +
      '<span style="display:block;font-size:12px;font-weight:500;opacity:.92;margin-top:2px;">' + escapeText(data.subline) + '</span>' +
      '</span>';
    bar.appendChild(row);

    // A little scene under the words: fairy lights for Christmas, lanterns for the
    // lantern festivals, nothing heavy for the rest.
    if (data.effect === 'snow' || data.effect === 'lights') bar.appendChild(stringLights(data.colors.accent));
    else if (data.effect === 'lanterns') bar.appendChild(lanternsScene(data.colors.accent, false));
    else if (data.effect === 'diyas') bar.appendChild(lanternsScene(data.colors.accent, true));
    else if (data.effect === 'bunting') bar.appendChild(buntingScene(data.colors.accent));

    // A soft glow at the top edge, so the bar reads as decoration and not as an ad.
    var glow = el('div', 'position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 90% at 50% -30%, rgba(255,255,255,.28), transparent 62%);');
    bar.appendChild(glow);

    var close = el('button', 'position:absolute;right:8px;top:50%;transform:translateY(-50%);background:rgba(0,0,0,.18);' +
      'border:0;border-radius:9px;color:#fff;font-size:17px;line-height:1;cursor:pointer;padding:7px 10px;', '×');
    close.id = 'sv-holiday-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close the greeting');
    close.onclick = function () {
      markClosed(data.id);
      bar.remove();
      if (onClose) onClose();
    };
    bar.appendChild(close);
    if (dark) bar.style.color = '#fff';
    return bar;
  }

  /** A string of fairy lights: a hanging wire with coloured bulbs that blink. */
  function stringLights(accent) {
    var wrap = el('div', 'position:relative;height:26px;overflow:hidden;pointer-events:none;');
    wrap.setAttribute('aria-hidden', 'true');
    var wire = el('div', 'position:absolute;left:-2%;right:-2%;top:9px;height:16px;' +
      'border-top:2px solid rgba(255,255,255,.45);border-radius:50%/100% 100% 0 0;');
    wrap.appendChild(wire);
    var colors = ['#fef08a', '#fca5a5', '#86efac', '#93c5fd', '#f9a8d4', accent || '#fde68a'];
    for (var i = 0; i < 14; i += 1) {
      var color = colors[i % colors.length];
      var left = (i / 13) * 100;
      var drop = (i % 2 === 0 ? 12 : 18) + (i % 3) * 3;
      var bulb = el('span', [
        'position:absolute',
        'left:' + left.toFixed(2) + '%',
        'top:' + drop + 'px',
        'width:5px', 'height:5px', 'border-radius:50%',
        'background:' + color,
        'box-shadow:0 0 8px 2px ' + color,
        'animation:sv-twin ' + (1.6 + (i % 5) * 0.35).toFixed(2) + 's ease-in-out ' + (i * 0.12).toFixed(2) + 's infinite',
      ].join(';'));
      wrap.appendChild(bulb);
    }
    return wrap;
  }

  function escapeText(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------------------------------------------------------------- pro week

  function authToken() {
    try { return localStorage.getItem('singvaza_token') || ''; } catch (_) { return ''; }
  }

  /** "Claim your free Christmas week" — only shown to a signed-in visitor who has
   *  not had this season's pass yet, and only inside the season. */
  function claimCard(data) {
    if (!data.proDays || !data.proLabel) return null;
    if (!authToken()) return null;
    var seenKey = 'sv_pro_claim_' + data.id;
    try { if (localStorage.getItem(seenKey) === 'done') return null; } catch (_) {}

    var card = el('div', 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483200;max-width:420px;margin:0 auto;' +
      'background:#0f1523;border:1px solid rgba(148,163,184,.32);border-radius:14px;padding:13px 14px;' +
      'box-shadow:0 18px 44px rgba(0,0,0,.55);color:#f8fafc;font:400 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;');
    card.setAttribute('role', 'dialog');
    card.id = 'sv-pro-claim';
    card.innerHTML = '<div style="display:flex;gap:10px;align-items:flex-start;">' +
      '<span aria-hidden="true" style="font-size:20px;">' + data.emoji + '</span>' +
      '<div style="flex:1;min-width:0;">' +
      '<strong style="display:block;font-size:13.5px;">Your free ' + escapeText(data.proLabel) + ' is ready</strong>' +
      '<span style="color:#94a3b8;">Signed in — claim ' + data.proDays + ' days of Pro, on us, for ' + escapeText(data.label) + '.</span>' +
      '<div style="display:flex;gap:8px;margin-top:9px;flex-wrap:wrap;">' +
      '<button type="button" id="sv-pro-claim-btn" style="border:0;border-radius:9px;padding:8px 13px;background:' + data.colors.accent + ';color:#111;font-weight:800;cursor:pointer;">Claim ' + data.proDays + ' days of Pro</button>' +
      '<button type="button" id="sv-pro-claim-later" style="border:1px solid rgba(148,163,184,.34);border-radius:9px;padding:8px 12px;background:transparent;color:#cbd5e1;cursor:pointer;">Later</button>' +
      '</div></div></div>';

    card.querySelector('#sv-pro-claim-later').onclick = function () {
      card.remove();
      try { sessionStorage.setItem('sv_pro_later', data.id); } catch (_) {}
    };
    if (data.preview) {
      // A preview must not hand out a real pass; say when the door opens instead.
      var previewBtn = card.querySelector('#sv-pro-claim-btn');
      previewBtn.textContent = 'Opens ' + data.startDate;
      previewBtn.disabled = true;
      previewBtn.style.opacity = '.65';
      previewBtn.style.cursor = 'default';
      var note = el('span', 'display:block;color:#94a3b8;margin-top:6px;font-size:12px;', 'This is a preview only — the free week starts on ' + data.startDate + '.');
      previewBtn.parentNode.parentNode.appendChild(note);
      card.querySelector('#sv-pro-claim-later').onclick = function () { card.remove(); };
      return;
    }
    card.querySelector('#sv-pro-claim-btn').onclick = function () {
      var button = card.querySelector('#sv-pro-claim-btn');
      button.disabled = true;
      button.textContent = 'Claiming…';
      fetch('/api/holidays/claim-pro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken() },
        body: JSON.stringify({ date: todayLocal() }),
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || 'Could not claim.');
        try { localStorage.setItem(seenKey, 'done'); } catch (_) {}
        card.innerHTML = '<div style="display:flex;gap:10px;align-items:center;">' +
          '<span aria-hidden="true" style="font-size:20px;">✓</span>' +
          '<div><strong style="display:block;">' + res.days + ' days of Pro added</strong>' +
          '<span style="color:#94a3b8;">Until ' + new Date(res.proUntil).toLocaleDateString() + '. Enjoy the season.</span></div></div>';
        setTimeout(function () { card.remove(); }, 6000);
        window.dispatchEvent(new CustomEvent('sv:pro-claimed', { detail: res }));
      }).catch(function (err) {
        button.disabled = false;
        button.textContent = 'Try again';
        var note = card.querySelector('#sv-pro-error');
        if (!note) {
          note = el('div', '', '');
          note.id = 'sv-pro-error';
          note.style.cssText = 'color:#f87171;margin-top:6px;';
          card.appendChild(note);
        }
        note.textContent = (err && err.message) || 'Could not claim, please try again later.';
      });
    };
    return card;
  }

  // ---------------------------------------------------------------- run

  function paint(data) {
    if (!data || !data.active) return;
    if (closedThisSession(data.id)) return;

    // The bar goes to the very top of the page, above the header: the page below
    // keeps its own layout, its own colours and its own navigation.
    var bar = greetingBar(data, function () { removeAll(); });
    if (document.getElementById('svEntryGate')) bar.style.zIndex = '2147483600';
    if (!document.body.firstChild) document.body.appendChild(bar);
    else document.body.insertBefore(bar, document.body.firstChild);

    // Falling snow stays for the whole Christmas week; fireworks for the New Year.
    if (data.effect === 'snow') snowScene(data.colors.accent);
    else if (data.effect === 'fireworks') fireworksScene();

    if (authToken()) {
      var card = claimCard(data);
      if (card) {
        try { if (sessionStorage.getItem('sv_pro_later') === data.id) card.style.display = 'none'; } catch (_) {}
        document.body.appendChild(card);
      }
    }
    try { sessionStorage.setItem(STORE_KEY, data.id); } catch (_) {}
  }

  function removeAll() {
    ['#sv-holiday-bar', '#sv-pro-claim'].forEach(function (selector) {
      var node = document.querySelector(selector);
      if (node) node.remove();
    });
    // The full-page effects are marked so closing the greeting also clears the
    // snow and the fireworks — one decision, the whole season off.
    document.querySelectorAll('.sv-holiday-layer').forEach(function (node) { node.remove(); });
  }

  function start() {
    if (document.getElementById('sv-holiday-bar')) return;
    var preview = queryPreview();
    var url = '/api/holidays/active?date=' + encodeURIComponent(todayLocal()) + preview;
    fetch(url, { headers: authToken() ? { Authorization: 'Bearer ' + authToken() } : {} })
      .then(function (r) { return r.json(); })
      .then(function (data) { paint(data); })
      .catch(function () { /* no decoration is better than a broken page */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
