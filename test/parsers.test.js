'use strict';

/*
 * Unit tests for src/parsers.js.
 *
 * They run against the synthetic fixtures in test/fixtures.js, so they prove
 * the extraction handles the *shape* the brief describes and its plausible
 * variants. They cannot prove the regexes match the real page — only
 * `npm run probe` does that.
 */

const P = require('../src/parsers');
const F = require('./fixtures');

let passed = 0;
const failures = [];

function t(name, fn) {
  try { fn(); passed++; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what || 'value'} — expected ${e}, got ${a}`);
}
function ok(cond, what) {
  if (!cond) throw new Error(what || 'expected truthy');
}

/* ------------------------------------------------------------------ *
 * Number / text primitives
 * ------------------------------------------------------------------ */

t('mkNumber parses MKD thousands + decimals', () => {
  eq(P.mkNumber('128.450.900,00'), 128450900);
  eq(P.mkNumber('1.234'), 1234);
  eq(P.mkNumber('24'), 24);
  eq(P.mkNumber('3.870.250,50'), 3870250.5);
});

t('mkNumber keeps losses negative', () => {
  eq(P.mkNumber('-450.000,00'), -450000);
  eq(P.mkNumber('−450.000'), -450000);   // unicode minus
  eq(P.mkNumber('(450.000,00)'), -450000);    // parenthesised loss
});

t('mkNumber returns null for non-numbers', () => {
  eq(P.mkNumber(''), null);
  eq(P.mkNumber('n/a'), null);
  eq(P.mkNumber(null), null);
});

t('decodeEntities handles named, decimal and hex forms', () => {
  eq(P.decodeEntities('A&amp;B&nbsp;C&#1057;&#x41;'), 'A&B CСA');
});

t('htmlToLines splits inline label/value spans', () => {
  const L = P.htmlToLines('<div><span>ЕДБ</span><span>4030995123456</span></div>');
  eq(L, ['ЕДБ', '4030995123456']);
});

t('htmlToLines rejoins a stranded ownership percentage onto the name', () => {
  const L = P.htmlToLines('<div><span>Сопственик</span><span>КИРИЛ ВОИНОВСКИ</span><span>(50,00%)</span></div>');
  eq(L, ['Сопственик', 'КИРИЛ ВОИНОВСКИ (50,00%)']);
});

t('htmlToLines never fuses a percentage onto a label', () => {
  const L = P.htmlToLines('<div><span>Сопственички удел</span><span>(50,00%)</span></div>');
  eq(L, ['Сопственички удел', '(50,00%)']);
});

/* ------------------------------------------------------------------ *
 * Validators
 * ------------------------------------------------------------------ */

t('isPhone accepts real MK formats and rejects junk', () => {
  ok(P.isPhone('02/3221-455'), '02/3221-455');
  ok(P.isPhone('070 123 456'), '070 123 456');
  ok(P.isPhone('+389 2 3111 222'), '+389 2 3111 222');
  ok(!P.isPhone('2005'), 'a year is not a phone');
  ok(!P.isPhone('Скопје'), 'text is not a phone');
});

t('phoneKey treats +389 and 0-prefixed forms as one number', () => {
  eq(P.phoneKey('+389 78 123456'), P.phoneKey('078123456'));
});

t('isEmail rejects the site\'s own addresses and image filenames', () => {
  ok(P.isEmail('kontakt@euroimpeks.mk'));
  ok(!P.isEmail('info@companywall.com.mk'), 'site address must be blocked');
  ok(!P.isEmail('logo@2x.png'), 'image filename must be blocked');
});

/* ------------------------------------------------------------------ *
 * Search URL — pagination only
 * ------------------------------------------------------------------ */

t('page 1 is requested with no &p parameter', () => {
  eq(P.buildSearchUrl(P.DEFAULT_SEARCH_URL, 1), P.DEFAULT_SEARCH_URL);
  eq(P.buildSearchUrl(P.DEFAULT_SEARCH_URL), P.DEFAULT_SEARCH_URL);
});

t('later pages only append &p=N', () => {
  eq(P.buildSearchUrl(P.DEFAULT_SEARCH_URL, 2), P.DEFAULT_SEARCH_URL + '&p=2');
  eq(P.buildSearchUrl(P.DEFAULT_SEARCH_URL, 17), P.DEFAULT_SEARCH_URL + '&p=17');
});

t('the campaign revenue filter is carried through untouched', () => {
  const u = P.buildSearchUrl(P.DEFAULT_SEARCH_URL, 5);
  ok(u.includes('dsm[0].From=4000000'), 'revenue floor preserved');
  ok(u.includes('dsm[0].To=4000000000'), 'revenue ceiling preserved');
  ok(u.includes('dsm[1].Code=48'), 'second filter preserved');
  ok(u.includes('bly=2025'), 'business year preserved');
  // The bracket form must NOT be percent-encoded.
  ok(!u.includes('%5B'), 'brackets must stay literal');
});

t('an existing &p= is replaced, never duplicated', () => {
  const u = P.buildSearchUrl(P.DEFAULT_SEARCH_URL + '&p=3', 4);
  eq((u.match(/[?&]p=/g) || []).length, 1, 'exactly one p parameter');
  ok(u.endsWith('&p=4'), 'ends with the new page');
});

/* ------------------------------------------------------------------ *
 * Search results — profile links only
 * ------------------------------------------------------------------ */

t('every company on a page yields exactly one profile URL', () => {
  const r = P.parseSearchResults(F.searchPage(20));
  eq(r.rowCount, 20, 'row count');
  eq(new Set(r.profileUrls).size, 20, 'all distinct');
});

t('a company linked twice per row is counted once', () => {
  const r = P.parseSearchResults(F.searchPage(3));
  eq(r.rowCount, 3);
});

t('the percent-encoded Cyrillic href is taken as-is, never re-encoded', () => {
  const r = P.parseSearchResults(F.searchPage(1));
  ok(r.profileUrls[0].includes(F.ENCODED_SLUG), 'encoded slug preserved byte for byte');
  ok(!r.profileUrls[0].includes('%25'), 'no double-encoding');
});

t('sub-pages like /lica are not mistaken for profiles', () => {
  const r = P.parseSearchResults(F.searchPage(2));
  ok(r.profileUrls.every((u) => !/\/lica$/.test(u)), 'no /lica URLs');
  eq(r.rowCount, 2);
});

t('isProfilePath accepts the documented shape and rejects others', () => {
  ok(P.isProfilePath('/kompanija/euroimpeks-doo/MMA8dAgq'));
  ok(!P.isProfilePath('/kompanija/euroimpeks-doo'), 'missing id');
  ok(!P.isProfilePath('/kompanija/euroimpeks-doo/MMA8dAgq/lica'), 'sub-page');
  ok(!P.isProfilePath('/prebaruvanje'), 'not a profile');
});

/* ---- end-of-pagination detection ---- */

t('an empty results page yields zero rows and a "no results" marker', () => {
  const r = P.parseSearchResults(F.emptySearchPage);
  eq(r.rowCount, 0, 'zero rows');
  ok(r.noResultsMarker, 'marker detected');
});

t('an empty page WITHOUT the wording still yields zero rows', () => {
  // The primary stop signal must not depend on any site wording.
  const r = P.parseSearchResults(F.emptySearchPageNoMarker);
  eq(r.rowCount, 0, 'zero rows');
  eq(r.noResultsMarker, null, 'no marker, and that is fine');
});

t('a challenge page is flagged as blocking, not as "no results"', () => {
  const r = P.parseSearchResults(F.cloudflarePage);
  eq(r.rowCount, 0);
  ok(r.flags.some(P.isBlockingFlag), 'a blocking flag is raised');
  ok(r.flags.includes('CLOUDFLARE_CHALLENGE'), 'identified as a Cloudflare challenge');
});

t('a truncated response is flagged as blocking', () => {
  const cut = F.searchPage(5).slice(0, 4000);
  ok(P.diagnoseResponse(cut).includes('TRUNCATED_BODY'), 'truncation detected');
  ok(P.diagnoseResponse(cut).some(P.isBlockingFlag), 'truncation is blocking');
});

t('a full results page raises no blocking flag', () => {
  ok(!P.parseSearchResults(F.searchPage(20)).flags.some(P.isBlockingFlag));
});

t('a real page carrying a reCAPTCHA script is not treated as blocked', () => {
  const html = F.searchPage(10).replace('</head>', '<script src="/recaptcha/api.js"></script></head>');
  const flags = P.diagnoseResponse(html);
  ok(flags.includes('CAPTCHA_SCRIPT_PRESENT_IGNORED'), 'noted but ignored');
  ok(!flags.some(P.isBlockingFlag), 'not blocking');
});

/* ------------------------------------------------------------------ *
 * Profile page — the 12 data fields
 * ------------------------------------------------------------------ */

const prof = P.parseProfile(F.profilePage());

t('(a) company name comes from the page heading', () => {
  eq(prof.name, 'ЕУРОИМПЕКС ДОО УВОЗ-ИЗВОЗ СКОПЈЕ');
});

t('(b)(c) EDB and EMBS are read by label', () => {
  eq(prof.edb, '4030995123456');
  eq(prof.embs, '6543210');
});

t('(d) date founded is read from "Датум на основање"', () => {
  eq(prof.dateFounded, '12.03.2005');
});

t('(e) ALL phone numbers under ТЕЛ are extracted', () => {
  eq(prof.phones, ['02/3221-455', '070 123 456']);
});

t('(e) the site\'s own header phone is NOT harvested as the company\'s', () => {
  ok(!prof.phones.some((p) => P.digitsOnly(p).endsWith('3112233')), 'header tel: href excluded');
});

t('(f) ALL emails under Е-ПОШТА are extracted', () => {
  eq(prof.emails, ['kontakt@euroimpeks.mk', 'prodazba@euroimpeks.mk']);
});

t('(g) ALL owners are extracted, with the ownership percentage kept', () => {
  eq(prof.owners, ['КИРИЛ ВОИНОВСКИ(50,00%)', 'ГОРАН ВОИНОВСКИ(50,00%)']);
});

t('(h) ALL managers are extracted', () => {
  eq(prof.managers, ['КИРИЛ ВОИНОВСКИ', 'АНА СТОЈАНОВА']);
});

t('(i) only the numeric NKD code is kept, the description is discarded', () => {
  eq(prof.nkdCode, '46.710');
  ok(!/Трговија/.test(prof.nkdCode), 'no description leaked into the code');
});

t('(j) profit/loss is taken from the latest year column', () => {
  eq(prof.profit, 3870250);
  eq(prof.profitYear, 2025);
});

t('(k) revenue is taken from the latest year column', () => {
  eq(prof.revenue, 128450900);
  eq(prof.revenueYear, 2025);
});

t('(l) employee count is read from the financial summary', () => {
  eq(prof.employees, 31);
});

t('a clean profile reports nothing missing', () => {
  eq(prof.missing, []);
});

/* ---- the year-ordering assumption the brief flags ---- */

t('the LATEST year wins even when the columns run newest-first', () => {
  const p = P.parseProfile(F.profilePage({ financial: F.FINANCIAL_TABLE_DESC }));
  eq(p.profitYear, 2025, 'latest year selected by max, not by position');
  eq(p.profit, 3870250, 'value from the 2025 column');
  eq(p.revenue, 128450900);
  ok(p.notes.includes('profit:latest-year-not-rightmost'), 'the ordering surprise is flagged');
});

t('a financial summary rendered without <table> still parses', () => {
  const p = P.parseProfile(F.profilePage({ financial: F.FINANCIAL_DIVS }));
  eq(p.profit, 3870250);
  eq(p.profitYear, 2025);
  eq(p.revenue, 128450900);
  ok(p.notes.some((n) => n.indexOf('lines-') >= 0), 'the fallback strategy is recorded');
});

t('a loss in the latest year is kept, negative, and never dropped', () => {
  const loss = F.FINANCIAL_TABLE_ASC.replace(
    '<td>1.200.000,00</td><td>-450.000,00</td><td>3.870.250,00</td>',
    '<td>1.200.000,00</td><td>-450.000,00</td><td>-2.100.500,00</td>'
  );
  const p = P.parseProfile(F.profilePage({ financial: loss }));
  eq(p.profit, -2100500, 'loss preserved');
  const row = P.buildSheetRow(p, 'https://x', '2026-01-01T00:00:00Z');
  eq(row['Profit/Loss (latest year)'], -2100500, 'loss reaches the sheet row unchanged');
});

/* ---- degraded profiles ---- */

t('a missing КОНТАКТИ section is reported, not thrown', () => {
  const p = P.parseProfile(F.profilePage({ contacts: '' }));
  ok(p.missing.includes('Phone Numbers'), 'phones reported missing');
  ok(p.missing.includes('Owners'), 'owners reported missing');
  eq(p.embs, '6543210', 'the rest of the page still parses');
});

t('a missing financial table leaves the figures blank without failing', () => {
  const p = P.parseProfile(F.profilePage({ financial: '' }));
  eq(p.profit, '');
  eq(p.revenue, '');
  eq(p.employees, '', 'employees is optional and stays blank');
  ok(p.missing.includes('Profit/Loss (latest year)'));
  eq(p.name, 'ЕУРОИМПЕКС ДОО УВОЗ-ИЗВОЗ СКОПЈЕ', 'the rest of the page still parses');
});

t('employees falls back to a labelled line outside the table', () => {
  const p = P.parseProfile(F.profilePage({
    financial: '<section><h2>ФИНАНСИСКО РЕЗИМЕ</h2><div><span>Просечен број на вработени</span><span>17</span></div></section>',
  }));
  eq(p.employees, 17);
});

t('a name falls back to the <title> when there is no <h1>', () => {
  const p = P.parseProfile(F.profilePage({
    header: '<div><span>ЕМБС</span><span>6543210</span></div>',
  }).replace('<title>CompanyWall</title>', '<title>ТЕСТ ДОО СКОПЈЕ | CompanyWall</title>'));
  eq(p.name, 'ТЕСТ ДОО СКОПЈЕ');
  ok(p.notes.includes('name:from-title'));
});

t('contacts rendered only as tel:/mailto: links are still found', () => {
  const p = P.parseProfile(F.profilePage({
    contacts: `<section><h2>КОНТАКТИ</h2>
      <a href="tel:023221455">02/3221-455</a>
      <a href="tel:070123456">070 123 456</a>
      <a href="mailto:kontakt@euroimpeks.mk">пиши ни</a></section>`,
  }));
  eq(p.phones.map(P.digitsOnly), ['023221455', '070123456']);
  eq(p.emails, ['kontakt@euroimpeks.mk']);
  ok(p.notes.includes('phones:from-tel-href'), 'the fallback is recorded');
  ok(!p.phones.some((x) => P.digitsOnly(x).endsWith('3112233')), 'header phone still excluded');
});

t('the href fallback is not used at all when КОНТАКТИ is absent', () => {
  // Better a blank cell than CompanyWall's own support number on every lead.
  const p = P.parseProfile(F.profilePage({ contacts: '' }));
  eq(p.phones, []);
  eq(p.emails, []);
});

/* ------------------------------------------------------------------ *
 * Sheet row shaping
 * ------------------------------------------------------------------ */

t('the main sheet has exactly the brief\'s 14 columns, in order', () => {
  eq(P.SHEET_HEADERS, [
    'EMBS', 'Company Name', 'EDB', 'Date Founded', 'Phone Numbers', 'Emails',
    'Owners', 'Managers', 'NKD Code', 'Revenue (from list page)',
    'Number of Employees', 'Profit/Loss (latest year)', 'Profile URL', 'Date Scraped',
  ]);
});

t('buildSheetRow emits exactly those keys, in that order', () => {
  const row = P.buildSheetRow(prof, 'https://www.companywall.com.mk/kompanija/x/MMA8dAgq', '2026-01-01T00:00:00Z');
  eq(Object.keys(row), P.SHEET_HEADERS);
});

t('multi-value fields are joined with "; "', () => {
  const row = P.buildSheetRow(prof, 'https://x', '2026-01-01T00:00:00Z');
  eq(row['Phone Numbers'], '02/3221-455; 070 123 456');
  eq(row['Emails'], 'kontakt@euroimpeks.mk; prodazba@euroimpeks.mk');
  eq(row['Owners'], 'КИРИЛ ВОИНОВСКИ(50,00%); ГОРАН ВОИНОВСКИ(50,00%)');
  eq(row['Managers'], 'КИРИЛ ВОИНОВСКИ; АНА СТОЈАНОВА');
});

t('the profile URL and timestamp are written through verbatim', () => {
  const url = 'https://www.companywall.com.mk/kompanija/' + F.ENCODED_SLUG + '/MMA8dAgq';
  const row = P.buildSheetRow(prof, url, '2026-01-01T00:00:00Z');
  eq(row['Profile URL'], url);
  eq(row['Date Scraped'], '2026-01-01T00:00:00Z');
});

t('a blank employee count writes an empty cell, not "null"', () => {
  const p = P.parseProfile(F.profilePage({ financial: '' }));
  const row = P.buildSheetRow(p, 'https://x', 'now');
  eq(row['Number of Employees'], '');
});

t('the Errors tab has exactly 7 columns', () => {
  eq(P.ERROR_SHEET_HEADERS.length, 7);
  const row = P.buildErrorRow({
    embs: '', name: 'X', profileUrl: 'https://x',
    error: 'profile page failed to load', missing: ['EDB', 'Emails'],
    written: false, scrapedAt: 'now',
  });
  eq(Object.keys(row), P.ERROR_SHEET_HEADERS);
  eq(row['Missing Fields'], 'EDB; Emails');
  eq(row['Written To Main Sheet'], 'no');
});

/* ------------------------------------------------------------------ */

console.log(`parsers: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  failures.forEach((f) => console.log(`  x ${f}`));
  process.exit(1);
}
