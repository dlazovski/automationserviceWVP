// @inject-parsers
// Node: "Build Search URL" (Code, run once for all items)
//
// Entered from two places, both carrying the same state shape:
//   1. "Init Run"                    -> page 1 of the seed band
//   2. "More Pages?" (true branch)   -> the next page, or the next band
//
// Two things happen to the configured URL and nothing else:
//   - at= is set to the current NKD sector (when the sweep is enabled),
//   - dsm[0].From / dsm[0].To are set to the current revenue band, and
//   - "&p=N" is appended for pages after the first.
//
// Every other parameter — the NKD groups, bly, sbjact, the literal bracket
// form — is passed through byte-for-byte.

const cfg = $('Config').first().json;
const state = $input.first().json;

const page = Number(state.page) || 1;
const band = state.band;
if (!band) throw new Error('Build Search URL reached with no revenue band in state.');

// Three rewrites, in order, and nothing else: industry, revenue band, page.
const nkdUrl = withNkd(cfg.searchUrl, band.nkd === undefined ? readNkd(cfg.searchUrl) : band.nkd);
const bandUrl = withRevenueBand(nkdUrl, band.from, band.to);
const targetUrl = buildSearchUrl(bandUrl, page);

return [{
  json: {
    band: band,
    queue: Array.isArray(state.queue) ? state.queue : [],
    page: page,
    bandSeen: Array.isArray(state.bandSeen) ? state.bandSeen : [],
    targetUrl: targetUrl,
    collected: Array.isArray(state.collected) ? state.collected : [],
    errors: Array.isArray(state.errors) ? state.errors : [],
    renderJs: String(cfg.renderJs) === 'true' ? 'true' : 'false',
    premiumProxy: String(cfg.premiumProxy) === 'true' ? 'true' : 'false',
  },
}];
