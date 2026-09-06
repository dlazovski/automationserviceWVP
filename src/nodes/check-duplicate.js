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

const cfg = $('Config').first().json;
const profile = $('Parse Profile').first().json;
const lookupItems = $input.all().map((i) => i.json || {});

const staticData = $getWorkflowStaticData('global');
const run = staticData.cwGrantRun || (staticData.cwGrantRun = { errors: [] });
if (!run.errors) run.errors = [];

const embs = String(profile.embs || '').trim();

/*
 * The lookup runs with onError: continueRegularOutput, so a failure arrives as
 * data. Two very different kinds of failure land here:
 *
 *   CONFIGURATION — "Sheet with name Leads not found", a bad document ID, or a
 *     permission refusal. These will not fix themselves, and every later
 *     company hits them identically. Continuing means scraping the whole list
 *     (minutes of requests, ScrapingBee credits) before the appends make the
 *     problem visible. So: abort on company #1 with the fix in the message.
 *
 *   TRANSIENT — a 429, a 503, a timeout. Continue and write the lead: losing a
 *     scraped company is worse than risking one duplicate row. The risk is
 *     logged so it can be checked by hand.
 */
const lookupError = lookupItems.find((i) => i && i.error);
if (lookupError) {
  const msg = errorMessage(lookupError.error);
  const isConfigProblem = /not found|does not exist|unable to parse range|permission|forbidden|not have access|invalid.*(id|range)/i.test(msg);

  if (isConfigProblem) {
    throw new Error(
      'Google Sheets is not reachable with the current settings, so the run was stopped ' +
      'before scraping the rest of the list.\n\n' +
      'Google said: ' + msg + '\n\n' +
      'Check, in the Config node:\n' +
      '  - sheetName ("' + (cfg.sheetName || '') + '") must match a real TAB name in the spreadsheet\n' +
      '  - errorSheetName ("' + (cfg.errorSheetName || '') + '") likewise\n' +
      '  - googleSheetId must be the ID of a spreadsheet this credential can edit\n\n' +
      'The most reliable fix is to open the three Google Sheets nodes and pick the ' +
      'document and tab from the dropdowns rather than relying on the exported values.'
    );
  }

  run.errors.push('[dedupe] ' + profile.profileUrl +
    ': the Google Sheets EMBS lookup failed (' + msg +
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
