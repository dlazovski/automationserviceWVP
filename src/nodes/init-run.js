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
/*
 * The NKD (industry) axis.
 *
 * Revenue bisection alone has a floor: once a band cannot be narrowed further,
 * the site's ~60-result cap still bites, and a single revenue sweep tops out
 * well short of the full population. NKD is a second, INDEPENDENT axis and a
 * natural partition — each company has one primary activity — so slicing by it
 * shrinks the per-search result count directly instead of fighting the cap.
 * Each (NKD sector x revenue band) search is then far below the ceiling.
 *
 * An empty list keeps whatever `at=` is already in searchUrl, i.e. the previous
 * single-sweep behaviour.
 */
let nkdCodes = cfg.nkdCodes;
if (typeof nkdCodes === 'string') {
  nkdCodes = nkdCodes.trim().toLowerCase() === 'all'
    ? allNkdSectors()
    : nkdCodes.split(',');
}
if (!Array.isArray(nkdCodes)) nkdCodes = nkdCodes ? [nkdCodes] : [];
nkdCodes = nkdCodes.map((c) => String(c).trim()).filter((c) => c.length > 0);
if (nkdCodes.length === 0) nkdCodes = [readNkd(searchUrl)];

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
  nkdCodes: nkdCodes,
  nkdCodeCount: nkdCodes.length,
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
  /*
   * The accumulated profile URLs live HERE, not in the item that travels the
   * loop. Carrying a growing array through every iteration meant n8n retained
   * a full copy of it for every node execution — thousands of copies of a list
   * that reaches thousands of entries. That is what makes a long sweep run out
   * of memory. One copy in static data costs the same as one iteration used to.
   */
  collected: [],
};

/*
 * One starting band per NKD code. They are worked in order; whenever one is
 * truncated it is bisected and its halves are pushed to the FRONT, so a dense
 * sector is broken all the way down while it is still in hand.
 */
const starting = nkdCodes.map((nkd) => ({ nkd: nkd, from: seed.from, to: seed.to }));

return [{
  json: {
    band: starting[0],
    queue: starting.slice(1),
    page: 1,
    bandSeen: [],
    errors: [],
  },
}];
