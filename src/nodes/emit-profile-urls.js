// @inject-parsers
// Node: "Emit Profile URLs" (Code, run once for all items)
//
// Fans the accumulated list of profile URLs out into one item per company, for
// the per-company loop.
//
// Always emits at least one item: when the search found nothing it emits a
// single { hasCompany: false } marker. An empty output would stall the run,
// because a node with zero input items never executes.

const state = $input.first().json;

const staticData = $getWorkflowStaticData('global');
const run = staticData.cwGrantRun || (staticData.cwGrantRun = { errors: [] });

// Accumulated in static data by "Parse Search Results" — see Init Run for why.
const urls = Array.isArray(run.collected) ? run.collected : [];
run.profileUrlsFound = urls.length;
if (!run.paginationStopReason) run.paginationStopReason = state.stopReason || '';

if (urls.length === 0) {
  return [{ json: { hasCompany: false, profileUrl: '', stopReason: state.stopReason || '' } }];
}

return urls.map((url, i) => ({
  json: {
    hasCompany: true,
    profileUrl: url,
    companyIndex: i + 1,
    companyCount: urls.length,
  },
}));
