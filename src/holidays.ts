/* World-famous days, and what the site does on each one.
 *
 * Two rules, both from the operator:
 *   1. The change must be automatic and date-bounded — a visitor in any timezone
 *      sees "Happy Christmas" the moment it is Christmas where they are, not when
 *      a server in another country says so.
 *   2. It is decoration only. The layout, the colours of the pages and the text
 *      stay exactly as designed; the season is added on top and removed by itself.
 *
 * Everything here is pure so it can be tested without a browser or a database. */

export type DecorEffect = 'snow' | 'lights' | 'fireworks' | 'lanterns' | 'diyas' | 'bunting';

export interface Holiday {
  id: string;
  label: string;
  /** Month-day of the main day, e.g. '12-25'. Fixed-date holidays only. */
  monthDay: string;
  /** How many days before and after the main day the decoration stays. */
  before: number;
  after: number;
  emoji: string;
  greeting: string;
  subline: string;
  effect: DecorEffect;
  /** The bar is tinted with these two colours; the page keeps its own. */
  colors: { from: string; to: string; accent: string };
  /** Seasonal Pro pass granted in this window, in days. 0 = no pass. */
  proDays: number;
  proLabel?: string;
}

/** The days that are celebrated worldwide, in calendar order. Lunar holidays
 *  (Vesak, Deepavali) shift every year, so their month-day is the published date
 *  and the operator can move it in Settings if it is off by a day. */
export const HOLIDAYS: Holiday[] = [
  {
    id: 'new-year',
    label: 'New Year',
    monthDay: '01-01',
    before: 1,
    after: 1,
    emoji: '🎆',
    greeting: 'Happy New Year',
    subline: 'A new year of songs starts tonight — thank you for being here.',
    effect: 'fireworks',
    colors: { from: '#1e3a8a', to: '#7c2d12', accent: '#fbbf24' },
    proDays: 7,
    proLabel: 'New Year week',
  },
  {
    id: 'sinhala-new-year',
    label: 'Sinhala & Tamil New Year',
    monthDay: '04-14',
    before: 1,
    after: 1,
    emoji: '🌅',
    greeting: 'සුබ අලුත් අවුරුද්දක්!',
    subline: 'Suba Aluth Avuruddak — a peaceful new year to you and your family.',
    effect: 'lanterns',
    colors: { from: '#7c2d12', to: '#a16207', accent: '#fde68a' },
    proDays: 0,
  },
  {
    id: 'vesak',
    label: 'Vesak',
    monthDay: '05-20',
    before: 1,
    after: 2,
    emoji: '🪷',
    greeting: 'සුබ වෙසක්!',
    subline: 'Wishing you a peaceful Vesak full of light and kindness.',
    effect: 'lanterns',
    colors: { from: '#134e4a', to: '#3f2d6b', accent: '#fcd34d' },
    proDays: 0,
  },
  {
    id: 'deepavali',
    label: 'Deepavali',
    monthDay: '11-08',
    before: 2,
    after: 1,
    emoji: '🪔',
    greeting: 'Happy Deepavali',
    subline: 'May the festival of lights bring you a bright year.',
    effect: 'diyas',
    colors: { from: '#7c2d12', to: '#3f2d6b', accent: '#fbbf24' },
    proDays: 0,
  },
  {
    id: 'christmas',
    label: 'Christmas',
    monthDay: '12-25',
    // The whole week, as the operator asked: decorations stay up for Christmas week.
    before: 5,
    after: 2,
    emoji: '🎄',
    greeting: 'Happy Christmas',
    subline: 'Wishing you a calm, musical Christmas from everyone at SingVaza.',
    effect: 'snow',
    colors: { from: '#7f1d1d', to: '#0f766e', accent: '#bbf7d0' },
    proDays: 7,
    proLabel: 'Christmas week',
  },
];

/** A holiday resolved onto real dates for one year. */
export interface HolidayWindow {
  id: string;
  label: string;
  emoji: string;
  greeting: string;
  subline: string;
  effect: DecorEffect;
  colors: { from: string; to: string; accent: string };
  proDays: number;
  proLabel?: string;
  /** YYYY-MM-DD, inclusive. */
  startDate: string;
  endDate: string;
  mainDate: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The window a holiday covers in a given year (a year is enough: every window is
 *  shorter than a month and none crosses more than one boundary). */
export function windowFor(holiday: Holiday, year: number): HolidayWindow {
  const main = `${year}-${holiday.monthDay}`;
  return {
    id: holiday.id,
    label: holiday.label,
    emoji: holiday.emoji,
    greeting: holiday.greeting,
    subline: holiday.subline,
    effect: holiday.effect,
    colors: holiday.colors,
    proDays: holiday.proDays,
    proLabel: holiday.proLabel,
    mainDate: main,
    startDate: addDays(main, -holiday.before),
    endDate: addDays(main, holiday.after),
  };
}

/** Every window that could be live around this date (this year and the next, so
 *  a window that starts in December and ends in January is found). */
export function windowsAround(today: string): HolidayWindow[] {
  const year = Number(today.slice(0, 4));
  const out: HolidayWindow[] = [];
  for (const y of [year - 1, year, year + 1]) {
    for (const h of HOLIDAYS) out.push(windowFor(h, y));
  }
  return out;
}

/** The holiday live today, or null. Dates are plain YYYY-MM-DD strings, so the
 *  caller decides whose "today" is used — the visitor's, not the server's. */
export function activeHoliday(today: string): HolidayWindow | null {
  const live = windowsAround(today).filter((w) => today >= w.startDate && today <= w.endDate);
  if (!live.length) return null;
  // Prefer the holiday whose main day is closest (New Year's Day beats the last
  // day of the Christmas window on 1 January).
  live.sort((a, b) => Math.abs(daysBetween(today, a.mainDate)) - Math.abs(daysBetween(today, b.mainDate)));
  return live[0];
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

/** The Pro-pass window live today (Christmas week, New Year week), or null. */
export function proWindow(today: string): HolidayWindow | null {
  const live = windowsAround(today).filter((w) => w.proDays > 0 && today >= w.startDate && today <= w.endDate);
  if (!live.length) return null;
  const withPass = activeHoliday(today);
  if (withPass && withPass.proDays > 0) return withPass;
  live.sort((a, b) => Math.abs(daysBetween(today, a.mainDate)) - Math.abs(daysBetween(today, b.mainDate)));
  return live[0];
}

/** A calendar view for the admin panel: the next twelve months of holidays. */
export function upcoming(today: string, count = 6): HolidayWindow[] {
  return windowsAround(today)
    .filter((w) => w.endDate >= today)
    .sort((a, b) => a.mainDate.localeCompare(b.mainDate))
    .slice(0, count);
}

/** What the browser needs to decorate the page. Sent by /api/holidays/active so
 *  the same calendar is used on the edge and in the browser. */
export function decorPayload(window: HolidayWindow | null, preview = false) {
  if (!window) return { active: false, preview: false };
  return {
    active: true,
    preview,
    id: window.id,
    label: window.label,
    emoji: window.emoji,
    greeting: window.greeting,
    subline: window.subline,
    effect: window.effect,
    colors: window.colors,
    proDays: window.proDays,
    proLabel: window.proLabel || window.label,
    startDate: window.startDate,
    endDate: window.endDate,
    mainDate: window.mainDate,
  };
}

/** The tiny script tag that carries the decoration onto every page. It carries no
 *  data: the browser asks /api/holidays/active itself, using the visitor's date. */
export const HOLIDAY_TAG = '<script src="/holiday.js?v=1" defer></script>';
