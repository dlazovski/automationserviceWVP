// @inject-parsers
// Node: "Build Sheet Row" (Code, run once for all items)
//
// Emits EXACTLY the 14 sheet columns, in the brief's order, and nothing else.
//
// This node exists so that no control key ever reaches the Google Sheets node.
// With `autoMapInputData`, a key that does not match a header is not silently
// dropped: n8n either inserts a new column into your sheet or fails the append,
// depending on the node's "handling extra data" setting. Keeping the row shape
// exact here removes that failure mode entirely.

const profile = $('Parse Profile').first().json;

const staticData = $getWorkflowStaticData('global');
const run = staticData.cwGrantRun || (staticData.cwGrantRun = { errors: [] });

// Counts rows handed to the append node. "Build Error Row" decrements this if
// the append comes back with an error, so the summary stays truthful.
run.rowsWritten = (run.rowsWritten || 0) + 1;

const row = {};
for (const key of SHEET_HEADERS) {
  row[key] = profile[key] === undefined || profile[key] === null ? '' : profile[key];
}

return [{ json: row }];
