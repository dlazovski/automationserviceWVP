#!/usr/bin/env node
'use strict';

/*
 * Structural checks on the generated workflow JSON.
 *
 * n8n will not tell you about a dangling connection or a syntax error inside a
 * Code node until the workflow is running against the live site, which is an
 * expensive place to find out. This catches those before import.
 *
 * Run: node build/validate-workflow.js   (or `npm run verify`)
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const WF_FILE = path.join(ROOT, 'workflow', 'companywall-mk-grant-leads.json');
const { SHEET_HEADERS, ERROR_SHEET_HEADERS } = require('../src/parsers');

const errors = [];
const warnings = [];

function check(cond, message) {
  if (!cond) errors.push(message);
}

if (!fs.existsSync(WF_FILE)) {
  console.error(`${path.relative(ROOT, WF_FILE)} is missing — run \`npm run build\` first.`);
  process.exit(1);
}

const wf = JSON.parse(fs.readFileSync(WF_FILE, 'utf8'));
const byName = new Map(wf.nodes.map((n) => [n.name, n]));

/* ---- graph integrity ---- */

check(wf.nodes.length > 0, 'workflow has no nodes');
check(wf.settings && wf.settings.executionOrder === 'v1', 'executionOrder must be v1');

const names = wf.nodes.map((n) => n.name);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
check(dupes.length === 0, `duplicate node names: ${dupes.join(', ')}`);

const ids = wf.nodes.map((n) => n.id);
check(new Set(ids).size === ids.length, 'duplicate node ids');

const targeted = new Set();
for (const [source, conn] of Object.entries(wf.connections)) {
  check(byName.has(source), `connection source "${source}" is not a node`);
  for (const outputs of conn.main || []) {
    for (const link of outputs || []) {
      check(byName.has(link.node), `"${source}" connects to unknown node "${link.node}"`);
      targeted.add(link.node);
    }
  }
}

// Every non-trigger, non-sticky node must be reachable.
for (const n of wf.nodes) {
  if (n.type === 'n8n-nodes-base.stickyNote') continue;
  if (n.type === 'n8n-nodes-base.manualTrigger') continue;
  check(targeted.has(n.name), `node "${n.name}" has no incoming connection (unreachable)`);
}

/* ---- trigger ---- */

const triggers = wf.nodes.filter((n) => /trigger/i.test(n.type));
check(triggers.length === 1 && triggers[0].type === 'n8n-nodes-base.manualTrigger',
  'the workflow must have exactly one Manual Trigger (it is run on demand, not on a schedule)');

/* ---- loop wiring ---- */

const morePages = wf.connections['More Pages?'].main;
check(morePages[0][0].node === 'Build Search URL',
  'More Pages? true branch must loop back to Build Search URL');
check(morePages[1][0].node === 'Emit Profile URLs',
  'More Pages? false branch must go to Emit Profile URLs');

const companyLoop = wf.connections['Loop Companies'].main;
check(companyLoop[0][0].node === 'Run Summary', 'Loop Companies "done" output must go to Run Summary');
check(companyLoop[1][0].node === 'Has Company?', 'Loop Companies "loop" output must go to Has Company?');

// Every terminal branch inside the loop must return to Loop Companies, or the
// run stalls after the first company that takes that branch.
const returnsToLoop = [
  'Has Company?', 'Is New?', 'Log Missing Fields?', 'Google Sheets: Append Error Row',
];
for (const name of returnsToLoop) {
  const outs = (wf.connections[name].main || []).flat().map((l) => l.node);
  check(outs.includes('Loop Companies'),
    `"${name}" must have a branch returning to Loop Companies, or the run stalls`);
}

const profileOk = wf.connections['Profile OK?'].main;
check(profileOk[0][0].node === 'Google Sheets: Lookup EMBS',
  'Profile OK? true branch must go to the EMBS duplicate lookup');
check(profileOk[1][0].node === 'Build Error Row',
  'Profile OK? false branch must go to Build Error Row, so a failure is logged and the run continues');

const isNew = wf.connections['Is New?'].main;
check(isNew[0][0].node === 'Build Sheet Row', 'Is New? true branch must go through Build Sheet Row');
check(isNew[1][0].node === 'Loop Companies',
  'Is New? false branch must skip the company (no duplicate row, no update)');

// The dedupe check must sit between the profile parse and the append — never
// after it, and never as a separate bulk pass.
const dedupePath = ['Profile OK?', 'Google Sheets: Lookup EMBS', 'Check Duplicate', 'Is New?',
  'Build Sheet Row', 'Google Sheets: Append Row'];
for (let i = 0; i < dedupePath.length - 1; i++) {
  const outs = (wf.connections[dedupePath[i]].main || []).flat().map((l) => l.node);
  check(outs.includes(dedupePath[i + 1]),
    `dedupe path broken: "${dedupePath[i]}" must feed "${dedupePath[i + 1]}"`);
}

/* ---- rate limiting: a Wait must precede every outbound request ---- */

const httpNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
check(httpNodes.length === 2, `expected 2 HTTP Request nodes, found ${httpNodes.length}`);

for (const http of httpNodes) {
  const feeders = Object.entries(wf.connections)
    .filter(([, c]) => (c.main || []).some((o) => (o || []).some((l) => l.node === http.name)))
    .map(([s]) => s);

  check(feeders.length > 0, `"${http.name}" has no upstream node`);
  for (const f of feeders) {
    const node = byName.get(f);
    check(node && node.type === 'n8n-nodes-base.wait',
      `"${http.name}" is fed by "${f}" which is not a Wait node — every outbound request needs a delay`);
  }

  check(http.retryOnFail === false, `"${http.name}" must not retry on failure (403/429 must not be hammered)`);
  check(http.onError === 'continueRegularOutput',
    `"${http.name}" must continue on error so the Code node can classify 403/429`);

  const respOpts = ((http.parameters.options || {}).response || {}).response || {};
  check(respOpts.neverError === true, `"${http.name}" needs response.neverError so non-2xx reaches the Code node`);
  check(respOpts.fullResponse === true, `"${http.name}" needs fullResponse so statusCode is visible`);
  check(respOpts.responseFormat === 'text', `"${http.name}" must return raw text, not parsed JSON`);

  check(http.parameters.url === 'https://app.scrapingbee.com/api/v1/',
    `"${http.name}" must call ScrapingBee, not the site directly`);

  const qp = (http.parameters.queryParameters || {}).parameters || [];
  check(qp.some((p) => p.name === 'url'), `"${http.name}" is missing the ScrapingBee "url" parameter`);
  check(!qp.some((p) => p.name === 'js_scenario'), `"${http.name}" must not use js_scenario`);
  check(!qp.some((p) => p.name === 'api_key'),
    `"${http.name}" must take the API key from the credential, not a hardcoded query parameter`);
  check(http.credentials && http.credentials.httpQueryAuth,
    `"${http.name}" must use a Query Auth credential for the ScrapingBee api_key`);
}

// The brief asks for 1-2s; the site's own guidance is 3-5s, so 1-5s is allowed.
for (const w of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.wait')) {
  check(w.parameters.unit === 'seconds', `Wait node "${w.name}" must be configured in seconds`);
  const amt = Number(w.parameters.amount);
  check(amt >= 1 && amt <= 5, `Wait node "${w.name}" is ${amt}s — must be within 1-5s`);
  if (amt < 3) {
    warnings.push(`Wait node "${w.name}" is ${amt}s (the brief's 1-2s). The site asks for 3-5s — raise it if you see 429s.`);
  }
}

/* ---- concurrency ---- */

for (const s of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.splitInBatches')) {
  check(s.parameters.batchSize === 1, `"${s.name}" must use batchSize 1 (one request in flight at a time)`);
}

/* ---- scope guards ---- */

const executable = wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');

// Authenticated-only endpoints used by the sister workflows' scope rules.
for (const forbidden of ['/Company/CompanyBonitet', '/Company/CompanyPersons', '/CompanyBonitet?', '/CompanyPersons?']) {
  const offender = executable.find((n) => JSON.stringify(n.parameters).includes(forbidden));
  check(!offender, `"${offender && offender.name}" builds a request to the authenticated-only endpoint ${forbidden}`);
}

const sidOffender = executable.find((n) => /[?&]sid=/.test(JSON.stringify(n.parameters)));
check(!sidOffender, `"${sidOffender && sidOffender.name}" builds a ?sid= URL, which requires an authenticated session`);

const profileBuilder = byName.get('Build Profile Request');
check(profileBuilder && /companywall\\\.com\\\.mk\\\/kompanija/.test(profileBuilder.parameters.jsCode),
  'Build Profile Request is missing the /kompanija/ URL allowlist guard');

check(!executable.some((n) => /companywall/i.test(JSON.stringify(n.credentials || {}))),
  'a node carries CompanyWall credentials; this workflow must not log in');

/* ---- the campaign filter must survive verbatim ---- */

const cfg = byName.get('Config');
check(!!cfg, 'Config node is missing');
const cfgAssignments = ((cfg.parameters.assignments || {}).assignments || []);
const searchUrl = (cfgAssignments.find((a) => a.name === 'searchUrl') || {}).value || '';
check(searchUrl.includes('dsm[0].From=4000000'),
  'Config.searchUrl must keep the campaign revenue floor dsm[0].From=4000000 unchanged');
check(searchUrl.includes('dsm[0].To=4000000000') && searchUrl.includes('dsm[1].Code=48'),
  'Config.searchUrl must keep the brief\'s filter parameters unchanged');
check(!/[?&]p=\d/.test(searchUrl), 'Config.searchUrl must not carry a &p= page parameter — pagination appends it');

/*
 * The URL builder may do exactly two things to the configured URL: set the
 * current revenue band, and append "&p=N". It must never reconstruct the
 * filter from parts.
 */
const urlBuilder = byName.get('Build Search URL');
check(urlBuilder && urlBuilder.parameters.jsCode.includes('withRevenueBand(cfg.searchUrl, band.from, band.to)'),
  'Build Search URL must derive its URL from Config.searchUrl via withRevenueBand');
check(urlBuilder && urlBuilder.parameters.jsCode.includes('buildSearchUrl(bandUrl, page)'),
  'Build Search URL must append pagination via buildSearchUrl');

// The seed band must be READ from the configured URL, never hardcoded — that is
// what keeps the campaign's revenue floor authoritative.
const initRun = byName.get('Init Run');
check(initRun && /readRevenueBand\(searchUrl\)/.test(initRun.parameters.jsCode),
  'Init Run must read the seed revenue band out of Config.searchUrl, not hardcode one');
// (No "must not contain 4000000" check here: every Code node carries an inlined
// copy of parsers.js, which legitimately holds the campaign URL as a default.)

/*
 * Subdivision must PARTITION the band, never widen it. Verified functionally
 * here so a future edit to splitBand cannot silently start emitting a half that
 * reaches below the campaign floor.
 */
{
  const P = require('../src/parsers');
  const seed = P.readRevenueBand(searchUrl);
  check(seed && seed.from === 4000000, 'the seed band must start at the campaign floor');

  let bands = [seed];
  for (let depth = 0; depth < 8; depth++) {
    const next = [];
    for (const b of bands) {
      const halves = P.splitBand(b.from, b.to);
      if (!halves) continue;
      check(halves[0].from === b.from && halves[1].to === b.to,
        `splitBand(${b.from},${b.to}) must cover the original range exactly`);
      check(halves[1].from === halves[0].to + 1,
        `splitBand(${b.from},${b.to}) must leave no gap and no overlap`);
      check(halves[0].from >= seed.from && halves[1].from >= seed.from,
        `splitBand(${b.from},${b.to}) must never reach below the campaign floor`);
      next.push(halves[0], halves[1]);
    }
    bands = next.slice(0, 64);
    if (!bands.length) break;
  }

  // And the rewrite must touch nothing but the two revenue parameters.
  const mask = (u) => u.replace(/dsm\[0\]\.(From|To)=\d+/g, 'X');
  check(mask(P.withRevenueBand(searchUrl, 123, 456)) === mask(searchUrl),
    'withRevenueBand must leave every other query parameter byte-identical');
}

/* ---- no profit/loss filtering anywhere ---- */

/*
 * The brief is explicit: ALL companies reach the sheet, profitable or not.
 * There must be no IF node keyed on the profit column, and no comparison
 * operator applied to a profit value anywhere in the executable nodes.
 */
for (const n of executable) {
  const blob = JSON.stringify(n.parameters);
  if (n.type === 'n8n-nodes-base.if') {
    check(!/[Pp]rofit|добивка|загуба/.test(blob),
      `IF node "${n.name}" branches on a profit/loss value — the brief forbids filtering on it`);
  }
}
const profitFilter = executable.find((n) =>
  /\b(profit|Profit\/Loss)\b[^\n]{0,40}[<>]=?\s*0/.test(JSON.stringify(n.parameters)));
check(!profitFilter, `"${profitFilter && profitFilter.name}" compares profit against zero — no profit filtering is allowed`);

/* ---- Google Sheets nodes ---- */

const sheetNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
check(sheetNodes.length === 3, `expected 3 Google Sheets nodes (lookup + 2 appends), found ${sheetNodes.length}`);

const lookup = byName.get('Google Sheets: Lookup EMBS');
check(!!lookup, 'the EMBS duplicate-lookup node is missing');
if (lookup) {
  check(lookup.parameters.operation === 'read', 'the lookup node must use the read operation');
  check(lookup.alwaysOutputData === true,
    'the lookup node needs alwaysOutputData — with no match it returns zero items and stalls the loop');
  const filters = ((lookup.parameters.filtersUI || {}).values || []);
  check(filters.length === 1 && filters[0].lookupColumn === 'EMBS',
    'the lookup node must filter on the EMBS column');
}

for (const name of ['Google Sheets: Append Row', 'Google Sheets: Append Error Row']) {
  const node = byName.get(name);
  check(!!node, `${name} is missing`);
  if (!node) continue;
  check(node.parameters.operation === 'append',
    `"${name}" must use append, not appendOrUpdate — a duplicate must be skipped, never updated`);
  check(node.parameters.columns.mappingMode === 'autoMapInputData',
    `"${name}" must auto-map, so the row keys match the sheet headers`);
  check(node.onError === 'continueRegularOutput',
    `"${name}" must continue on error so one Sheets hiccup does not abort the run`);
  if (String(node.parameters.documentId.value).includes('googleSheetId')) {
    // fine: it reads the Config placeholder
  }
}

const sheetIdCfg = (cfgAssignments.find((a) => a.name === 'googleSheetId') || {}).value || '';
if (String(sheetIdCfg).startsWith('REPLACE_WITH')) {
  warnings.push('Config.googleSheetId is still the placeholder — set it after import.');
}

/* ---- Code nodes must actually compile ---- */

const codeNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code');
check(codeNodes.length === 10, `expected 10 Code nodes, found ${codeNodes.length}`);

for (const c of codeNodes) {
  const src = c.parameters.jsCode;
  try {
    // Wrapped as an async function body, which is how n8n evaluates it.
    new vm.Script(`(async function(){${src}\n})`, { filename: `${c.name}.js` });
  } catch (err) {
    errors.push(`Code node "${c.name}" does not parse: ${err.message}`);
  }
  check(src.includes('function parseProfile') && src.includes('function htmlToLines'),
    `Code node "${c.name}" is missing the inlined parser library`);
  check(!src.includes('require('), `Code node "${c.name}" uses require(), unavailable in the n8n sandbox`);
  check(!src.includes('module.exports'), `Code node "${c.name}" still contains module.exports`);
}

/*
 * The node feeding the main append must emit ONLY the sheet columns. With
 * autoMapInputData an unmatched key is not ignored: n8n either adds a column to
 * the user's sheet or fails the append outright.
 */
const rowBuilder = byName.get('Build Sheet Row');
check(rowBuilder && /for \(const key of SHEET_HEADERS\)/.test(rowBuilder.parameters.jsCode),
  'Build Sheet Row must build the row strictly from SHEET_HEADERS');
check(rowBuilder && !/__isNew/.test(rowBuilder.parameters.jsCode),
  'Build Sheet Row must not carry a control key into the Google Sheets node');

/* ---- the sheet contract ---- */

const headerBlob = codeNodes.map((c) => c.parameters.jsCode).join('\n');
for (const h of SHEET_HEADERS.concat(ERROR_SHEET_HEADERS)) {
  check(headerBlob.includes(`'${h}'`), `sheet column "${h}" does not appear in any Code node`);
}
check(SHEET_HEADERS.length === 14, `the brief specifies 14 main columns, parsers.js has ${SHEET_HEADERS.length}`);
check(SHEET_HEADERS[0] === 'EMBS' && SHEET_HEADERS[SHEET_HEADERS.length - 1] === 'Date Scraped',
  'main sheet columns must start with EMBS and end with Date Scraped');

/* ---- credentials / placeholders ---- */

for (const n of wf.nodes) {
  for (const cred of Object.values(n.credentials || {})) {
    if (String(cred.id).startsWith('REPLACE_WITH')) {
      warnings.push(`"${n.name}" credential "${cred.name}" must be re-selected after import.`);
    }
  }
}

// No API key may ever be committed into the workflow JSON.
const blob = JSON.stringify(wf);
check(!/api_key["']?\s*[:=]\s*["'][A-Za-z0-9]{16,}/.test(blob),
  'the workflow JSON appears to contain a hardcoded API key');

/* ---- report ---- */

console.log(`Validated ${path.relative(ROOT, WF_FILE)}`);
console.log(`  ${wf.nodes.length} nodes, ${Object.keys(wf.connections).length} connected sources`);

if (warnings.length) {
  console.log('\nExpected post-import steps:');
  warnings.forEach((w) => console.log(`  - ${w}`));
}

if (errors.length) {
  console.log(`\n${errors.length} problem(s):`);
  errors.forEach((e) => console.log(`  x ${e}`));
  process.exit(1);
}

console.log('\nAll structural checks passed.');
