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

/*
 * A run that fetched profiles but wrote no rows is the failure mode that looks
 * like "nothing happened": every append errored, and because the Errors tab
 * lives in the same spreadsheet its appends failed too, so the sheet stays
 * empty and silent. Name the likely cause here, where it is actually visible.
 */
const sheetsErrors = (run.errors || []).filter((e) => String(e).indexOf('[sheets]') === 0 ||
  String(e).indexOf('[dedupe]') === 0);

let diagnosis = '';

/*
 * A band that could not be subdivided below the ceiling means results in that
 * revenue range are unreachable through this search. Say so loudly: the run
 * otherwise looks like a clean success while quietly missing companies.
 */
const unsplittable = (run.bands || []).filter((b) => b.found >= 60 && !b.split);
if (unsplittable.length) {
  diagnosis = unsplittable.length + ' revenue band(s) came back at the site\'s ~60-result ' +
    'ceiling and could not be split further: ' +
    unsplittable.map((b) => b.band).join(', ') +
    '. Companies in those ranges may be missing. Raise Config.maxBands, or narrow ' +
    'Config.searchUrl (for example by NKD code) and run once per slice.';
}

if ((run.profilesFetched || 0) > 0 && (run.rowsWritten || 0) === 0) {
  if (sheetsErrors.length) {
    diagnosis = 'Profiles were scraped but NO rows reached the sheet, and Google Sheets ' +
      'returned an error. See sheetsErrors below. Most likely: the tab name in Config ' +
      '(sheetName / errorSheetName) does not match a real tab, or row 1 does not hold ' +
      'the 14 headers spelled exactly, or the credential lacks write access to this file.';
  } else if ((run.rowsSentToSheet || 0) > 0) {
    diagnosis = 'Rows WERE sent to the Google Sheets node and it reported no error, but ' +
      'nothing appeared in the sheet. With auto-map that means the node found no columns ' +
      'to write into: check that row 1 of the tab holds the 14 headers, spelled exactly, ' +
      'and that the tab name matches Config.sheetName.';
  } else if ((run.duplicatesSkipped || 0) > 0) {
    diagnosis = 'Every company was skipped as a duplicate — their EMBS values are already ' +
      'in the sheet. This is normal on a re-run.';
  }
}

return [{
  json: {
    startedAt: run.startedAt || null,
    diagnosis: diagnosis,
    sheetsErrors: sheetsErrors,
    finishedAt: finishedAt,
    durationSeconds: durationSec,
    searchUrl: run.searchUrl || '',
    searchPagesFetched: run.searchPagesFetched || 0,
    seedBand: run.seedBand || '',
    bandsSearched: run.bandsSearched || 0,
    bandsSplit: run.bandsSplit || 0,
    bandsAtCeiling: run.bandsAtCeiling || 0,
    bands: run.bands || [],
    paginationStopReason: run.paginationStopReason || '',
    profileUrlsFound: run.profileUrlsFound || 0,
    profilesFetched: run.profilesFetched || 0,
    profilesFailed: run.profilesFailed || 0,
    duplicatesSkipped: run.duplicatesSkipped || 0,
    rowsWrittenToSheet: run.rowsWritten || 0,
    rowsWithMissingFields: run.rowsWithMissingFields || 0,
    rowsWithBlankContacts: run.rowsWithBlankContacts || 0,
    errorRowsWritten: run.errorRowsWritten || 0,
    errorCount: (run.errors || []).length,
    errors: run.errors || [],
  },
}];
