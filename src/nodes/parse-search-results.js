// @inject-parsers
// Node: "Parse Search Results" (Code, run once for all items)
//
// Extracts every company's profile link (href) from one search-results page,
// then decides what to fetch next: another page of this revenue band, the next
// band in the queue, or nothing.
//
// No other field is read from the search page — every data field comes from the
// individual profile pages in pass 2.
//
// Emits exactly ONE item carrying the accumulated state, so the loop always has
// a single item flowing through it.

const cfg = $('Config').first().json;
const state = $('Build Search URL').first().json;
const resp = $input.first().json || {};

const maxPages = Number(cfg.maxPages) > 0 ? Number(cfg.maxPages) : 50;
const maxCompanies = Number(cfg.maxCompanies) > 0 ? Number(cfg.maxCompanies) : 0;
const maxBands = Number(cfg.maxBands) > 0 ? Number(cfg.maxBands) : 200;
// The site stops serving results past ~60 per search however deep you page.
const ceiling = Number(cfg.resultCeiling) > 0 ? Number(cfg.resultCeiling) : 60;
const autoSplit = String(cfg.autoSplitOnCeiling) !== 'false';

const band = state.band;
const queue = Array.isArray(state.queue) ? state.queue.slice() : [];
const collected = Array.isArray(state.collected) ? state.collected.slice() : [];
const bandSeen = Array.isArray(state.bandSeen) ? state.bandSeen.slice() : [];
const errors = Array.isArray(state.errors) ? state.errors.slice() : [];

const staticData = $getWorkflowStaticData('global');
const run = staticData.cwGrantRun || (staticData.cwGrantRun = { errors: [], bands: [] });
if (!run.errors) run.errors = [];
if (!run.bands) run.bands = [];

/** Abandon the whole crawl: the site is refusing us, not merely out of results. */
function abort(reason, message) {
  errors.push(message);
  run.errors.push(message);
  run.paginationStopReason = reason;
  return [{
    json: { band: band, queue: queue, page: state.page, bandSeen: bandSeen,
      collected: collected, errors: errors, hasMore: false, stopReason: reason },
  }];
}

/**
 * This band is finished. Record it, subdivide it if it came back at the
 * ceiling, then move on to the next band in the queue.
 */
function finishBand(reason) {
  const found = bandSeen.length;
  let didSplit = false;

  run.bandsSearched = (run.bandsSearched || 0) + 1;

  /*
   * A band that returns >= the ceiling was almost certainly truncated by the
   * site, not exhausted — there is no way to tell "exactly 60 matches" from
   * "60 shown of 400". So treat it as truncated and bisect it: the two halves
   * partition the band exactly, and each is a narrower search that should fall
   * under the ceiling. Repeat until every band comes back short.
   *
   * This is the one mechanism that makes the run COMPLETE rather than capped.
   */
  if (autoSplit && found >= ceiling) {
    run.bandsAtCeiling = (run.bandsAtCeiling || 0) + 1;
    const halves = splitBand(band.from, band.to);

    if (!halves) {
      const msg = '[search] band ' + formatBand(band) + ' returned ' + found +
        ' results (at the ~' + ceiling + ' ceiling) but is too narrow to split further. ' +
        'Some companies in this revenue range may be unreachable through this search.';
      errors.push(msg);
      run.errors.push(msg);
    } else if (run.bandsSearched + queue.length >= maxBands) {
      const msg = '[search] band ' + formatBand(band) + ' is at the ceiling but Config.maxBands=' +
        maxBands + ' was reached. Raise maxBands to keep subdividing.';
      errors.push(msg);
      run.errors.push(msg);
    } else {
      // Depth-first: work the halves before anything queued earlier, so a dense
      // range is broken all the way down while it is still in hand.
      queue.unshift(halves[0], halves[1]);
      run.bandsSplit = (run.bandsSplit || 0) + 1;
      didSplit = true;
    }
  }

  run.bands.push({
    band: formatBand(band),
    found: found,
    pages: state.page,
    stopReason: reason,
    split: didSplit,
  });

  const next = queue.shift();
  if (!next) {
    run.paginationStopReason = reason;
    return [{
      json: { band: null, queue: [], page: state.page, bandSeen: [],
        collected: collected, errors: errors, hasMore: false, stopReason: reason },
    }];
  }

  return [{
    json: { band: next, queue: queue, page: 1, bandSeen: [],
      collected: collected, errors: errors, hasMore: true, stopReason: '' },
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
  return abort('http_' + statusCode,
    '[search] band ' + formatBand(band) + ' page ' + state.page + ': HTTP ' + statusCode +
    ' from ScrapingBee/site. Crawl stopped, no auto-retry. ' +
    'If this repeats, set Config.premiumProxy = "true".');
}
if (statusCode === 0 || statusCode >= 500) {
  return abort('http_' + statusCode,
    '[search] band ' + formatBand(band) + ' page ' + state.page + ': HTTP ' + statusCode +
    ' (upstream/ScrapingBee failure). Crawl stopped.');
}
if (statusCode >= 400) {
  return abort('http_' + statusCode,
    '[search] band ' + formatBand(band) + ' page ' + state.page + ': HTTP ' + statusCode + '. Crawl stopped.');
}

const parsed = parseSearchResults(body);

// A blocked or truncated response must never be read as "no more results", or
// the run would end early and silently.
const blocking = (parsed.flags || []).filter(isBlockingFlag);
if (blocking.length) {
  return abort('blocked_' + blocking[0],
    '[search] band ' + formatBand(band) + ' page ' + state.page + ': response flagged ' +
    blocking.join(', ') + '. Treated as a failure, NOT as end-of-pagination. ' +
    'If this is CLOUDFLARE_CHALLENGE or CAPTCHA, set Config.premiumProxy = "true".');
}

run.searchPagesFetched = (run.searchPagesFetched || 0) + 1;

/* ---- END-OF-BAND DETECTION  <<< ADJUST HERE IF NEEDED >>> -------------- *
 * Signal 1 (primary): zero /kompanija/ profile links on the page. This is the
 *   "results container is empty" test and depends on no site wording at all.
 * Signal 2: an explicit Cyrillic "no results" phrase (NO_RESULTS_PATTERNS in
 *   the inlined parser library) — recorded as the stop reason so a first run
 *   shows which signal actually fired.
 * Signal 3: the page returned only companies already seen IN THIS BAND, which
 *   means the site served an earlier page again instead of 404-ing past the
 *   last one.
 *
 * Note signal 3 is band-scoped, not global: a company already collected from
 * another band must not make this band look exhausted.
 */

if (parsed.rowCount === 0) {
  return finishBand(parsed.noResultsMarker ? 'no_results_marker' : 'no_results_empty');
}

const seenInBand = new Set(bandSeen);
const seenGlobal = new Set(collected);
let freshInBand = 0;
for (const url of parsed.profileUrls) {
  if (seenInBand.has(url)) continue;
  seenInBand.add(url);
  bandSeen.push(url);
  freshInBand++;
  // Bands partition the revenue range, so a company should appear in exactly
  // one. The global guard is belt-and-braces against a fuzzy site-side filter.
  if (!seenGlobal.has(url)) {
    seenGlobal.add(url);
    collected.push(url);
  }
}

if (freshInBand === 0) {
  return finishBand('repeated_results');
}

run.profileUrlsFound = collected.length;

if (maxCompanies > 0 && collected.length >= maxCompanies) {
  collected.length = maxCompanies;
  run.profileUrlsFound = collected.length;
  run.paginationStopReason = 'max_companies_reached';
  return [{
    json: { band: null, queue: [], page: state.page, bandSeen: [],
      collected: collected, errors: errors, hasMore: false, stopReason: 'max_companies_reached' },
  }];
}

if (state.page >= maxPages) {
  const msg = '[search] band ' + formatBand(band) + ' hit Config.maxPages=' + maxPages +
    ' — there may be more results in this band. Raise maxPages if that is unexpected.';
  errors.push(msg);
  run.errors.push(msg);
  return finishBand('max_pages_reached');
}

return [{
  json: {
    band: band,
    queue: queue,
    page: state.page + 1,
    bandSeen: bandSeen,
    collected: collected,
    errors: errors,
    hasMore: true,
    stopReason: '',
  },
}];
