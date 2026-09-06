// @inject-parsers
// Node: "Init Run" (Code, run once for all items)
//
// Resets the run-level counters and seeds the pagination state at page 1.
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

const staticData = $getWorkflowStaticData('global');
staticData.cwGrantRun = {
  startedAt: new Date().toISOString(),
  searchUrl: searchUrl,
  searchPagesFetched: 0,
  profileUrlsFound: 0,
  profilesFetched: 0,
  profilesFailed: 0,
  duplicatesSkipped: 0,
  rowsWritten: 0,
  rowsWithMissingFields: 0,
  errorRowsWritten: 0,
  paginationStopReason: '',
  errors: [],
};

return [{
  json: {
    page: 1,
    collected: [],
    errors: [],
  },
}];
