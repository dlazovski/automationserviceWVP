// @inject-parsers
// Node: "Parse Search Results" (Code, run once for all items)
//
// Extracts every company's profile link (href) from one search-results page and
// decides whether to request another page.
//
// No other field is read from the search page — every data field comes from the
// individual profile pages in pass 2.
//
// Emits exactly ONE item carrying the accumulated state, so the pagination loop
// always has a single item flowing through it.

const cfg = $('Config').first().json;
const state = $('Build Search URL').first().json;
const resp = $input.first().json || {};

const maxPages = Number(cfg.maxPages) > 0 ? Number(cfg.maxPages) : 50;
const maxCompanies = Number(cfg.maxCompanies) > 0 ? Number(cfg.maxCompanies) : 0;

const collected = Array.isArray(state.collected) ? state.collected.slice() : [];
const errors = Array.isArray(state.errors) ? state.errors.slice() : [];

const staticData = $getWorkflowStaticData('global');
const run = staticData.cwGrantRun || (staticData.cwGrantRun = { errors: [] });
if (!run.errors) run.errors = [];

function stop(reason, message) {
  if (message) {
    errors.push(message);
    run.errors.push(message);
  }
  run.paginationStopReason = reason;
  return [{
    json: {
      page: state.page,
      collected: collected,
      errors: errors,
      hasMore: false,
      stopReason: reason,
    },
  }];
}

/* ---- HTTP-level checks ------------------------------------------------ *
 * The HTTP node runs with neverError + fullResponse, so a non-2xx arrives here
 * as data rather than as a thrown error and can be classified properly.
 */

const statusCode = Number(resp.statusCode !== undefined ? resp.statusCode : (resp.error ? 0 : 200));

let body = resp.body !== undefined ? resp.body : (resp.data !== undefined ? resp.data : '');
if (typeof body !== 'string') {
  try { body = JSON.stringify(body); } catch (e) { body = String(body); }
}

if (statusCode === 403 || statusCode === 429) {
  // No auto-retry by design: retrying a 403/429 is what escalates an IP block.
  return stop('http_' + statusCode,
    '[search] page ' + state.page + ': HTTP ' + statusCode + ' from ScrapingBee/site. ' +
    'Pagination stopped, no auto-retry. If this repeats, set Config.premiumProxy = "true".');
}
if (statusCode === 0 || statusCode >= 500) {
  return stop('http_' + statusCode,
    '[search] page ' + state.page + ': HTTP ' + statusCode + ' (upstream/ScrapingBee failure). Pagination stopped.');
}
if (statusCode >= 400) {
  return stop('http_' + statusCode,
    '[search] page ' + state.page + ': HTTP ' + statusCode + '. Pagination stopped.');
}

const parsed = parseSearchResults(body);

// A blocked or truncated response must never be read as "no more results", or
// the run would end early and silently.
const blocking = (parsed.flags || []).filter(isBlockingFlag);
if (blocking.length) {
  return stop('blocked_' + blocking[0],
    '[search] page ' + state.page + ': response flagged ' + blocking.join(', ') +
    '. Treated as a failure, NOT as end-of-pagination. ' +
    'If this is CLOUDFLARE_CHALLENGE or CAPTCHA, set Config.premiumProxy = "true".');
}

run.searchPagesFetched = (run.searchPagesFetched || 0) + 1;

/* ---- END-OF-PAGINATION DETECTION  <<< ADJUST HERE IF NEEDED >>> -------- *
 * Signal 1 (primary): zero /kompanija/ profile links on the page. This is the
 *   "results container is empty" test and depends on no site wording at all.
 * Signal 2: an explicit Cyrillic "no results" phrase (see NO_RESULTS_PATTERNS
 *   in the inlined parser library) — logged so a first run shows which signal
 *   actually fired.
 * Signal 3: the page returned only companies already collected, which means the
 *   site served page 1 again instead of 404-ing past the last page.
 *
 * If a first live run stops too early, or never stops, these are the three
 * places to look: PROFILE_HREF_RE / isProfilePath (signal 1) and
 * NO_RESULTS_PATTERNS (signal 2) in src/parsers.js.
 */

if (parsed.rowCount === 0) {
  return stop(parsed.noResultsMarker ? 'no_results_marker' : 'no_results_empty', null);
}

const seen = new Set(collected);
const fresh = [];
for (const url of parsed.profileUrls) {
  if (seen.has(url)) continue;
  seen.add(url);
  fresh.push(url);
}

if (fresh.length === 0) {
  return stop('repeated_results', null);
}

let merged = collected.concat(fresh);
let truncated = false;
if (maxCompanies > 0 && merged.length >= maxCompanies) {
  merged = merged.slice(0, maxCompanies);
  truncated = true;
}

run.profileUrlsFound = merged.length;

const hasMore = !truncated && state.page < maxPages;
let stopReason = '';
if (truncated) {
  stopReason = 'max_companies_reached';
} else if (!hasMore) {
  stopReason = 'max_pages_reached';
  const msg = '[search] hit Config.maxPages=' + maxPages +
    ' — there may be more results. Raise maxPages if that is unexpected.';
  errors.push(msg);
  run.errors.push(msg);
}
if (stopReason) run.paginationStopReason = stopReason;

return [{
  json: {
    page: state.page + 1,
    collected: merged,
    errors: errors,
    hasMore: hasMore,
    stopReason: stopReason,
  },
}];
