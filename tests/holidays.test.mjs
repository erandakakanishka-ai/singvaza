import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

/* The operator's rules for the seasons:
 *   1. the famous days are recognised automatically — nothing to switch on;
 *   2. the visitor's own date decides, so Christmas starts in Auckland first;
 *   3. it is decoration only: the layout and colours of the pages never change;
 *   4. Christmas week and New Year week give signed-in members 7 days of Pro,
 *      once per season, and a signed-in visitor is told when they land. */

async function load(entry) {
  const out = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

const holidays = await load('src/holidays.ts');
const holidayJs = await readFile(new URL('../public/holiday.js', import.meta.url), 'utf8');
const workerSrc = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');
const middleware = await readFile(new URL('../functions/_middleware.ts', import.meta.url), 'utf8');
const admin = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');

test('the famous days are in the calendar without anything being switched on', () => {
  const ids = holidays.HOLIDAYS.map((h) => h.id);
  for (const id of ['christmas', 'new-year', 'vesak', 'deepavali', 'sinhala-new-year']) {
    assert.ok(ids.includes(id), id);
  }
  // and every one of them carries a greeting and a decoration
  for (const h of holidays.HOLIDAYS) {
    assert.ok(h.greeting && h.subline, `${h.id} has words`);
    assert.ok(h.effect, `${h.id} has a decoration`);
    assert.ok(h.colors && h.colors.from && h.colors.to, `${h.id} has tint colours`);
  }
});

test('Christmas runs for the whole week, and the New Year crosses into January', () => {
  const christmas = holidays.windowFor(holidays.HOLIDAYS.find((h) => h.id === 'christmas'), 2026);
  assert.equal(christmas.mainDate, '2026-12-25');
  assert.equal(christmas.startDate, '2026-12-20');
  assert.equal(christmas.endDate, '2026-12-27');

  // A window is named after the year of its main day: the 1 January 2026 window
  // starts on 31 December 2025, and the next one starts a year later.
  const newYear = holidays.windowFor(holidays.HOLIDAYS.find((h) => h.id === 'new-year'), 2027);
  assert.equal(newYear.mainDate, '2027-01-01');
  assert.equal(newYear.startDate, '2026-12-31');
  assert.equal(newYear.endDate, '2027-01-02');
});

test('an ordinary day gets no decoration at all', () => {
  assert.equal(holidays.activeHoliday('2026-10-30'), null);
  assert.equal(holidays.activeHoliday('2026-11-20'), null);
  assert.equal(holidays.proWindow('2026-10-30'), null);
  assert.deepEqual(holidays.decorPayload(null), { active: false, preview: false });
});

test('the first and last day of a season are included, the day after is not', () => {
  assert.equal(holidays.activeHoliday('2026-12-19'), null, 'the day before');
  assert.equal(holidays.activeHoliday('2026-12-20').id, 'christmas', 'the first day');
  assert.equal(holidays.activeHoliday('2026-12-25').id, 'christmas', 'the main day');
  assert.equal(holidays.activeHoliday('2026-12-27').id, 'christmas', 'the last day');
  assert.equal(holidays.activeHoliday('2026-12-28'), null, 'the day after reverts by itself');
});

test('the visitor\'s date is what counts, so any timezone works', () => {
  // Auckland is already on the 25th while Colombo is still on the 24th: the same
  // calendar answers per date, which is exactly what the browser sends.
  const auckland = holidays.decorPayload(holidays.activeHoliday('2026-12-25'));
  const colombo = holidays.decorPayload(holidays.activeHoliday('2026-12-24'));
  assert.equal(auckland.active, true);
  assert.equal(colombo.active, true);
  // and the greeting is the same words in both places
  assert.equal(auckland.greeting, colombo.greeting);
  // the day before the season starts, one of them already sees it
  assert.equal(holidays.activeHoliday('2026-12-19'), null);
});

test('New Year\'s Day belongs to the New Year, not to the tail of Christmas', () => {
  const day = holidays.activeHoliday('2027-01-01');
  assert.equal(day.id, 'new-year');
  assert.equal(day.effect, 'fireworks');
});

test('Christmas brings snow; the New Year brings fireworks', () => {
  assert.equal(holidays.activeHoliday('2026-12-24').effect, 'snow');
  assert.equal(holidays.activeHoliday('2027-01-01').effect, 'fireworks');
});

test('only Christmas week and New Year week grant a free Pro week', () => {
  assert.equal(holidays.proWindow('2026-12-25').proDays, 7);
  assert.equal(holidays.proWindow('2026-12-25').proLabel, 'Christmas week');
  assert.equal(holidays.proWindow('2027-01-01').proDays, 7);
  assert.equal(holidays.proWindow('2027-01-01').proLabel, 'New Year week');
  // Vesak gets decorations but no pass, exactly as the operator asked
  assert.equal(holidays.proWindow('2027-05-20'), null);
  assert.equal(holidays.activeHoliday('2027-05-20').proDays, 0);
});

test('the claim is signed-in only and once per season', () => {
  const i = workerSrc.indexOf("'/api/holidays/claim-pro'");
  assert.ok(i > 0, 'the route exists');
  const route = workerSrc.slice(i, i + 1600);
  assert.match(route, /if \(!authenticated \|\| !user/, 'signed-in visitors only');
  assert.match(route, /pro_claim:\$\{user\.id\}:\$\{window\.id\}/, 'one claim per account per season');
  assert.match(route, /alreadyClaimed/, 'a second attempt reports the first one instead of adding again');
  assert.match(route, /Math\.max\(currentUntil, Date\.now\(\)\)/, 'a longer pass is never shortened');
  // the gift opens on the server's date, so a crafted client date cannot open it early
  assert.match(route, /proWindow\(serverDate\)/, 'the server date opens the window');
});

test('the decoration is added on top of the page and never restyles it', () => {
  // the bar is inserted before the existing content, the effects are fixed layers
  assert.match(holidayJs, /body\.insertBefore\(bar, document\.body\.firstChild\)/, 'the bar sits above the page');
  assert.match(holidayJs, /position:fixed/, 'the snow and fireworks are overlay layers');
  assert.match(holidayJs, /pointer-events:none/, 'and never block a tap');
  // nothing in the decoration may rewrite the page's own look
  assert.doesNotMatch(holidayJs, /document\.body\.style/, 'the page colours are untouched');
  assert.doesNotMatch(holidayJs, /document\.documentElement\.style/, 'the theme is untouched');
  assert.doesNotMatch(holidayJs, /innerHTML\s*=\s*[^;]*document\.body/, 'the page html is untouched');
  assert.match(holidayJs, /prefers-reduced-motion/, 'and animation can be switched off by the reader');
});

test('every page carries the tag, and the admin panel does not', () => {
  assert.match(middleware, /holiday\.js/, 'the middleware adds it');
  assert.match(workerSrc, /HOLIDAY_TAG/, 'the worker adds it to the pages it serves');
  assert.match(middleware, /cleanPath === '\/admin'/, 'but never to the admin panel');
  assert.match(workerSrc, /!style\.data|holiday\.js/, 'the shell pages are covered too');
});

test('the greeting can be closed, and closing it clears the whole scene', () => {
  assert.match(holidayJs, /markClosed/, 'the choice is remembered for the session');
  assert.match(holidayJs, /sv-holiday-layer/, 'the layers are marked');
  assert.match(holidayJs, /function removeAll/, 'and removed together');
});

test('a preview is for the admin only and hands out no real pass', () => {
  const i = workerSrc.indexOf("'/api/admin/holiday-preview'");
  assert.ok(i > 0);
  assert.match(workerSrc.slice(i, i + 900), /isValidBlogAdmin/, 'only a signed-in admin can start one');
  // a link carries its own expiry (default seven days) and is signed
  assert.match(workerSrc.slice(i, i + 1400), /days \* 24 \* 60 \* 60 \* 1000/, 'and it expires by itself');
  assert.match(workerSrc.slice(i, i + 1400), /holidayPreviewSignature/, 'signed, so it cannot be edited');
  assert.match(holidayJs, /data\.preview/, 'the browser knows it is a preview');
  assert.match(holidayJs, /Opens ' \+ data\.startDate/, 'the claim button says when the real week starts');
});

test('the panel shows the calendar without a switch', () => {
  assert.match(admin, /Holidays — automatic, nothing to switch on/);
  assert.match(admin, /loadHolidays|AdminApp\.loadHolidays/, 'the list is loaded');
  assert.match(admin, /previewHoliday/, 'each day can be looked at');
  assert.doesNotMatch(admin, /holiday_enabled|Enable holidays/, 'no switch to forget');
});

test('the calendar answers for any date', () => {
  const i = workerSrc.indexOf("'/api/holidays/active'");
  assert.ok(i > 0);
  assert.match(workerSrc.slice(i, i + 500), /searchParams\.get\('date'\)/, 'the date comes from the visitor');
  assert.match(workerSrc.slice(i, i + 1600), /Cache-Control': 'no-store'/, 'never cached across a date change');
});

test('the next twelve months are listed for the operator', () => {
  const list = holidays.upcoming('2026-10-30', 6);
  assert.ok(list.length >= 5);
  const labels = list.map((h) => h.id);
  assert.ok(labels.includes('christmas'));
  assert.ok(labels.includes('new-year'));
  // sorted, so the nearest day is first
  for (let i = 1; i < list.length; i += 1) assert.ok(list[i - 1].mainDate <= list[i].mainDate);
});

test('a preview link is signed, dated, and shows nothing when edited', () => {
  const i = workerSrc.indexOf("'/api/holidays/active'");
  const route = workerSrc.slice(i, i + 1600);
  assert.match(route, /holidayPreviewSignature\(previewId \+ ':' \+ until, secret\)/, 'the signature covers the season and the expiry');
  assert.match(route, /expected === sig/, 'a wrong signature falls through to no decoration');
  assert.match(holidayJs, /&hp=/, 'the browser passes the expiry through');
  assert.match(holidayJs, /&hs=/, 'and the signature');
  assert.match(admin, /makeHolidayLinks/, 'the panel can produce the links');
  assert.match(admin, /Christmas \+ New Year links/, 'one button for the two the operator asked for');
});
