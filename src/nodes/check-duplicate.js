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
    ': the Google Sheets EMBS lookup failed (' + errorMessage(lookupError.error) +
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

/*
 * Emit a CONTROL item, not the sheet row.
 *
 * The row itself is shaped by "Build Sheet Row" on the other side of the
 * "Is New?" IF. That keeps control keys away from the Google Sheets node
 * entirely: with mappingMode `autoMapInputData`, a key that has no matching
 * header is NOT quietly ignored — depending on the node's "handling extra data"
 * setting it either adds a column to your sheet or fails the append. Shipping
 * the flag in the row was a latent bug; this removes the whole class of it.
 */
return [{
  json: {
    __isNew: true,
    embs: embs,
    profileUrl: profile.profileUrl || '',
    skippedAsDuplicate: false,
  },
}];
