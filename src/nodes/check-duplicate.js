// @inject-parsers
// Node: "Check Duplicate" (Code, run once for all items)
//
// Per-company deduplication, exactly as the brief specifies: the Google Sheets
// lookup immediately upstream searched the sheet's EMBS column for THIS
// company's ЕМБС, and this node decides append-or-skip from its result.
//
// This runs once per company inside the loop — it is not a bulk pass — so the
// workflow's normal operation can never produce a duplicate EMBS row.
//
// The lookup node has alwaysOutputData enabled, so "no match" arrives as a
// single empty item rather than as zero items (which would stall the loop).

const profile = $('Parse Profile').first().json;
const lookupItems = $input.all().map((i) => i.json || {});

const staticData = $getWorkflowStaticData('global');
const run = staticData.cwGrantRun || (staticData.cwGrantRun = { errors: [] });
if (!run.errors) run.errors = [];

const embs = String(profile.embs || '').trim();

// If the lookup itself errored (onError: continueRegularOutput), prefer writing
// the lead over losing it — but say so, so the duplicate risk is visible.
const lookupError = lookupItems.find((i) => i && i.error);
if (lookupError) {
  run.errors.push('[dedupe] ' + profile.profileUrl +
    ': the Google Sheets EMBS lookup failed (' + String(lookupError.error) +
    '). Treated as NOT a duplicate — check this row by hand.');
}

const existing = lookupItems.filter((i) =>
  i && String(i['EMBS'] === undefined ? '' : i['EMBS']).trim() === embs && embs !== ''
);

const isDuplicate = existing.length > 0;
if (isDuplicate) {
  run.duplicatesSkipped = (run.duplicatesSkipped || 0) + 1;
  return [{
    json: {
      __isNew: false,
      embs: embs,
      profileUrl: profile.profileUrl || '',
      skippedAsDuplicate: true,
    },
  }];
}

// The 14 sheet columns, in the brief's order, plus one control key. The Google
// Sheets node auto-maps by header name, so "__isNew" (no matching header) is
// ignored on write.
const row = {};
for (const key of SHEET_HEADERS) row[key] = profile[key] === undefined ? '' : profile[key];
row.__isNew = true;

// Counts rows handed to the append node. "Build Error Row" decrements this if
// the append itself comes back with an error, so the summary stays truthful.
run.rowsWritten = (run.rowsWritten || 0) + 1;

return [{ json: row }];
