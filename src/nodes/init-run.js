// @inject-parsers
// Node: "Init Run" (Code, run once for all items)
//
// Resets the run-level counters and seeds the revenue-band work queue.
//
// Workflow static data SURVIVES between executions, so this reset must happen at
// the start of every run or the Run Summary totals accumulate forever.

const cfg = $('Config').first().json;

const searchUrl = String(cfg.searchUrl || '').trim();
if (!/^https:\/\/www\.companywall\.com\.mk\/prebaruvanje\?/.test(searchUrl)) {
  throw new Error(
    'Config.searchUrl must be the CompanyWall.mk /prebaruvanje search URL. Got: ' + searchUrl
  );
}
if (String(cfg.googleSheetId || '').indexOf('REPLACE_WITH') === 0) {
  throw new Error(
    'Config.googleSheetId is still the placeholder. Set it to the Google Sheet ID before running.'
  );
}

/*
 * The first band is READ OUT of the configured URL, never invented. Everything
 * the crawl does from here is a subdivision of that one range, so the campaign
 * filter is preserved exactly: every request still carries
 * dsm[0].From >= 4000000.
 */
const seed = readRevenueBand(searchUrl);
if (!seed) {
  throw new Error(
    'Could not read dsm[0].From / dsm[0].To out of Config.searchUrl. The revenue band is ' +
    'what lets the crawl get past the site\'s ~60-result ceiling, so those two parameters ' +
    'must be present in the URL.'
  );
}
if (!(seed.to > seed.from)) {
  throw new Error('Config.searchUrl has dsm[0].To (' + seed.to + ') <= dsm[0].From (' +
    seed.from + '), which matches nothing.');
}

const staticData = $getWorkflowStaticData('global');
staticData.cwGrantRun = {
  startedAt: new Date().toISOString(),
  searchUrl: searchUrl,
  seedBand: formatBand(seed),
  searchPagesFetched: 0,
  bandsSearched: 0,
  bandsSplit: 0,
  bandsAtCeiling: 0,
  profileUrlsFound: 0,
  profilesFetched: 0,
  profilesFailed: 0,
  duplicatesSkipped: 0,
  rowsWritten: 0,
  rowsSentToSheet: 0,
  rowsWithMissingFields: 0,
  rowsWithBlankContacts: 0,
  errorRowsWritten: 0,
  paginationStopReason: '',
  bands: [],
  errors: [],
};

return [{
  json: {
    band: seed,
    queue: [],
    page: 1,
    bandSeen: [],
    collected: [],
    errors: [],
  },
}];
