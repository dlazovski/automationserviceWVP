'use strict';

/*
 * Executes the GENERATED Code nodes from workflow/companywall-mk-grant-leads.json
 * inside a mock of the n8n runtime, driving the real pagination loop, the real
 * per-company duplicate check and the real error routing.
 *
 * This tests the code that actually ships — not src/nodes/*.js — so an inlining
 * bug in build/build-workflow.js fails the suite.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('./fixtures');
const P = require('../src/parsers');

const WF = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'workflow', 'companywall-mk-grant-leads.json'), 'utf8'));

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
function ok(cond, what) { if (!cond) throw new Error(what || 'expected truthy'); }
function throws(fn, re, what) {
  try { fn(); } catch (e) {
    if (re && !re.test(e.message)) throw new Error(`${what}: wrong error "${e.message}"`);
    return;
  }
  throw new Error(what || 'expected a throw');
}

const codeOf = (name) => {
  const n = WF.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no such node: ${name}`);
  return n.parameters.jsCode;
};

/* ------------------------------------------------------------------ *
 * n8n runtime mock
 * ------------------------------------------------------------------ */

function makeCtx(state) {
  const items = (v) => (Array.isArray(v) ? v : [v]).map((j) => ({ json: j }));
  return {
    $: (nodeName) => {
      if (!(nodeName in state.nodeOutputs)) {
        throw new Error(`node "${nodeName}" was not primed in this test`);
      }
      const out = items(state.nodeOutputs[nodeName]);
      return { first: () => out[0], all: () => out, last: () => out[out.length - 1] };
    },
    $input: {
      first: () => items(state.input)[0],
      all: () => items(state.input),
      last: () => items(state.input)[items(state.input).length - 1],
    },
    $getWorkflowStaticData: () => state.staticData,
    // n8n exposes $now as a Luxon DateTime; only .toISO() is used.
    $now: { toISO: () => '2026-09-06T12:00:00.000+02:00' },
    console,
    JSON, Math, Date, Number, String, Object, Array, Set, Map, RegExp, isFinite, parseInt, parseFloat,
  };
}

/** Run one generated Code node and return its emitted json objects. */
function run(nodeName, state) {
  const ctx = makeCtx(state);
  vm.createContext(ctx);
  const fn = vm.runInContext(`(function(){${codeOf(nodeName)}\n})`, ctx, { filename: nodeName });
  const out = fn();
  return (out || []).map((i) => i.json);
}

/** A ScrapingBee HTTP node response, as the Code nodes receive it. */
const httpOk = (body) => ({ statusCode: 200, body });
const manyUrls = (n) => Array.from({ length: n }, (_, i) => `https://www.companywall.com.mk/kompanija/x-${i}/MMA8dAg${i}`);
const httpErr = (statusCode) => ({ statusCode, body: '' });

const CONFIG = {
  searchUrl: P.DEFAULT_SEARCH_URL,
  googleSheetId: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
  sheetName: 'Leads',
  errorSheetName: 'Errors',
  maxPages: 50,
  maxCompanies: 0,
  renderJs: 'false',
  premiumProxy: 'false',
};

function newState(extra) {
  return Object.assign({
    staticData: {},
    nodeOutputs: { Config: CONFIG },
    input: {},
  }, extra || {});
}

/* ------------------------------------------------------------------ *
 * Init Run
 * ------------------------------------------------------------------ */

t('Init Run seeds page 1 and resets the counters', () => {
  const st = newState();
  st.staticData.cwGrantRun = { rowsWritten: 999, errors: ['stale'] };  // survives between runs
  const out = run('Init Run', st);
  eq(out[0].page, 1);
  eq(out[0].collected, []);
  eq(st.staticData.cwGrantRun.rowsWritten, 0, 'stale totals cleared');
  eq(st.staticData.cwGrantRun.errors, [], 'stale errors cleared');
});

t('Init Run refuses to start with the sheet ID placeholder still in place', () => {
  const st = newState();
  st.nodeOutputs.Config = Object.assign({}, CONFIG, { googleSheetId: 'REPLACE_WITH_GOOGLE_SHEET_ID' });
  throws(() => run('Init Run', st), /googleSheetId is still the placeholder/, 'placeholder guard');
});

t('Init Run refuses a searchUrl that is not the CompanyWall search page', () => {
  const st = newState();
  st.nodeOutputs.Config = Object.assign({}, CONFIG, { searchUrl: 'https://example.com/x' });
  throws(() => run('Init Run', st), /must be the CompanyWall\.mk/, 'URL guard');
});

/* ------------------------------------------------------------------ *
 * The NKD (industry) sweep — the second slicing axis
 * ------------------------------------------------------------------ */

t('Init Run seeds one starting band per NKD sector', () => {
  const st = newState();
  st.nodeOutputs.Config = Object.assign({}, CONFIG, { nkdCodes: 'all' });
  const out = run('Init Run', st)[0];
  eq(out.queue.length + 1, 99, 'all 99 sectors queued');
  eq(out.band.nkd, '01', 'starts at the first sector');
  eq(out.band.from, 4000000, 'each sector spans the full campaign revenue range');
  eq(out.band.to, 4000000000);
});

t('a comma-separated list is accepted', () => {
  const st = newState();
  st.nodeOutputs.Config = Object.assign({}, CONFIG, { nkdCodes: '46, 47 ,62' });
  const out = run('Init Run', st)[0];
  eq([out.band].concat(out.queue).map((b) => b.nkd), ['46', '47', '62']);
});

t('an empty list keeps the URL as-is — the previous single-sweep behaviour', () => {
  const st = newState();
  st.nodeOutputs.Config = Object.assign({}, CONFIG, { nkdCodes: '' });
  const out = run('Init Run', st)[0];
  eq(out.queue.length, 0, 'exactly one starting band');
  eq(out.band.nkd, '', 'no industry filter');
});

t('Build Search URL applies the sector, the band and the page together', () => {
  const st = newState({
    input: { band: { nkd: '46', from: 4000000, to: 9000000 }, page: 3, collected: [], errors: [] },
  });
  const url = run('Build Search URL', st)[0].targetUrl;
  ok(/[?&]at=46(&|$)/.test(url), 'sector applied');
  ok(url.includes('dsm[0].From=4000000') && url.includes('dsm[0].To=9000000'), 'band applied');
  ok(url.endsWith('&p=3'), 'page applied');
  ok(url.includes('sbjact=t'), 'nothing else disturbed');
});

/* ------------------------------------------------------------------ *
 * Build Search URL
 * ------------------------------------------------------------------ */

const SEED_BAND = { from: 4000000, to: 4000000000 };

t('Build Search URL leaves page 1 unpaginated and appends &p= after that', () => {
  const st = newState({ input: { band: SEED_BAND, page: 1, collected: [], errors: [] } });
  eq(run('Build Search URL', st)[0].targetUrl, P.DEFAULT_SEARCH_URL,
    'the seed band reproduces the configured URL exactly');

  st.input = { band: SEED_BAND, page: 4, collected: ['a'], errors: [] };
  const out = run('Build Search URL', st)[0];
  eq(out.targetUrl, P.DEFAULT_SEARCH_URL + '&p=4');
  eq(out.collected, ['a'], 'accumulated URLs carried forward');
});

t('a narrowed band rewrites ONLY the two revenue parameters', () => {
  const st = newState({ input: { band: { from: 4000000, to: 9000000 }, page: 1, collected: [], errors: [] } });
  const url = run('Build Search URL', st)[0].targetUrl;
  ok(url.includes('dsm[0].From=4000000'), 'still at the campaign floor');
  ok(url.includes('dsm[0].To=9000000'), 'narrowed ceiling');
  const mask = (u) => u.replace(/dsm\[0\]\.(From|To)=\d+/g, 'X');
  eq(mask(url), mask(P.DEFAULT_SEARCH_URL), 'every other parameter byte-identical');
});

t('every band request stays at or above the campaign revenue floor', () => {
  for (const band of [SEED_BAND, { from: 4000000, to: 5000000 }, { from: 900000000, to: 4000000000 }]) {
    const st = newState({ input: { band, page: 1, collected: [], errors: [] } });
    const from = Number(run('Build Search URL', st)[0].targetUrl.match(/dsm\[0\]\.From=(\d+)/)[1]);
    ok(from >= 4000000, `band ${band.from}-${band.to} keeps the ICP floor`);
  }
});

t('Build Search URL passes the ScrapingBee render flags through', () => {
  const st = newState({ input: { band: SEED_BAND, page: 1, collected: [], errors: [] } });
  st.nodeOutputs.Config = Object.assign({}, CONFIG, { renderJs: 'true', premiumProxy: 'true' });
  const out = run('Build Search URL', st)[0];
  eq(out.renderJs, 'true');
  eq(out.premiumProxy, 'true');
});

/* ------------------------------------------------------------------ *
 * Parse Search Results — pagination + the revenue-band work queue
 * ------------------------------------------------------------------ */

const SEED = { from: 4000000, to: 4000000000 };

function searchState(over, resp) {
  const st = newState({ input: resp });
  st.nodeOutputs['Build Search URL'] = Object.assign(
    { band: SEED, queue: [], page: 1, bandSeen: [], collected: [], errors: [] },
    over || {}
  );
  st.staticData.cwGrantRun = { errors: [], bands: [] };
  return st;
}

t('a full page asks for the next one within the same band', () => {
  const out = run('Parse Search Results', searchState({}, httpOk(F.searchPage(20))))[0];
  eq(out.hasMore, true, 'wants another page');
  eq(out.page, 2, 'advances the page counter');
  eq(out.band, SEED, 'still the same band');
  eq(out.collected.length, 20);
});

t('pagination accumulates across pages without duplicating', () => {
  const p1 = run('Parse Search Results', searchState({}, httpOk(F.searchPage(20, 1))))[0];
  const p2 = run('Parse Search Results',
    searchState({ page: 2, collected: p1.collected, bandSeen: p1.bandSeen }, httpOk(F.searchPage(20, 21))))[0];
  eq(p2.collected.length, 40, 'two full pages accumulated');
  eq(new Set(p2.collected).size, 40, 'all distinct');
  eq(p2.hasMore, true);
});

t('an empty page ends the band; with an empty queue the crawl finishes', () => {
  const out = run('Parse Search Results',
    searchState({ page: 3, collected: ['u1', 'u2'], bandSeen: ['u1', 'u2'] }, httpOk(F.emptySearchPage)))[0];
  eq(out.hasMore, false, 'nothing left to fetch');
  eq(out.stopReason, 'no_results_marker');
  eq(out.collected, ['u1', 'u2'], 'already-collected URLs are kept');
  eq(out.errors, [], 'a normal end of results is not an error');
});

t('an empty page with no "no results" wording still ends the band', () => {
  const out = run('Parse Search Results',
    searchState({ page: 3, collected: ['u1'], bandSeen: ['u1'] }, httpOk(F.emptySearchPageNoMarker)))[0];
  eq(out.hasMore, false);
  eq(out.stopReason, 'no_results_empty');
});

t('a repeat on a NON page boundary is a real end, not a truncation', () => {
  // 10 results, page size 20: the site ran out mid-page. Splitting here would
  // subdivide forever on any site that serves page 1 again past the end.
  const first = run('Parse Search Results', searchState({}, httpOk(F.searchPage(10))))[0];
  const st = searchState({ page: 2, collected: first.collected, bandSeen: first.bandSeen },
    httpOk(F.searchPage(10)));
  const out = run('Parse Search Results', st)[0];
  eq(out.hasMore, false, 'accepted as complete');
  eq(out.stopReason, 'repeated_results');
  eq(st.staticData.cwGrantRun.bandsSplit || 0, 0, 'no split');
});

t('a repeat ON a page boundary is a cap below the configured ceiling', () => {
  /*
   * The site served a page we had already seen instead of advancing. A band we
   * genuinely exhausted ends with an EMPTY page, never with a repeat — so this
   * band was cut short and must be split, even though 10 is far below the
   * configured ceiling of 60. Relying on the ceiling alone is what left a live
   * run short at 143.
   */
  // 40 results at a page size of 20, then a repeat: a cap on a page boundary,
  // well under the configured ceiling of 60.
  const p1 = run('Parse Search Results', searchState({}, httpOk(F.searchPage(20, 1))))[0];
  const p2 = run('Parse Search Results',
    searchState({ page: 2, collected: p1.collected, bandSeen: p1.bandSeen },
      httpOk(F.searchPage(20, 21))))[0];
  const st = searchState({ page: 3, collected: p2.collected, bandSeen: p2.bandSeen },
    httpOk(F.searchPage(20, 1)));
  const out = run('Parse Search Results', st)[0];
  eq(out.hasMore, true, 'the band is retried as two narrower ones');
  eq(st.staticData.cwGrantRun.bandsSplit, 1, 'split despite being under the ceiling');
  eq(st.staticData.cwGrantRun.observedCap, 40, 'records the cap actually observed');
});

t('an EMPTY page below the ceiling really is exhaustion — no split', () => {
  const first = run('Parse Search Results', searchState({}, httpOk(F.searchPage(10))))[0];
  const st = searchState({ page: 2, collected: first.collected, bandSeen: first.bandSeen },
    httpOk(F.emptySearchPage));
  const out = run('Parse Search Results', st)[0];
  eq(out.hasMore, false, 'accepted as complete');
  eq(st.staticData.cwGrantRun.bandsSplit || 0, 0);
});

t('repeat detection is band-scoped, not global', () => {
  // A company already collected from ANOTHER band must not make this band look
  // exhausted the moment it appears.
  const already = P.parseSearchResults(F.searchPage(10)).profileUrls;
  const out = run('Parse Search Results',
    searchState({ band: { from: 10, to: 20 }, collected: already, bandSeen: [] },
      httpOk(F.searchPage(10))))[0];
  eq(out.hasMore, true, 'the band continues');
  eq(out.page, 2);
});

t('a 429 aborts the whole crawl, logs it, and never retries', () => {
  const out = run('Parse Search Results',
    searchState({ page: 2, collected: ['u1'], bandSeen: ['u1'] }, httpErr(429)))[0];
  eq(out.hasMore, false);
  eq(out.stopReason, 'http_429');
  ok(out.errors[0].includes('429'), 'logged');
  ok(out.errors[0].includes('premiumProxy'), 'suggests the premium proxy');
  eq(out.collected, ['u1'], 'URLs gathered before the block are kept');
});

t('a challenge page is a failure, NOT end-of-results', () => {
  const out = run('Parse Search Results', searchState({ page: 2 }, httpOk(F.cloudflarePage)))[0];
  eq(out.hasMore, false);
  ok(out.stopReason.startsWith('blocked_'), `stop reason: ${out.stopReason}`);
  ok(out.errors[0].includes('NOT as end-of-pagination'), 'explicitly distinguished');
});

t('a truncated response is a failure, NOT end-of-results', () => {
  const out = run('Parse Search Results',
    searchState({ page: 2 }, httpOk(F.searchPage(20).slice(0, 3000))))[0];
  eq(out.hasMore, false);
  ok(out.stopReason.startsWith('blocked_'), `stop reason: ${out.stopReason}`);
});

t('maxPages caps a band, warns, and treats the band as truncated', () => {
  // We stopped, the site did not — so the band is incomplete and gets split.
  const st = searchState({ page: 3 }, httpOk(F.searchPage(20)));
  st.nodeOutputs.Config = Object.assign({}, CONFIG, { maxPages: 3 });
  const out = run('Parse Search Results', st)[0];
  eq(out.stopReason, '', 'moved on to the first half');
  eq(out.hasMore, true, 'the band is retried as two narrower ones');
  ok(out.errors[0].includes('maxPages'), 'warns that results may remain');
  eq(st.staticData.cwGrantRun.bandsSplit, 1);
});

t('maxCompanies truncates the whole crawl', () => {
  const st = searchState({}, httpOk(F.searchPage(20)));
  st.nodeOutputs.Config = Object.assign({}, CONFIG, { maxCompanies: 5 });
  const out = run('Parse Search Results', st)[0];
  eq(out.collected.length, 5);
  eq(out.hasMore, false);
  eq(out.stopReason, 'max_companies_reached');
});

/* ---- the ~60-result ceiling ---- */

t('a band that comes back at the ceiling is bisected, not accepted', () => {
  const st = searchState({ page: 4, bandSeen: manyUrls(60) }, httpOk(F.emptySearchPage));
  const out = run('Parse Search Results', st)[0];
  eq(out.hasMore, true, 'the crawl continues into the halves');
  eq(out.band.from, SEED.from, 'first half starts at the campaign floor');
  ok(out.band.to < SEED.to, 'and ends below the original ceiling');
  eq(out.queue.length, 1, 'the second half is queued');
  eq(out.queue[0].to, SEED.to, 'and reaches the original top');
  eq(out.queue[0].from, out.band.to + 1, 'the halves are adjacent, with no gap');
  eq(st.staticData.cwGrantRun.bandsSplit, 1);
});

t('a band that comes back short is accepted as complete', () => {
  const st = searchState({ page: 2, bandSeen: manyUrls(37) }, httpOk(F.emptySearchPage));
  const out = run('Parse Search Results', st)[0];
  eq(out.hasMore, false, 'no split needed');
  eq(st.staticData.cwGrantRun.bandsSplit || 0, 0);
});

t('the next queued band restarts pagination at page 1', () => {
  const st = searchState({
    page: 5, band: { from: 10, to: 20 }, queue: [{ from: 21, to: 30 }],
    bandSeen: ['u1'], collected: ['u1'],
  }, httpOk(F.emptySearchPage));
  const out = run('Parse Search Results', st)[0];
  eq(out.hasMore, true);
  eq(out.band, { from: 21, to: 30 }, 'moved to the queued band');
  eq(out.page, 1, 'pagination restarts');
  eq(out.bandSeen, [], 'band-scoped repeat detection resets');
  eq(out.collected, ['u1'], 'the global list carries over');
});

t('a truncated band that cannot be split is reported, not swallowed', () => {
  const st = searchState({ band: { from: 100, to: 101 }, bandSeen: manyUrls(60) },
    httpOk(F.emptySearchPage));
  const out = run('Parse Search Results', st)[0];
  eq(out.hasMore, false);
  ok(out.errors[0].includes('too narrow to split'), `error: ${out.errors[0]}`);
  ok(out.errors[0].includes('unreachable'), 'says data is missing');
  ok(out.errors[0].includes('at='), 'names the other axis to narrow on');
});

t('autoSplitOnCeiling=false reproduces the old capped behaviour', () => {
  const st = searchState({ page: 4, bandSeen: manyUrls(60) }, httpOk(F.emptySearchPage));
  st.nodeOutputs.Config = Object.assign({}, CONFIG, { autoSplitOnCeiling: 'false' });
  const out = run('Parse Search Results', st)[0];
  eq(out.hasMore, false, 'stops at the ceiling, as before');
  eq(st.staticData.cwGrantRun.bandsSplit || 0, 0);
});

t('maxBands stops runaway subdivision and says why', () => {
  const st = searchState({ page: 4, bandSeen: manyUrls(60) }, httpOk(F.emptySearchPage));
  st.nodeOutputs.Config = Object.assign({}, CONFIG, { maxBands: 1 });
  const out = run('Parse Search Results', st)[0];
  ok(out.errors[0].includes('maxBands'), `error: ${out.errors[0]}`);
});

t('a split keeps both halves inside the same sector', () => {
  const st = searchState({ band: { nkd: '46', from: 4000000, to: 4000000000 }, page: 4,
    bandSeen: manyUrls(60) }, httpOk(F.emptySearchPage));
  const out = run('Parse Search Results', st)[0];
  eq(out.band.nkd, '46', 'first half stays in sector 46');
  eq(out.queue[0].nkd, '46', 'and so does the second');
});

t('the subdivision budget is per sector, not shared across the sweep', () => {
  /*
   * With a shared budget a 99-sector sweep gives each sector maxBands/99
   * splits and starves every one of them — which is how a sweep can return
   * FEWER companies than a single revenue crawl.
   */
  const st = searchState({ band: { nkd: '46', from: 4000000, to: 4000000000 }, page: 4,
    bandSeen: manyUrls(60) }, httpOk(F.emptySearchPage));
  st.staticData.cwGrantRun.bandsPerNkd = { '47': 500, '62': 500 };  // other sectors busy
  st.nodeOutputs.Config = Object.assign({}, CONFIG, { maxBands: 100 });
  const out = run('Parse Search Results', st)[0];
  eq(st.staticData.cwGrantRun.bandsSplit, 1, 'sector 46 still has its own budget');
  eq(out.errors, [], 'and is not blamed for other sectors\' usage');
});

/* ------------------------------------------------------------------ *
 * Emit Profile URLs
 * ------------------------------------------------------------------ */

t('Emit Profile URLs fans out one item per company', () => {
  const st = newState({ input: { collected: ['u1', 'u2', 'u3'], stopReason: 'no_results_empty' } });
  const out = run('Emit Profile URLs', st);
  eq(out.length, 3);
  eq(out.map((o) => o.profileUrl), ['u1', 'u2', 'u3']);
  ok(out.every((o) => o.hasCompany === true));
});

t('an empty run still emits one marker item so the loop cannot stall', () => {
  const st = newState({ input: { collected: [], stopReason: 'no_results_empty' } });
  const out = run('Emit Profile URLs', st);
  eq(out.length, 1, 'exactly one item');
  eq(out[0].hasCompany, false, 'flagged as the empty marker');
});

/* ------------------------------------------------------------------ *
 * Build Profile Request
 * ------------------------------------------------------------------ */

t('Build Profile Request uses the extracted href verbatim', () => {
  const url = 'https://www.companywall.com.mk/kompanija/' + F.ENCODED_SLUG + '/MMA8dAgq';
  const st = newState({ input: { hasCompany: true, profileUrl: url } });
  const out = run('Build Profile Request', st)[0];
  eq(out.targetUrl, url, 'never re-encoded or reconstructed');
});

t('Build Profile Request refuses anything that is not a /kompanija/ page', () => {
  const st = newState({ input: { profileUrl: 'https://www.companywall.com.mk/prebaruvanje?x=1' } });
  throws(() => run('Build Profile Request', st), /Refusing to fetch a non-profile URL/, 'allowlist');
});

/* ------------------------------------------------------------------ *
 * Parse Profile
 * ------------------------------------------------------------------ */

const PROFILE_URL = 'https://www.companywall.com.mk/kompanija/' + F.ENCODED_SLUG + '/MMA8dAgq';

function profileState(resp) {
  const st = newState({ input: resp });
  st.nodeOutputs['Build Profile Request'] = { profileUrl: PROFILE_URL, targetUrl: PROFILE_URL };
  st.staticData.cwGrantRun = { errors: [] };
  return st;
}

t('Parse Profile emits the 14 sheet columns in the brief\'s order', () => {
  const out = run('Parse Profile', profileState(httpOk(F.profilePage())))[0];
  eq(out.ok, true);
  eq(Object.keys(out).slice(0, 14), P.SHEET_HEADERS, 'the sheet columns lead the item');
  eq(out['EMBS'], '6543210');
  eq(out['Company Name'], 'ЕУРОИМПЕКС ДОО УВОЗ-ИЗВОЗ СКОПЈЕ');
  eq(out['NKD Code'], '46.710');
  eq(out['Phone Numbers'], '02/3221-455; 070 123 456');
  eq(out['Owners'], 'КИРИЛ ВОИНОВСКИ(50,00%); ГОРАН ВОИНОВСКИ(50,00%)');
  eq(out['Profile URL'], PROFILE_URL);
});

t('Date Scraped uses n8n\'s built-in current date/time', () => {
  const out = run('Parse Profile', profileState(httpOk(F.profilePage())))[0];
  eq(out['Date Scraped'], '2026-09-06T12:00:00.000+02:00', 'the mocked $now value');
});

t('a loss-making company is emitted normally and never filtered out', () => {
  const loss = F.FINANCIAL_TABLE_ASC.replace('<td>3.870.250,00</td>', '<td>-9.900.000,00</td>');
  const out = run('Parse Profile', profileState(httpOk(F.profilePage({ financial: loss }))))[0];
  eq(out.ok, true, 'not rejected');
  eq(out['Profit/Loss (latest year)'], -9900000, 'the loss is written as-is');
});

t('a failed profile fetch is classified, not thrown', () => {
  const out = run('Parse Profile', profileState(httpErr(500)))[0];
  eq(out.ok, false);
  ok(out.error.includes('profile page failed to load'), `error text: ${out.error}`);
  eq(out.profileUrl, PROFILE_URL, 'the URL is kept for the Errors tab');
});

t('a 403 says it was not retried by design', () => {
  const out = run('Parse Profile', profileState(httpErr(403)))[0];
  eq(out.ok, false);
  ok(out.error.includes('not retried by design'));
});

t('a request-level error (statusCode 0) is handled', () => {
  const out = run('Parse Profile', profileState({ error: 'ETIMEDOUT' }))[0];
  eq(out.ok, false);
  ok(out.error.includes('request error or timeout'));
});

t('a challenge page on a profile is routed to Errors with a premium hint', () => {
  const out = run('Parse Profile', profileState(httpOk(F.cloudflarePage)))[0];
  eq(out.ok, false);
  ok(out.error.includes('premiumProxy'), `error text: ${out.error}`);
});

t('a profile with no EMBS goes to Errors rather than risking a duplicate', () => {
  const noEmbs = F.profilePage({
    header: '<h1>ТЕСТ ДОО</h1><div><span>ЕДБ</span><span>4030995123456</span></div>',
    basic: '<aside><h2>ОСНОВНИ ИНФОРМАЦИИ</h2><div><span>НКЗ</span><span>46.710 - Трговија</span></div></aside>',
  });
  const out = run('Parse Profile', profileState(httpOk(noEmbs)))[0];
  eq(out.ok, false);
  ok(out.error.includes('EMBS field not found'), `error text: ${out.error}`);
  ok(out.error.includes('cannot deduplicate'), 'explains why it was not written');
});

t('a company with no contact details is written WITHOUT an Errors row', () => {
  // The bug this replaces: phones/emails/owners/managers counted as required,
  // so nearly every real company tripped the error branch.
  const out = run('Parse Profile', profileState(httpOk(F.profilePage({ contacts: '' }))))[0];
  eq(out.ok, true, 'still a usable lead');
  eq(out.hasMissing, false, 'NOT routed to the Errors tab');
  eq(out.missing, [], 'no required field is missing');
  ok(out.blank.includes('Phone Numbers'), 'recorded as an optional blank');
  eq(out['EMBS'], '6543210');
  eq(out['Phone Numbers'], '', 'the cell is simply empty');
});

t('a genuinely missing REQUIRED field still routes to the Errors tab', () => {
  const noNkd = F.profilePage({
    basic: '<aside><h2>ОСНОВНИ ИНФОРМАЦИИ</h2><div><span>ЕМБС</span><span>6543210</span></div></aside>',
  });
  const out = run('Parse Profile', profileState(httpOk(noNkd)))[0];
  eq(out.ok, true, 'the lead is still written');
  eq(out.hasMissing, true, 'but flagged');
  ok(out.missing.includes('NKD Code'));
});

t('a page the rules cannot read is a loud failure, not a blank row', () => {
  const junk = F.page('<main><div>totally different markup</div></main>');
  const out = run('Parse Profile', profileState(httpOk(junk)))[0];
  eq(out.ok, false, 'never written as an empty row');
  ok(out.error.includes('nothing could be extracted'), `error text: ${out.error}`);
  ok(out.error.includes('npm run probe'), 'points at the tool that diagnoses it');
});

t('a blank employee count alone never counts as missing', () => {
  const noEmp = F.FINANCIAL_TABLE_ASC.replace(/<tr><td>Просечен[\s\S]*?<\/tr>/, '');
  const out = run('Parse Profile', profileState(httpOk(F.profilePage({ financial: noEmp }))))[0];
  eq(out.ok, true);
  eq(out['Number of Employees'], '');
  eq(out.hasMissing, false, 'employees is explicitly optional');
});

/* ------------------------------------------------------------------ *
 * Check Duplicate — the per-company EMBS check
 * ------------------------------------------------------------------ */

function dedupeState(lookupResult, profileOverride) {
  const profile = Object.assign(
    run('Parse Profile', profileState(httpOk(F.profilePage())))[0],
    profileOverride || {}
  );
  const st = newState({ input: lookupResult });
  st.nodeOutputs['Parse Profile'] = profile;
  st.staticData.cwGrantRun = { errors: [] };
  return st;
}

t('an EMBS already in the sheet is skipped entirely', () => {
  const st = dedupeState({ EMBS: '6543210', 'Company Name': 'ЕУРОИМПЕКС ДОО УВОЗ-ИЗВОЗ СКОПЈЕ' });
  const out = run('Check Duplicate', st)[0];
  eq(out.__isNew, false, 'not written');
  eq(out.skippedAsDuplicate, true);
  eq(st.staticData.cwGrantRun.duplicatesSkipped, 1, 'counted');
});

t('an empty lookup result (alwaysOutputData) means "new"', () => {
  const st = dedupeState({});
  const out = run('Check Duplicate', st)[0];
  eq(out.__isNew, true);
  eq(out.embs, '6543210');
});

t('Check Duplicate emits a control item only, never the sheet row', () => {
  // A control key reaching autoMapInputData either adds a column to the user's
  // sheet or fails the append outright — it is not silently ignored.
  const out = run('Check Duplicate', dedupeState({}))[0];
  const leaked = P.SHEET_HEADERS.filter((h) => h in out);
  eq(leaked, [], 'no sheet columns on the control item');
});

t('Build Sheet Row emits exactly the 14 columns and nothing else', () => {
  const profile = run('Parse Profile', profileState(httpOk(F.profilePage())))[0];
  const st = newState({ input: { __isNew: true } });
  st.nodeOutputs['Parse Profile'] = profile;
  st.staticData.cwGrantRun = { errors: [] };

  const row = run('Build Sheet Row', st)[0];
  eq(Object.keys(row), P.SHEET_HEADERS, 'exact shape for auto-map');
  ok(!('__isNew' in row), 'no control key');
  ok(!('ok' in row) && !('missing' in row), 'no parse metadata');
  eq(row['EMBS'], '6543210');
  eq(st.staticData.cwGrantRun.rowsWritten, 1, 'counted as handed to the append node');
});

t('a different EMBS in the lookup result does not count as a match', () => {
  const st = dedupeState({ EMBS: '9999999' });
  eq(run('Check Duplicate', st)[0].__isNew, true);
});

t('a numeric EMBS from Sheets still matches the string form', () => {
  // Google Sheets can return a numeric cell as a JS number.
  const st = dedupeState({ EMBS: 6543210 });
  eq(run('Check Duplicate', st)[0].__isNew, false, 'still recognised as a duplicate');
});

t('a misconfigured sheet stops the run on company #1, not after the whole list', () => {
  const st = dedupeState({ error: { message: 'Sheet with name Leads not found' } });
  throws(() => run('Check Duplicate', st), /run was stopped/, 'aborts');
  try { run('Check Duplicate', st); } catch (e) {
    ok(e.message.includes('Sheet with name Leads not found'), 'quotes what Google said');
    ok(e.message.includes('sheetName'), 'names the setting to change');
    ok(e.message.includes('Leads'), 'shows the current value');
  }
});

t('a permission failure aborts the same way', () => {
  const st = dedupeState({ error: { message: 'The caller does not have permission' } });
  throws(() => run('Check Duplicate', st), /run was stopped/, 'aborts');
});

t('a failed lookup writes the lead and records the duplicate risk', () => {
  const st = dedupeState({ error: 'The Google Sheets API returned 503' });
  const out = run('Check Duplicate', st)[0];
  eq(out.__isNew, true, 'the lead is not lost');
  ok(st.staticData.cwGrantRun.errors[0].includes('lookup failed'), 'logged');
  ok(st.staticData.cwGrantRun.errors[0].includes('check this row by hand'), 'flagged for review');
});

/* ------------------------------------------------------------------ *
 * Build Error Row
 * ------------------------------------------------------------------ */

t('a hard failure produces an Errors row marked "not written"', () => {
  const failed = run('Parse Profile', profileState(httpErr(500)))[0];
  const st = newState({ input: failed });
  st.nodeOutputs['Parse Profile'] = failed;
  st.staticData.cwGrantRun = { errors: [] };

  const out = run('Build Error Row', st)[0];
  eq(Object.keys(out), P.ERROR_SHEET_HEADERS);
  eq(out['Written To Main Sheet'], 'no');
  eq(out['Profile URL'], PROFILE_URL);
  ok(out['Error'].includes('failed to load'));
});

t('a Google Sheets append that failed after its retries is logged, not lost', () => {
  const good = run('Parse Profile', profileState(httpOk(F.profilePage())))[0];
  const st = newState({ input: { error: 'The service is currently unavailable (503)' } });
  st.nodeOutputs['Parse Profile'] = good;
  st.staticData.cwGrantRun = { errors: [], rowsWritten: 1 };

  const out = run('Build Error Row', st)[0];
  eq(out['Written To Main Sheet'], 'no', 'the row did not land');
  ok(out['Error'].includes('Google Sheets append failed'), `error text: ${out['Error']}`);
  eq(st.staticData.cwGrantRun.rowsWritten, 0, 'the optimistic count is corrected');
});

t('an n8n error OBJECT is rendered readably, not as "[object Object]"', () => {
  // This is the shape n8n actually passes through with continueRegularOutput.
  const good = run('Parse Profile', profileState(httpOk(F.profilePage())))[0];
  const st = newState({
    input: {
      error: {
        message: 'The resource you are requesting could not be found',
        description: "Sheet 'Leads' not found in the spreadsheet",
        httpCode: '404',
      },
    },
  });
  st.nodeOutputs['Parse Profile'] = good;
  st.staticData.cwGrantRun = { errors: [], rowsWritten: 1 };

  const out = run('Build Error Row', st)[0];
  ok(!out['Error'].includes('[object Object]'), `must be readable, got: ${out['Error']}`);
  ok(out['Error'].includes("Sheet 'Leads' not found"), 'the actionable part survives');
  ok(out['Error'].includes('404'), 'the status code survives');
});

t('Run Summary names the cause when profiles were scraped but nothing was written', () => {
  const st = newState();
  st.staticData.cwGrantRun = {
    startedAt: '2026-09-06T10:00:00.000Z',
    profilesFetched: 12, rowsWritten: 0, duplicatesSkipped: 0,
    errors: ["[sheets] https://x: Google Sheets append failed after retries: Sheet 'Leads' not found"],
  };
  const out = run('Run Summary', st)[0];
  ok(out.diagnosis.includes('NO rows reached the sheet'), 'the failure is named');
  ok(out.diagnosis.includes('tab name'), 'points at the most likely cause');
  eq(out.sheetsErrors.length, 1, 'the Sheets errors are surfaced separately');
});

t('Run Summary stays quiet when a re-run legitimately writes nothing', () => {
  const st = newState();
  st.staticData.cwGrantRun = { profilesFetched: 12, rowsWritten: 0, duplicatesSkipped: 12, errors: [] };
  const out = run('Run Summary', st)[0];
  ok(out.diagnosis.includes('duplicate'), 'explains it as a normal re-run');
});

t('a partial success produces an Errors row marked "written"', () => {
  const partial = run('Parse Profile', profileState(httpOk(F.profilePage({ contacts: '' }))))[0];
  const st = newState({ input: partial });
  st.nodeOutputs['Parse Profile'] = partial;
  st.staticData.cwGrantRun = { errors: [] };

  const out = run('Build Error Row', st)[0];
  eq(out['Written To Main Sheet'], 'yes', 'the lead did reach the main sheet');
  eq(out['EMBS'], '6543210');
  ok(out['Missing Fields'].includes('Phone Numbers'), 'names the blank fields');
});

/* ------------------------------------------------------------------ *
 * Run Summary
 * ------------------------------------------------------------------ */

t('Run Summary reports the totals accumulated across the run', () => {
  const st = newState();
  st.staticData.cwGrantRun = {
    startedAt: '2026-09-06T10:00:00.000Z',
    searchPagesFetched: 4,
    profileUrlsFound: 63,
    profilesFetched: 61,
    profilesFailed: 2,
    duplicatesSkipped: 7,
    rowsWritten: 54,
    rowsWithMissingFields: 5,
    errorRowsWritten: 7,
    paginationStopReason: 'no_results_empty',
    errors: ['[profile] x: HTTP 500'],
  };
  const out = run('Run Summary', st)[0];
  eq(out.rowsWrittenToSheet, 54);
  eq(out.duplicatesSkipped, 7);
  eq(out.profilesFailed, 2);
  eq(out.errorCount, 1);
  eq(out.paginationStopReason, 'no_results_empty');
  ok(out.durationSeconds !== null, 'duration computed');
});

/* ------------------------------------------------------------------ *
 * End-to-end: search -> profiles -> dedupe -> sheet
 * ------------------------------------------------------------------ */

t('a whole run writes each company once and never writes a duplicate', () => {
  const sheet = [];               // stands in for the Google Sheet
  const errorSheet = [];
  const staticData = {};

  // --- pass 1: two full pages then an empty one
  const pages = [F.searchPage(3, 1), F.searchPage(3, 4), F.emptySearchPage];
  let state = { band: SEED_BAND, queue: [], page: 1, bandSeen: [], collected: [], errors: [] };
  let guard = 0;

  while (guard++ < 10) {
    const built = run('Build Search URL', {
      staticData, nodeOutputs: { Config: CONFIG }, input: state,
    })[0];

    const st = {
      staticData,
      nodeOutputs: { Config: CONFIG, 'Build Search URL': built },
      input: httpOk(pages[built.page - 1] || F.emptySearchPage),
    };
    state = run('Parse Search Results', st)[0];
    if (!state.hasMore) break;
  }
  eq(state.collected.length, 6, 'six companies across two pages');
  eq(state.stopReason, 'no_results_marker', 'stopped on the empty page');

  // --- pass 2: one profile per company, plus a deliberate repeat
  const queue = run('Emit Profile URLs', {
    staticData, nodeOutputs: { Config: CONFIG }, input: state,
  });
  eq(queue.length, 6);

  const withRepeat = queue.concat([queue[0]]);   // the same company offered twice

  for (const company of withRepeat) {
    const req = run('Build Profile Request', {
      staticData, nodeOutputs: { Config: CONFIG }, input: company,
    })[0];

    // Every 5th company fails to load, to exercise the error branch.
    const idx = withRepeat.indexOf(company);
    const resp = idx === 4 ? httpErr(500) : httpOk(F.profilePage());

    const profile = run('Parse Profile', {
      staticData,
      nodeOutputs: { Config: CONFIG, 'Build Profile Request': req },
      input: resp,
    })[0];

    if (!profile.ok) {                                   // "Profile OK?" false
      errorSheet.push(run('Build Error Row', {
        staticData, nodeOutputs: { Config: CONFIG, 'Parse Profile': profile }, input: profile,
      })[0]);
      continue;
    }

    // "Google Sheets: Lookup EMBS" with alwaysOutputData
    const hits = sheet.filter((r) => String(r['EMBS']) === String(profile['EMBS']));
    const lookupOut = hits.length ? hits : [{}];

    const checked = run('Check Duplicate', {
      staticData,
      nodeOutputs: { Config: CONFIG, 'Parse Profile': profile },
      input: lookupOut,
    })[0];

    if (!checked.__isNew) continue;                      // "Is New?" false -> skip

    const row = run('Build Sheet Row', {
      staticData, nodeOutputs: { Config: CONFIG, 'Parse Profile': profile }, input: checked,
    })[0];
    sheet.push(row);                                     // append

    if (profile.hasMissing) {                            // "Log Missing Fields?" true
      errorSheet.push(run('Build Error Row', {
        staticData, nodeOutputs: { Config: CONFIG, 'Parse Profile': profile }, input: profile,
      })[0]);
    }
  }

  // All six fixture companies share one ЕМБС, so the dedupe must collapse them.
  eq(sheet.length, 1, 'the shared EMBS was written exactly once');
  eq(errorSheet.length, 1, 'the one failed fetch was logged');
  eq(errorSheet[0]['Written To Main Sheet'], 'no');
  eq(new Set(sheet.map((r) => r['EMBS'])).size, sheet.length, 'no duplicate EMBS in the sheet');
  eq(Object.keys(sheet[0]), P.SHEET_HEADERS, 'the sheet row shape is exactly the brief\'s');

  const summary = run('Run Summary', { staticData, nodeOutputs: { Config: CONFIG }, input: {} })[0];
  eq(summary.duplicatesSkipped, 5, 'the five repeats were skipped');
  eq(summary.profilesFailed, 1);
  eq(summary.rowsWrittenToSheet, 1);
});

t('the crawl recovers the FULL list from a site that caps every search at 60', () => {
  /*
   * The bug this covers: a live run returned exactly 60 companies. CompanyWall
   * serves at most ~60 results per search however deep you page, so one search
   * can never return the whole campaign list. mockSite reproduces that cap.
   */
  const population = [];
  for (let i = 1; i <= 470; i++) {
    // Skewed like real revenue: most companies bunched just above the floor.
    const revenue = i <= 380
      ? 4000000 + i * 9000
      : 40000000 + (i - 380) * 40000000;
    population.push({ id: i, revenue });
  }
  const serve = F.mockSite(population, 60, 20);

  const staticData = {};
  let state = { band: SEED_BAND, queue: [], page: 1, bandSeen: [], collected: [], errors: [] };
  let requests = 0;

  while (state.hasMore !== false && requests < 4000) {
    const built = run('Build Search URL', {
      staticData, nodeOutputs: { Config: CONFIG }, input: state,
    })[0];
    requests++;
    state = run('Parse Search Results', {
      staticData,
      nodeOutputs: { Config: CONFIG, 'Build Search URL': built },
      input: httpOk(serve(built.targetUrl)),
    })[0];
  }

  eq(state.collected.length, population.length,
    `every company found (got ${state.collected.length} of ${population.length})`);
  eq(new Set(state.collected).size, population.length, 'and each exactly once');
  ok(staticData.cwGrantRun.bandsSplit > 0, 'the ceiling was detected and bands were split');
  eq(state.errors, [], 'no band was left stuck at the ceiling');

  const summary = run('Run Summary', { staticData, nodeOutputs: { Config: CONFIG }, input: {} })[0];
  eq(summary.diagnosis, '', 'nothing reported as unreachable');
  eq(summary.profileUrlsFound, population.length);
});

t('the crawl self-corrects when the site truncates BELOW the configured ceiling', () => {
  /*
   * The 143-result run: bands were being cut short below 60 and accepted as
   * complete, because only `found >= resultCeiling` triggered a split. Here the
   * site hands over just 25 per search and repeats a page rather than going
   * empty — with resultCeiling left at its default 60.
   */
  const population = [];
  for (let i = 1; i <= 400; i++) population.push({ id: i, revenue: 4000000 + i * 20000 });
  const serve = F.mockSite(population, 40, 20, { repeatPastPage: true });

  const staticData = {};
  const cfg = Object.assign({}, CONFIG, { maxBands: 5000 });
  let state = { band: SEED_BAND, queue: [], page: 1, bandSeen: [], collected: [], errors: [] };
  let guard = 0;

  while (state.hasMore !== false && guard++ < 20000) {
    const built = run('Build Search URL', { staticData, nodeOutputs: { Config: cfg }, input: state })[0];
    state = run('Parse Search Results', {
      staticData,
      nodeOutputs: { Config: cfg, 'Build Search URL': built },
      input: httpOk(serve(built.targetUrl)),
    })[0];
  }

  eq(state.collected.length, population.length,
    `all recovered without retuning resultCeiling (got ${state.collected.length})`);
  eq(staticData.cwGrantRun.observedCap, 40, 'the real cap was detected, not assumed');

  const summary = run('Run Summary', { staticData, nodeOutputs: { Config: cfg }, input: {} })[0];
  eq(summary.observedCapBelowConfigured, 40, 'reported so resultCeiling can be set correctly');
});

t('exhausting maxBands loses companies — and must say so, never look clean', () => {
  // This is what a too-low maxBands does: the crawl stops splitting and quietly
  // returns a fraction. It reproduces the reported 143-of-many symptom.
  const population = [];
  for (let i = 1; i <= 2000; i++) population.push({ id: i, revenue: 4000000 + i * 2000 });
  const serve = F.mockSite(population, 40, 20, { repeatPastPage: true });

  const staticData = {};
  const cfg = Object.assign({}, CONFIG, { maxBands: 12 });
  let state = { band: SEED_BAND, queue: [], page: 1, bandSeen: [], collected: [], errors: [] };
  let guard = 0;

  while (state.hasMore !== false && guard++ < 20000) {
    const built = run('Build Search URL', { staticData, nodeOutputs: { Config: cfg }, input: state })[0];
    state = run('Parse Search Results', {
      staticData,
      nodeOutputs: { Config: cfg, 'Build Search URL': built },
      input: httpOk(serve(built.targetUrl)),
    })[0];
  }

  ok(state.collected.length < population.length, 'incomplete, as expected');
  ok(state.errors.some((e) => e.includes('maxBands')), 'the cause is named in the errors');

  const summary = run('Run Summary', { staticData, nodeOutputs: { Config: cfg }, input: {} })[0];
  ok(summary.diagnosis.includes('ceiling') || summary.errors.some((e) => e.includes('maxBands')),
    'Run Summary does not present a truncated crawl as a clean one');
});

t('without subdivision the same site yields only 60 — the reported symptom', () => {
  const population = [];
  for (let i = 1; i <= 470; i++) population.push({ id: i, revenue: 4000000 + i * 9000 });
  const serve = F.mockSite(population, 60, 20);

  const staticData = {};
  const cfg = Object.assign({}, CONFIG, { autoSplitOnCeiling: 'false' });
  let state = { band: SEED_BAND, queue: [], page: 1, bandSeen: [], collected: [], errors: [] };
  let guard = 0;

  while (state.hasMore !== false && guard++ < 100) {
    const built = run('Build Search URL', { staticData, nodeOutputs: { Config: cfg }, input: state })[0];
    state = run('Parse Search Results', {
      staticData,
      nodeOutputs: { Config: cfg, 'Build Search URL': built },
      input: httpOk(serve(built.targetUrl)),
    })[0];
  }
  eq(state.collected.length, 60, 'reproduces the capped run exactly');
});

t('a dense band nobody can split is surfaced in the Run Summary', () => {
  // 200 companies all on the SAME revenue figure: no bisection can separate
  // them, so the run must say results are missing rather than look clean.
  const population = [];
  for (let i = 1; i <= 200; i++) population.push({ id: i, revenue: 4000000 });
  const serve = F.mockSite(population, 60, 20);

  const staticData = {};
  let state = { band: SEED_BAND, queue: [], page: 1, bandSeen: [], collected: [], errors: [] };
  let guard = 0;

  while (state.hasMore !== false && guard++ < 3000) {
    const built = run('Build Search URL', { staticData, nodeOutputs: { Config: CONFIG }, input: state })[0];
    state = run('Parse Search Results', {
      staticData,
      nodeOutputs: { Config: CONFIG, 'Build Search URL': built },
      input: httpOk(serve(built.targetUrl)),
    })[0];
  }

  const summary = run('Run Summary', { staticData, nodeOutputs: { Config: CONFIG }, input: {} })[0];
  ok(summary.diagnosis.includes('ceiling'), `diagnosis: ${summary.diagnosis}`);
  ok(summary.diagnosis.includes('may be missing'), 'does not pretend the run was complete');
});

t('a run that finds nothing completes cleanly instead of stalling', () => {
  const staticData = {};
  const built = run('Build Search URL', {
    staticData, nodeOutputs: { Config: CONFIG },
    input: { band: SEED_BAND, queue: [], page: 1, bandSeen: [], collected: [], errors: [] },
  })[0];
  const state = run('Parse Search Results', {
    staticData,
    nodeOutputs: { Config: CONFIG, 'Build Search URL': built },
    input: httpOk(F.emptySearchPage),
  })[0];
  eq(state.hasMore, false);

  const queue = run('Emit Profile URLs', { staticData, nodeOutputs: { Config: CONFIG }, input: state });
  eq(queue.length, 1, 'one marker item keeps the loop alive');
  eq(queue[0].hasCompany, false, '"Has Company?" routes it straight back to the loop');

  const summary = run('Run Summary', { staticData, nodeOutputs: { Config: CONFIG }, input: {} })[0];
  eq(summary.rowsWrittenToSheet, 0);
  eq(summary.profileUrlsFound, 0);
});

/* ------------------------------------------------------------------ */

console.log(`workflow: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  failures.forEach((f) => console.log(`  x ${f}`));
  process.exit(1);
}
