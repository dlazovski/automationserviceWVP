// @inject-parsers
// Node: "Build Search URL" (Code, run once for all items)
//
// Entered from two places, both carrying the same state shape:
//   1. "Init Run"                    -> page 1
//   2. "More Pages?" (true branch)   -> the next page
//
// The campaign search URL (revenue floor dsm[0].From=4000000 and the NKD
// parameters) is taken verbatim from Config and is NEVER rebuilt here — the
// only thing this node does to it is append "&p=N" for pages after the first.

const cfg = $('Config').first().json;
const state = $input.first().json;

const page = Number(state.page) || 1;
const targetUrl = buildSearchUrl(cfg.searchUrl, page);

return [{
  json: {
    page: page,
    targetUrl: targetUrl,
    collected: Array.isArray(state.collected) ? state.collected : [],
    errors: Array.isArray(state.errors) ? state.errors : [],
    renderJs: String(cfg.renderJs) === 'true' ? 'true' : 'false',
    premiumProxy: String(cfg.premiumProxy) === 'true' ? 'true' : 'false',
  },
}];
