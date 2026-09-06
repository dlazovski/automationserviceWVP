// @inject-parsers
// Node: "Run Summary" (Code, run once for all items)
//
// Reads the counters accumulated in workflow static data and emits one summary
// item. Runs after the per-company loop reports "done".

const staticData = $getWorkflowStaticData('global');
const run = staticData.cwGrantRun || {};

const finishedAt = new Date().toISOString();
const durationSec = run.startedAt
  ? Math.round((new Date(finishedAt) - new Date(run.startedAt)) / 1000)
  : null;

return [{
  json: {
    startedAt: run.startedAt || null,
    finishedAt: finishedAt,
    durationSeconds: durationSec,
    searchUrl: run.searchUrl || '',
    searchPagesFetched: run.searchPagesFetched || 0,
    paginationStopReason: run.paginationStopReason || '',
    profileUrlsFound: run.profileUrlsFound || 0,
    profilesFetched: run.profilesFetched || 0,
    profilesFailed: run.profilesFailed || 0,
    duplicatesSkipped: run.duplicatesSkipped || 0,
    rowsWrittenToSheet: run.rowsWritten || 0,
    rowsWithMissingFields: run.rowsWithMissingFields || 0,
    errorRowsWritten: run.errorRowsWritten || 0,
    errorCount: (run.errors || []).length,
    errors: run.errors || [],
  },
}];
