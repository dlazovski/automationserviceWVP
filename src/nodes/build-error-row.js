// @inject-parsers
// Node: "Build Error Row" (Code, run once for all items)
//
// Shapes one row for the separate "Errors" tab. Reached from two places:
//   1. "Profile OK?" false  -> a hard failure (fetch failed / blocked / no ЕМБС).
//      Nothing was written to the main sheet.
//   2. "Log Missing Fields?" true -> either the row WAS written but some fields
//      came back blank, or the Google Sheets append itself failed after its
//      retries (which would otherwise vanish silently).
//
// `Written To Main Sheet` separates "needs re-scraping" from "needs a look".

const profile = $('Parse Profile').first().json;
const incoming = $input.first().json || {};

const staticData = $getWorkflowStaticData('global');
const run = staticData.cwGrantRun || (staticData.cwGrantRun = { errors: [] });
run.errorRowsWritten = (run.errorRowsWritten || 0) + 1;

// On the hard-failure path `incoming` IS the Parse Profile item, whose `error`
// is the fetch failure. Only on the post-append path does `error` mean the
// Google Sheets append failed, and `ok` tells the two paths apart.
const profileFailed = incoming.ok === false;
const appendError = (!profileFailed && incoming.error) ? errorMessage(incoming.error) : '';

const written = profile.ok === true && !appendError;

let error;
if (appendError) {
  error = 'Google Sheets append failed after retries: ' + appendError;
  run.errors.push('[sheets] ' + (profile.profileUrl || '') + ': ' + error);
  run.rowsWritten = Math.max(0, (run.rowsWritten || 0) - 1); // it did not land
} else if (written) {
  error = 'fields missing from the profile page';
} else {
  error = profile.error || 'unknown failure';
}

return [{
  json: buildErrorRow({
    embs: profile.embs || '',
    name: profile.name || profile['Company Name'] || '',
    profileUrl: profile.profileUrl || '',
    error: error,
    // Required misses first; optional blanks appended as context, marked so
    // they are not mistaken for extraction failures.
    missing: (profile.missing || []).concat(
      (profile.blank || []).map((f) => f + ' (optional, blank)')
    ),
    written: written,
    scrapedAt: profile.scrapedAt || new Date().toISOString(),
  }),
}];
