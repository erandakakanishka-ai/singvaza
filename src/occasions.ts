/* Seasonal changes — the safe kind.
 *
 * The rule the operator asked for: a holiday may be marked, but the site must
 * never look redesigned. So a seasonal change is ONE slim bar, added after
 * <body> on pages the admin picked, and only inside a start/end date window.
 * Nothing is restyled, no page HTML is rewritten, and when the end date passes
 * the bar stops being injected by itself. Switch it off and the site is byte for
 * byte what it was. Everything here is pure so it can be tested without network. */

const OCCASION_PRESET_BASE = [
  { id: 'christmas', label: 'Christmas', monthDay: '12-20', endMonthDay: '12-27', emoji: '🎄', theme: 'celebration', title: 'Happy Christmas', message: 'Wishing you a calm, musical Christmas from everyone at SingVaza.' },
  { id: 'new-year', label: 'New Year', monthDay: '12-31', endMonthDay: '01-03', emoji: '🎆', theme: 'newyear', title: 'Happy New Year', message: 'A new year of songs starts tonight — thank you for being here.' },
  { id: 'sinhala-new-year', label: 'Sinhala & Tamil New Year', monthDay: '04-13', endMonthDay: '04-15', emoji: '🌅', theme: 'calm', title: 'සුබ අලුත් අවුරුද්දක්!', message: 'Suba Aluth Avuruddak — wishing you a peaceful new year with family.' },
  { id: 'vesak', label: 'Vesak', monthDay: '05-20', endMonthDay: '05-22', emoji: '🪷', theme: 'calm', title: 'සුබ වෙසක්!', message: 'Wishing you a peaceful Vesak full of light and kindness.' },
  { id: 'year-end-sale', label: 'Year end sale', monthDay: '12-28', endMonthDay: '12-30', emoji: '🎁', theme: 'celebration', title: 'A small gift', message: 'Every download is on us for the last days of the year.' },
];

/** Presets carry the coming year's dates, never a stale hard-coded year. The
 *  dates of lunar holidays (Vesak, the New Year) shift, so the admin confirms them. */
export function occasionPresets(today = new Date().toISOString().slice(0, 10)): any[] {
  const year = Number(today.slice(0, 4));
  return OCCASION_PRESET_BASE.map((p) => {
    let startYear = year;
    let start = `${startYear}-${p.monthDay}`;
    let end = `${startYear}-${p.endMonthDay}`;
    if (p.endMonthDay < p.monthDay) end = `${startYear + 1}-${p.endMonthDay}`;
    if (end < today) {
      startYear += 1;
      start = `${startYear}-${p.monthDay}`;
      end = `${startYear}-${p.endMonthDay}`;
      if (p.endMonthDay < p.monthDay) end = `${startYear + 1}-${p.endMonthDay}`;
    }
    return { id: p.id, label: p.label, emoji: p.emoji, theme: p.theme, title: p.title, message: p.message, startDate: start, endDate: end };
  });
}

/** Is the greeting bar inside its dates right now? Everything must be set. */
export function isOccasionActive(config: any, today = new Date().toISOString().slice(0, 10)): boolean {
  if (!config || config.enabled !== true) return false;
  if (!config.message) return false;
  if (!config.startDate || !config.endDate) return false;
  return today >= String(config.startDate) && today <= String(config.endDate);
}

/** A preview is only ever for someone allowed to see it (a signed-in admin, or a
 *  signed preview link they generated) and only for a finished, switched-on
 *  greeting. A public visitor with the query string alone gets nothing. */
export function isOccasionPreview(config: any, requested: boolean, allowed: boolean): boolean {
  if (!allowed || !requested) return false;
  return Boolean(config && config.enabled === true && config.message);
}

export function occasionAppliesTo(config: any, path: string): boolean {
  if (!config) return false;
  const pages: string[] = Array.isArray(config.pages) && config.pages.length ? config.pages : ['/'];
  const clean = path.replace(/\/+$/, '') || '/';
  return pages.some((p) => (p.replace(/\/+$/, '') || '/') === clean);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The bar itself: inline styles only, in the page flow, closable, never floating
 *  over content and never touching the rest of the document. */
export function renderOccasionBanner(config: any): string {
  const themes: Record<string, string> = {
    celebration: 'linear-gradient(90deg,#7f1d1d,#0f766e)',
    newyear: 'linear-gradient(90deg,#1e3a8a,#7c2d12)',
    calm: 'linear-gradient(90deg,#134e4a,#3f2d6b)',
  };
  const bg = themes[String(config.theme)] || themes.celebration;
  const esc = (v: any) => escapeHtml(String(v || ''));
  const dismissible = config.dismissible !== false;
  const dismiss = !dismissible ? '' :
    `<button type="button" aria-label="Dismiss this greeting" onclick="var b=document.getElementById('sv-occasion');if(b)b.remove();try{sessionStorage.setItem('sv_occasion_dismissed','1')}catch(e){}" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:transparent;border:0;color:#fff;font-size:18px;line-height:1;cursor:pointer;padding:6px;">×</button>`;
  return `<div id="sv-occasion" role="status" style="position:relative;display:flex;align-items:center;justify-content:center;gap:9px;padding:10px ${dismissible ? '42px 10px 14px' : '14px'};background:${bg};color:#fff;font:600 13.5px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;">${config.emoji ? `<span aria-hidden="true" style="font-size:16px;">${esc(config.emoji)}</span>` : ''}<span>${config.title ? `<strong>${esc(config.title)}</strong> — ` : ''}${esc(config.message)}</span>${dismiss}</div>
<script>try{if(sessionStorage.getItem('sv_occasion_dismissed')==='1'){var b=document.getElementById('sv-occasion');if(b)b.remove();}}catch(e){}</script>`;
}

/** Add the bar to a finished page, right after the opening <body> tag. Insertion
 *  only — the stored page HTML is never modified, so removing the config removes
 *  the bar completely. */
export function injectOccasionBanner(html: string, config: any): string {
  if (!config || config.enabled === false || !config.message) return html;
  if (html.includes('id="sv-occasion"')) return html;
  const banner = renderOccasionBanner(config);
  const match = /<body[^>]*>/i.exec(html);
  if (!match) return banner + html;
  const at = match.index + match[0].length;
  return html.slice(0, at) + banner + html.slice(at);
}
