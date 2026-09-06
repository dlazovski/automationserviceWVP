// @inject-parsers
// Node: "Build Profile Request" (Code, run once for all items)
//
// Normalises the current company item into the shape the ScrapingBee HTTP node
// expects ({ targetUrl, renderJs, premiumProxy }).
//
// The URL is the href extracted from the search-results HTML, used exactly as
// found — never reconstructed from the company name and never re-encoded. The
// allowlist below is a hard guard: only public /kompanija/ profile pages are
// ever requested.

const cfg = $('Config').first().json;
const company = $input.first().json;

const profileUrl = String(company.profileUrl || '');
if (!/^https:\/\/www\.companywall\.com\.mk\/kompanija\//.test(profileUrl)) {
  throw new Error('Refusing to fetch a non-profile URL: ' + profileUrl +
    ' — only public /kompanija/ pages are in scope.');
}

return [{
  json: Object.assign({}, company, {
    targetUrl: profileUrl,
    renderJs: String(cfg.renderJs) === 'true' ? 'true' : 'false',
    premiumProxy: String(cfg.premiumProxy) === 'true' ? 'true' : 'false',
  }),
}];
