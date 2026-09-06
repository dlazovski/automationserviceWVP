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
 * Build Search URL
 * ------------------------------------------------------------------ */

t('Build Search URL leaves page 1 unpaginated and appends &p= after that', () => {
  const st = newState({ input: { page: 1, collected: [], errors: [] } });
  eq(run('Build Search URL', st)[0].targetUrl, P.DEFAULT_SEARCH_URL);

  st.input = { page: 4, collected: ['a'], errors: [] };
  const out = run('Build Search URL', st)[0];
  eq(out.targetUrl, P.DEFAULT_SEARCH_URL + '&p=4');
  eq(out.collected, ['a'], 'accumulated URLs carried forward');
});

t('Build Search URL passes the ScrapingBee render flags through', () => {
  const st = newState({ input: { page: 1, collected: [], errors: [] } });
  st.nodeOutputs.Config = Object.assign({}, CONFIG, { renderJs: 'true', premiumProxy: 'true' });
  const out = run('Build Search URL', st)[0];
  eq(out.renderJs, 'true');
  eq(out.premiumProxy, 'true');
});

/* ------------------------------------------------------------------ *
 * Parse Search Results — the pagination loop
 * ------------------------------------------------------------------ */

function searchState(page, collected, resp) {
  const st = newState({ input: resp });
  st.nodeOutputs['Build Search URL'] = { page, collected: collected || [], errors: [] };
  st.staticData.cwGrantRun = { errors: [] };
  return st;
}

t('a full page asks for the next one', () => {
  const st = searchState(1, [], httpOk(F.searchPage(20)));
  const out = run('Parse Search Results', st)[0];
  eq(out.hasMore, true, 'wants another page');
  eq(out.page, 2, 'advances the page counter');
  eq(out.collected.length, 20);
});

t('pagination accumulates across pages without duplicating', () => {
  let st = searchState(1, [], httpOk(F.searchPage(20, 1)));
  const p1 = run('Parse Search Results', st)[0];

  st = searchState(2, p1.collected, httpOk(F.searchPage(20, 21)));
  const p2 = run('Parse Search Results', st)[0];

  eq(p2.collected.length, 40, 'two full pages accumulated');
  eq(new Set(p2.collected).size, 40, 'all distinct');
  eq(p2.hasMore, true);
});

t('an empty page ends pagination', () => {
  const st = searchState(3, ['u1', 'u2'], httpOk(F.emptySearchPage));
  const out = run('Parse Search Results', st)[0];
  eq(out.hasMore, false, 'stops');
  eq(out.stopReason, 'no_results_marker');
  eq(out.collected, ['u1', 'u2'], 'already-collected URLs are kept');
  eq(out.errors, [], 'a normal end of pagination is not an error');
});

t('an empty page with no "no results" wording still ends pagination', () => {
  const st = searchState(3, ['u1'], httpOk(F.emptySearchPageNoMarker));
  const out = run('Parse Search Results', st)[0];
  eq(out.hasMore, false);
  eq(out.stopReason, 'no_results_empty');
});

t('a repeated page ends pagination instead of looping forever', () => {
  const first = run('Parse Search Results', searchState(1, [], httpOk(F.searchPage(10))))[0];
  // The site serves page 1 again rather than 404-ing past the last page.
  const out = run('Parse Search Results', searchState(2, first.collected, httpOk(F.searchPage(10))))[0];
  eq(out.hasMore, false);
  eq(out.stopReason, 'repeated_results');
  eq(out.collected.length, 10, 'nothing duplicated');
});

t('a 429 stops pagination, logs it, and never retries', () => {
  const st = searchState(2, ['u1'], httpErr(429));
  const out = run('Parse Search Results', st)[0];
  eq(out.hasMore, false);
  eq(out.stopReason, 'http_429');
  ok(out.errors[0].includes('429'), 'logged');
  ok(out.errors[0].includes('premiumProxy'), 'suggests the premium proxy');
  eq(out.collected, ['u1'], 'rows gathered before the block are kept');
});

t('a challenge page is a failure, NOT end-of-pagination', () => {
  const st = searchState(2, [], httpOk(F.cloudflarePage));
  const out = run('Parse Search Results', st)[0];
  eq(out.hasMore, false);
  ok(out.stopReason.startsWith('blocked_'), `stop reason: ${out.stopReason}`);
  ok(out.errors[0].includes('NOT as end-of-pagination'), 'explicitly distinguished');
});

t('a truncated response is a failure, NOT end-of-pagination', () => {
  const st = searchState(2, [], httpOk(F.searchPage(20).slice(0, 3000)));
  const out = run('Parse Search Results', st)[0];
  eq(out.hasMore, false);
  ok(out.stopReason.startsWith('blocked_'), `stop reason: ${out.stopReason}`);
});

t('maxPages caps the crawl and says so', () => {
  const st = searchState(3, [], httpOk(F.searchPage(20)));
  st.nodeOutputs.Config = Object.assign({}, CONFIG, { maxPages: 3 });
  const out = run('Parse Search Results', st)[0];
  eq(out.hasMore, false);
  eq(out.stopReason, 'max_pages_reached');
  ok(out.errors[0].includes('maxPages'), 'warns that results may remain');
});

t('maxCompanies truncates the list', () => {
  const st = searchState(1, [], httpOk(F.searchPage(20)));
  st.nodeOutputs.Config = Object.assign({}, CONFIG, { maxCompanies: 5 });
  const out = run('Parse Search Results', st)[0];
  eq(out.collected.length, 5);
  eq(out.hasMore, false);
  eq(out.stopReason, 'max_companies_reached');
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

t('a profile missing optional fields is still written, and flagged', () => {
  const out = run('Parse Profile', profileState(httpOk(F.profilePage({ contacts: '' }))))[0];
  eq(out.ok, true, 'still a usable lead');
  eq(out.hasMissing, true, 'flagged for the Errors tab');
  ok(out.missing.includes('Phone Numbers'));
  eq(out['EMBS'], '6543210');
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
  let state = { page: 1, collected: [], errors: [] };
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

t('a run that finds nothing completes cleanly instead of stalling', () => {
  const staticData = {};
  const built = run('Build Search URL', {
    staticData, nodeOutputs: { Config: CONFIG }, input: { page: 1, collected: [], errors: [] },
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
