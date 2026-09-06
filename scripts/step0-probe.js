#!/usr/bin/env node
'use strict';

/*
 * Step 0 — live verification. RUN THIS BEFORE THE FIRST FULL WORKFLOW RUN.
 *
 * The repo was built without network access to companywall.com.mk (and without
 * any raw HTML from it), so every selector and label in src/parsers.js is an
 * assumption. This script makes exactly two real ScrapingBee calls:
 *
 *   1. one search-results page (the campaign URL, with pagination applied), and
 *   2. one company profile page, picked from the first call's results,
 *
 * saves the raw HTML to tmp/, runs the EXACT parsers the workflow uses against
 * it, and reports every field that could not be found.
 *
 * Cost: 2 ScrapingBee credits (more with --premium).
 *
 * Usage:
 *   SCRAPINGBEE_API_KEY=xxxx node scripts/step0-probe.js
 *   SCRAPINGBEE_API_KEY=xxxx node scripts/step0-probe.js --page 2 --premium
 *
 * Flags:
 *   --page <n>       search page to fetch                (default 1)
 *   --profile <url>  probe this profile instead of auto-picking one
 *   --url <url>      override the campaign search URL
 *   --premium        use ScrapingBee's premium/stealth proxy
 *   --render-js      ask ScrapingBee to render JavaScript
 *   --search-only    skip the profile call (1 credit)
 *   --compare-pages  also fetch "&p=1" and compare it to page 1 with no &p
 */

const fs = require('fs');
const path = require('path');
const P = require('../src/parsers');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tmp');
const WAIT_MS = 2000; // the same courtesy delay the workflow uses

function parseArgs(argv) {
  const out = {
    page: 1, profile: null, url: P.DEFAULT_SEARCH_URL,
    premium: false, renderJs: false, searchOnly: false, comparePages: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--premium') out.premium = true;
    else if (a === '--render-js') out.renderJs = true;
    else if (a === '--search-only') out.searchOnly = true;
    else if (a === '--compare-pages') out.comparePages = true;
    else if (a === '--page') out.page = Number(argv[++i]) || 1;
    else if (a === '--profile') out.profile = argv[++i];
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bar(label) {
  console.log('\n' + '='.repeat(72));
  console.log(label);
  console.log('='.repeat(72));
}

function report(label, value, opts) {
  const o = opts || {};
  const empty = value === '' || value === null || value === undefined ||
    (Array.isArray(value) && value.length === 0);
  const level = empty ? (o.optional ? 'WARN' : 'FAIL') : 'OK  ';
  const shown = Array.isArray(value)
    ? (value.length ? `[${value.length}] ${value.join(' | ')}` : '(none)')
    : (empty ? '(not found)' : String(value));
  console.log(`  [${level}] ${label.padEnd(26)} ${shown}`);
  return !empty;
}

async function scrapingBeeGet(apiKey, targetUrl, opts) {
  const qs = new URLSearchParams({
    api_key: apiKey,
    url: targetUrl,
    render_js: opts.renderJs ? 'true' : 'false',
    premium_proxy: opts.premium ? 'true' : 'false',
  });
  const started = Date.now();
  const res = await fetch(`https://app.scrapingbee.com/api/v1/?${qs.toString()}`);
  const body = await res.text();
  return { statusCode: res.status, body, ms: Date.now() - started };
}

function save(name, body) {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, name);
  fs.writeFileSync(file, body, 'utf8');
  return path.relative(ROOT, file);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/*')[1]);
    return;
  }

  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) {
    console.error('SCRAPINGBEE_API_KEY is not set.\n' +
      'Copy the key from the ScrapingBee credential already configured in n8n:\n' +
      '  SCRAPINGBEE_API_KEY=xxxx npm run probe');
    process.exit(2);
  }

  let hardFailures = 0;

  /* ---- 1. search page --------------------------------------------- */

  const searchUrl = P.buildSearchUrl(args.url, args.page);
  bar(`1. SEARCH PAGE (p=${args.page})`);
  console.log(searchUrl);

  const search = await scrapingBeeGet(apiKey, searchUrl, args);
  console.log(`\n  HTTP ${search.statusCode} · ${search.body.length} bytes · ${search.ms}ms`);
  console.log(`  saved: ${save(`search-p${args.page}.html`, search.body)}`);

  if (search.statusCode !== 200) {
    console.log('\n  The search call did not return 200.');
    if (search.statusCode === 401 || search.statusCode === 403) {
      console.log('  401/403 from ScrapingBee usually means the API key is wrong or out of credits.');
    }
    console.log(`  Body starts: ${search.body.slice(0, 300)}`);
    process.exit(1);
  }

  const flags = P.diagnoseResponse(search.body);
  console.log(`  flags: ${flags.length ? flags.join(', ') : '(none)'}`);
  if (flags.some(P.isBlockingFlag)) {
    console.log('\n  The site did not serve real content. Re-run with --premium.');
    process.exit(1);
  }

  const parsedSearch = P.parseSearchResults(search.body);
  console.log(`\n  profile links found: ${parsedSearch.rowCount}`);
  if (parsedSearch.rowCount === 0) {
    console.log('  >>> ZERO links. Either this page really is past the last result, or');
    console.log('      PROFILE_HREF_RE / isProfilePath in src/parsers.js need adjusting.');
    console.log(`      "no results" marker: ${parsedSearch.noResultsMarker || '(none detected)'}`);
    console.log(`      Open ${path.join('tmp', `search-p${args.page}.html`)} and check the anchor shape.`);
    hardFailures++;
  } else {
    parsedSearch.profileUrls.slice(0, 5).forEach((u, i) => console.log(`    ${i + 1}. ${u}`));
    if (parsedSearch.rowCount > 5) console.log(`    … and ${parsedSearch.rowCount - 5} more`);
  }

  /* ---- 1b. optional: is "&p=1" the same as no &p? ------------------ */

  if (args.comparePages && args.page === 1) {
    bar('1b. PAGINATION CHECK — "no &p" vs "&p=1"');
    await sleep(WAIT_MS);
    const alt = await scrapingBeeGet(apiKey, args.url + '&p=1', args);
    const altParsed = P.parseSearchResults(alt.body);
    console.log(`  no &p : ${parsedSearch.rowCount} links`);
    console.log(`  &p=1  : ${altParsed.rowCount} links (HTTP ${alt.statusCode})`);
    const same = JSON.stringify(parsedSearch.profileUrls) === JSON.stringify(altParsed.profileUrls);
    console.log(`  => "&p=1" is ${same ? 'equivalent to' : 'DIFFERENT from'} omitting &p.`);
    if (!same) {
      console.log('     The workflow requests page 1 with no &p. If that is wrong, change');
      console.log('     buildSearchUrl() in src/parsers.js to always append &p=.');
    }
    save('search-p1-explicit.html', alt.body);
  }

  /* ---- 2. profile page -------------------------------------------- */

  if (args.searchOnly) {
    bar('DONE (--search-only)');
    process.exit(hardFailures ? 1 : 0);
  }

  const profileUrl = args.profile || parsedSearch.profileUrls[0];
  if (!profileUrl) {
    console.log('\nNo profile URL to probe. Pass one with --profile <url>.');
    process.exit(1);
  }

  await sleep(WAIT_MS);
  bar('2. PROFILE PAGE');
  console.log(profileUrl);

  const prof = await scrapingBeeGet(apiKey, profileUrl, args);
  console.log(`\n  HTTP ${prof.statusCode} · ${prof.body.length} bytes · ${prof.ms}ms`);
  console.log(`  saved: ${save('profile.html', prof.body)}`);

  if (prof.statusCode !== 200) {
    console.log('  The profile call did not return 200.');
    process.exit(1);
  }

  const pFlags = P.diagnoseResponse(prof.body, 'profile');
  console.log(`  flags: ${pFlags.length ? pFlags.join(', ') : '(none)'}`);
  if (pFlags.some(P.isBlockingFlag)) {
    console.log('\n  Blocked. Re-run with --premium.');
    process.exit(1);
  }

  const p = P.parseProfile(prof.body);

  bar('3. FIELD COVERAGE — every [FAIL] needs a fix in src/parsers.js');
  let ok = 0;
  const fields = [
    ['(a) Company Name', p.name, {}],
    ['(b) EDB', p.edb, {}],
    ['(c) EMBS', p.embs, {}],
    ['(d) Date Founded', p.dateFounded, {}],
    ['(e) Phone Numbers', p.phones, {}],
    ['(f) Emails', p.emails, {}],
    ['(g) Owners', p.owners, {}],
    ['(h) Managers', p.managers, {}],
    ['(i) NKD Code', p.nkdCode, {}],
    ['(j) Profit/Loss', p.profit, {}],
    ['(k) Revenue', p.revenue, {}],
    ['(l) Employees', p.employees, { optional: true }],
  ];
  for (const [label, value, opts] of fields) if (report(label, value, opts)) ok++;

  console.log(`\n  ${ok}/${fields.length} fields extracted.`);
  if (p.missing.length) {
    console.log(`  missing: ${p.missing.join(', ')}`);
    hardFailures += p.missing.filter((m) => m !== 'Number of Employees').length;
  }
  if (p.notes.length) console.log(`  notes:   ${p.notes.join(', ')}`);

  /* ---- 4. the year-ordering assumption ----------------------------- */

  bar('4. FINANCIAL SUMMARY — check the year-column assumption');
  const tables = P.parseHtmlTables(prof.body);
  console.log(`  <table> elements found: ${tables.length}`);
  console.log(`  year columns detected:  ${JSON.stringify(p.financialYears)}`);
  console.log(`  latest year used:       ${p.profitYear || p.revenueYear || '(none)'}`);
  const profitRow = P.readFinancialRow(tables, P.htmlToLines(prof.body), P.PROFIT_LABEL_RE);
  if (profitRow.found) {
    console.log(`  Добивка/загуба by year: ${JSON.stringify(profitRow.byYear)}`);
    console.log(`  alignment strategy:     ${profitRow.strategy}`);
    console.log(`  latest is rightmost:    ${profitRow.rightmostIsLatest}`);
    if (!profitRow.rightmostIsLatest) {
      console.log('  >>> The columns run NEWEST-FIRST. The parser already selects by max year,');
      console.log('      so this is handled — but confirm the values above look right.');
    }
  } else {
    console.log('  >>> The Добивка/загуба row was not found. Open tmp/profile.html and adjust');
    console.log('      PROFIT_LABEL_RE / REVENUE_LABEL_RE in src/parsers.js.');
    console.log('      If the table is absent from the raw HTML entirely, it is rendered by');
    console.log('      JavaScript — re-run with --render-js and set Config.renderJs = "true".');
  }

  bar(hardFailures ? `NOT READY — ${hardFailures} field(s) need attention` : 'READY');
  if (hardFailures) {
    console.log('Open the saved HTML in tmp/, fix src/parsers.js, and re-run the probe.');
    console.log('Then: npm run verify, and re-import the workflow.');
  } else {
    console.log('All required fields extracted. Run `npm run verify` and import the workflow.');
  }
  process.exit(hardFailures ? 1 : 0);
}

main().catch((err) => {
  console.error('\nProbe failed:', err && err.message ? err.message : err);
  process.exit(1);
});
