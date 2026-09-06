// @inject-parsers
// Node: "Parse Profile" (Code, run once for all items)
//
// Extracts every field the brief asks for from one company profile page and
// shapes the Google Sheets row.
//
// ERROR HANDLING: this node NEVER throws. A failed fetch, a challenge page or a
// missing ЕМБС is classified as `ok: false` and routed to the "Errors" tab; the
// loop then continues with the next company. Nothing is ever silently dropped.
//
// NO PROFIT/LOSS FILTERING happens here or anywhere else in this workflow. A
// loss-making company is written to the sheet exactly like a profitable one —
// the brief filters on that column manually, afterwards.

const company = $('Build Profile Request').first().json;
const resp = $input.first().json || {};

const staticData = $getWorkflowStaticData('global');
const run = staticData.cwGrantRun || (staticData.cwGrantRun = { errors: [] });
if (!run.errors) run.errors = [];

// n8n's built-in current date/time. `$now` is a Luxon DateTime in the Code node;
// the `typeof` guard keeps the same source runnable in the offline simulator.
const scrapedAt = (typeof $now !== 'undefined' && $now && typeof $now.toISO === 'function')
  ? $now.toISO()
  : new Date().toISOString();

const profileUrl = company.profileUrl || company.targetUrl || '';

function fail(error) {
  run.profilesFailed = (run.profilesFailed || 0) + 1;
  run.errors.push('[profile] ' + profileUrl + ': ' + error);
  return [{
    json: {
      ok: false,
      embs: '',
      profileUrl: profileUrl,
      name: '',
      error: error,
      missing: [],
      hasMissing: false,
      scrapedAt: scrapedAt,
    },
  }];
}

/* ---- HTTP-level checks ------------------------------------------------ */

const statusCode = Number(resp.statusCode !== undefined ? resp.statusCode : (resp.error ? 0 : 200));

let body = resp.body !== undefined ? resp.body : (resp.data !== undefined ? resp.data : '');
if (typeof body !== 'string') {
  try { body = JSON.stringify(body); } catch (e) { body = String(body); }
}

if (statusCode === 0) {
  return fail('profile page failed to load (request error or timeout)');
}
if (statusCode >= 400) {
  return fail('profile page failed to load: HTTP ' + statusCode +
    (statusCode === 403 || statusCode === 429 ? ' (rate limited/blocked; not retried by design)' : ''));
}

const flags = diagnoseResponse(body);
const blocking = flags.filter(isBlockingFlag);
if (blocking.length) {
  return fail('profile page did not load correctly: ' + blocking.join(', ') +
    (blocking.indexOf('CLOUDFLARE_CHALLENGE') >= 0 || blocking.indexOf('CAPTCHA') >= 0
      ? '. Set Config.premiumProxy = "true" and re-run.'
      : ''));
}

/* ---- Parse ------------------------------------------------------------ */

const p = parseProfile(body);
run.profilesFetched = (run.profilesFetched || 0) + 1;

// ЕМБС is the deduplication key. Without it the per-company duplicate check
// cannot run, so the row goes to the "Errors" tab instead of the main sheet
// rather than risking a duplicate.
if (!p.embs) {
  return fail('EMBS field not found — cannot deduplicate, row not written to the main sheet' +
    (p.missing.length ? ' (also missing: ' + p.missing.filter((m) => m !== 'EMBS').join(', ') + ')' : ''));
}

const row = buildSheetRow(p, profileUrl, scrapedAt);

// "Number of Employees" is optional by the brief: blank, never an error.
const missing = p.missing.filter((m) => m !== 'Number of Employees');
if (missing.length) run.rowsWithMissingFields = (run.rowsWithMissingFields || 0) + 1;

return [{
  json: Object.assign({}, row, {
    ok: true,
    embs: p.embs,
    name: p.name,
    profileUrl: profileUrl,
    error: '',
    missing: missing,
    hasMissing: missing.length > 0,
    parseNotes: p.notes,
    financialYears: p.financialYears,
    scrapedAt: scrapedAt,
  }),
}];
