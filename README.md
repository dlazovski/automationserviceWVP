# CompanyWall.mk — grant-campaign lead scraper (n8n → ScrapingBee → Google Sheets)

An n8n workflow that walks the CompanyWall.mk advanced-search results for the
**business automation / digitalisation grant campaign** (ICP: annual revenue
above **4,000,000 MKD**), opens every company's profile page, extracts 12 fields
from the *Резиме* tab, skips companies already in the sheet by **ЕМБС**, and
appends the rest to Google Sheets.

Run on demand from a Manual Trigger. Same architecture and conventions as the
existing CompanyWall.mk / CompanyWall.hr workflows: ScrapingBee for every
outbound request, a Wait node before each one, `batchSize: 1` everywhere, all
extraction logic in one `src/parsers.js` inlined into the Code nodes at build
time.

---

## ⚠️ Read this first — Step 0 is not optional

**The extraction rules have not been verified against the live site.** This repo
was built from the brief's screenshots and URLs — no raw HTML, and no network
route to the site from the build environment:

```
$ curl https://www.companywall.com.mk/
curl: (56) CONNECT tunnel failed, response 403

$ curl https://app.scrapingbee.com/api/v1/
curl: (56) CONNECT tunnel failed, response 403
```

Everything else is done and tested: the workflow graph, the pagination loop, the
per-company ЕМБС dedupe, the rate limiting, the error routing and the Sheets
mapping are covered by **99 passing tests**. What is *unverified* is whether the
label matching finds the real markup, and whether ScrapingBee needs the premium
proxy here.

`npm run probe` performs exactly that check — one real search call, one real
profile call — and prints per-field coverage. **Run it before the first full
run.** It costs 2 ScrapingBee credits.

The parsers were written to absorb this uncertainty: nothing matches on a CSS
class or a DOM path. Every field is found by its visible Cyrillic label against
a text-flattened form of the page, with layered fallbacks. That is a mitigation,
not a substitute for the live check. See
[docs/extraction-assumptions.md](docs/extraction-assumptions.md) for the full
list of assumptions and exactly where to adjust each one.

---

## Setup

### 1. Step 0 — verify against the live site

```bash
npm test                                  # 99 tests, no dependencies to install

SCRAPINGBEE_API_KEY=xxxxx npm run probe   # 2 real calls, ~10s, 2 credits
```

Copy the API key from the ScrapingBee credential already configured in n8n.

The probe fetches one search page and one profile page, writes the raw HTML to
`tmp/`, runs the real parsers against it, and prints:

```
--- 3. FIELD COVERAGE ---
  [OK  ] (a) Company Name           ЕУРОИМПЕКС ДОО УВОЗ-ИЗВОЗ СКОПЈЕ
  [OK  ] (c) EMBS                   6543210
  [OK  ] (e) Phone Numbers          [2] 02/3221-455 | 070 123 456
  [FAIL] (g) Owners                 (not found)
```

For anything marked `FAIL`, open the saved HTML in `tmp/`, fix the relevant rule
in [`src/parsers.js`](src/parsers.js) (the file names which rule handles which
field), and re-run the probe until it is clean.

Useful flags:

```bash
npm run probe -- --compare-pages   # checks whether "&p=1" == page 1 with no &p
npm run probe -- --premium         # if a challenge is reported
npm run probe -- --render-js       # if the financial table is missing from the HTML
npm run probe -- --page 2          # probe a later page
npm run probe -- --profile 'https://www.companywall.com.mk/kompanija/.../MMA8dAgq'
```

### 2. Rebuild and import

```bash
npm run verify    # rebuild + structural checks + all tests
```

Then in n8n: **Workflows → Import from File →**
`workflow/companywall-mk-grant-leads.json`

### 3. What you must set by hand after import

Credential IDs and sheet IDs are environment-specific, so the exported JSON
ships with placeholders. **Five nodes and one Config field:**

| # | Node | What to set | Placeholder in the export |
|---|---|---|---|
| 1 | `Config` | `googleSheetId` → your sheet's ID | `REPLACE_WITH_GOOGLE_SHEET_ID` |
| 2 | `ScrapingBee: Search` | select your ScrapingBee credential | `REPLACE_WITH_SCRAPINGBEE_CREDENTIAL_ID` |
| 3 | `ScrapingBee: Profile` | select the same ScrapingBee credential | `REPLACE_WITH_SCRAPINGBEE_CREDENTIAL_ID` |
| 4 | `Google Sheets: Lookup EMBS` | select your Google Sheets credential | `REPLACE_WITH_GOOGLE_SHEETS_CREDENTIAL_ID` |
| 5 | `Google Sheets: Append Row` | select the same Google Sheets credential | `REPLACE_WITH_GOOGLE_SHEETS_CREDENTIAL_ID` |
| 6 | `Google Sheets: Append Error Row` | select the same Google Sheets credential | `REPLACE_WITH_GOOGLE_SHEETS_CREDENTIAL_ID` |

Nothing else needs touching to run.

The ScrapingBee nodes use **Query Auth** (`Authentication → Generic Credential
Type → Query Auth`), because ScrapingBee authenticates with an `api_key` query
parameter — the same credential type the sister CompanyWall workflows use. If
your instance stores the key as a Header Auth credential instead, change
`genericAuthType` on both HTTP nodes to match.

**The API key is never written into the workflow JSON.** `npm run verify`
fails the build if one ever is.

### 4. Prepare the Google Sheet

> **This is the step that breaks runs.** If the tab names or the header row do
> not match, *every* append fails, the sheet stays empty, and — because the
> `Errors` tab lives in the same spreadsheet — its appends fail too, so nothing
> is written anywhere. Open the **`Run Summary`** node after a run: its
> `diagnosis` and `sheetsErrors` fields name the cause.
>
> The most reliable way to avoid it: after import, open each of the three Google
> Sheets nodes and pick the document and tab from the **dropdowns** ("From
> list") rather than trusting the exported Config expression. That makes n8n
> write the identifiers itself.

The workflow assumes the header row already exists and appends from row 2.

**Tab `Leads`** — paste this into row 1 (tab-separated, 14 columns, this exact
order and spelling; the node auto-maps by header name):

```
EMBS	Company Name	EDB	Date Founded	Phone Numbers	Emails	Owners	Managers	NKD Code	Revenue (from list page)	Number of Employees	Profit/Loss (latest year)	Profile URL	Date Scraped
```

**Tab `Errors`** — paste this into row 1 (7 columns):

```
EMBS	Company Name	Profile URL	Error	Missing Fields	Written To Main Sheet	Date Scraped
```

Rename the tabs if you prefer — then set `sheetName` / `errorSheetName` in the
**Config** node to match.

### 5. Configure and run

Open the **Config** node:

| Field | Default | Meaning |
|---|---|---|
| `searchUrl` | the campaign URL from the brief | Carries `dsm[0].From=4000000` (revenue > 4M MKD). Pagination only appends `&p=N` — the filter itself is never rebuilt. |
| `googleSheetId` | `REPLACE_WITH_GOOGLE_SHEET_ID` | **Set this.** |
| `sheetName` | `Leads` | Main tab. |
| `errorSheetName` | `Errors` | Failure-log tab. |
| `maxPages` | `50` | Safety cap on pagination. |
| `maxCompanies` | `0` | `0` = unlimited. Set to `3` for a first trial run. |
| `renderJs` | `"false"` | `"true"` only if the probe shows the financial table is missing from the raw HTML. |
| `premiumProxy` | `"false"` | `"true"` if the probe reports a challenge. |

**Do a trial run first:** set `maxCompanies` to `3`, execute, check the three
rows in the sheet and the `Run Summary` node, then set it back to `0`.

---

## How it works

```
Manual Trigger → Config → Init Run → Build Search URL ←──────────────┐
                                            ↓                        │
                              Wait 2s → ScrapingBee: Search           │
                                            ↓                        │
                                   Parse Search Results               │
                                            ↓                        │
                                      More Pages? ──true──────────────┘
                                            │ false
                                            ↓
                                    Emit Profile URLs
                                            ↓
   ┌────────────────────────────────  Loop Companies ──done→ Run Summary → Done
   │                                        │ loop
   │                                        ↓
   │                                   Has Company? ──false──┐
   │                                        │ true           │
   │                                        ↓                │
   │                            Build Profile Request        │
   │                                        ↓                │
   │                        Wait 2s → ScrapingBee: Profile   │
   │                                        ↓                │
   │                                  Parse Profile          │
   │                                        ↓                │
   │                                   Profile OK? ──false───┼──→ Build Error Row
   │                                        │ true           │          ↓
   │                          Google Sheets: Lookup EMBS     │   Sheets: Append
   │                                        ↓                │      Error Row
   │                                 Check Duplicate         │          │
   │                                        ↓                │          │
   │                                     Is New? ──false─────┤          │
   │                                        │ true           │          │
   │                          Google Sheets: Append Row      │          │
   │                                        ↓                │          │
   │                             Log Missing Fields? ──true──┴→ Build Error Row
   │                                        │ false                     │
   └────────────────────────────────────────┴─────────────────────────-─┘
```

**Pass 1 — paginated search.** Requests page 1 with no `&p`, then `&p=2`,
`&p=3`, … The *only* thing taken from these pages is each company's profile
`href`, exactly as it appears in the raw HTML (percent-encoded Cyrillic slug and
all — never decoded, re-encoded or reconstructed from the company name).

**Pass 2 — profile pages.** One request per company. All 12 fields come from the
*Резиме* tab.

**Row shaping.** `Build Sheet Row` emits exactly the 14 columns and nothing
else. That node exists on purpose: with `autoMapInputData`, a key that has no
matching header is *not* quietly ignored — n8n either adds a column to your
sheet or fails the append. No control key ever reaches the Sheets node, and the
validator enforces it.

**Deduplication** happens per company, inside the loop, right before the write:
the Google Sheets lookup searches the `EMBS` column for this company's ЕМБС. A
hit skips the company entirely — no duplicate row, and no update to the existing
row. A miss appends. So normal operation can never produce a duplicate ЕМБС.

**Rate limiting.** A 2-second Wait precedes *every* outbound request, and both
`splitInBatches` nodes use `batchSize: 1`, so exactly one request is ever in
flight. The brief asked for 1–2s; the sister CompanyWall workflows use 4s,
matching the site's own guidance (*"Не испраќајте премногу барања за пребарување
одеднаш"*, 3–5s). If a run trips rate limiting, raise both Wait nodes — anything
from 1s to 5s passes the validator.

---

## No profit/loss filtering — anywhere

Every company reaches the sheet, profitable or loss-making. Nothing in the
workflow branches on the profit value; `build/validate-workflow.js` fails the
build if an IF node ever references a profit column or compares a profit value
against zero, and a test asserts a large loss is written through unchanged.
Filter on that column by hand in the sheet afterwards.

---

## Error handling — the "Errors" tab

**Chosen approach: a separate `Errors` tab**, rather than an extra `Error`
column on the main sheet. The brief specifies the main sheet's 14 columns
exactly; adding a 15th would break that contract and put failure rows in the
middle of the lead list. A separate tab keeps `Leads` clean and gives failures
room for the fields that actually help — which fields were missing, and whether
the lead still made it to the main sheet.

Nothing ever stops the run. Two kinds of row land on `Errors`:

| `Written To Main Sheet` | When | What `Error` says |
|---|---|---|
| `no` | The profile failed to load, timed out, was blocked, or had **no ЕМБС** (so it could not be de-duplicated). Nothing was written to `Leads`. | `profile page failed to load: HTTP 500`, `EMBS field not found — cannot deduplicate, …` |
| `yes` | The lead **was** written to `Leads`, but one or more expected fields came back blank. | `fields missing from the profile page`, with `Missing Fields` naming them |

So a partial row is never silently blank, and a failed company is never silently
lost — filter `Errors` on `Written To Main Sheet = no` to get the re-scrape
queue.

| Situation | Behaviour |
|---|---|
| Search page 403 / 429 | Stop pagination, log it with a premium-proxy hint. **No retry** — retrying is what escalates a block. Profile URLs already collected are still processed. |
| Search page challenge / truncated | Treated as a **failure**, never as "no more results", so the run cannot end early and silently. |
| Profile fetch fails or is blocked | Row → `Errors` (`Written To Main Sheet = no`). Loop continues. |
| Profile parses but ЕМБС is missing | Row → `Errors`. Not written to `Leads`, because it could not be de-duplicated. |
| Profile parses, some fields blank | Row → `Leads` **and** a note row → `Errors`. |
| `Number of Employees` not found | Blank cell. Never an error — the brief marks it optional. |
| Google Sheets append fails | Retried 3× with backoff, then routed to `Errors` with the real API message, and the run continues. If the whole spreadsheet is unreachable the `Errors` append fails too — `Run Summary.diagnosis` is then the only record, and it names the likely cause. |
| Google Sheets **lookup** fails | The lead is written anyway (better than losing it) and the duplicate risk is logged to `Run Summary`. |

The **Run Summary** node reports the totals: pages fetched, why pagination
stopped, profiles fetched/failed, duplicates skipped, rows written, rows with
missing fields, and the full error list.

---

## Repository layout

```
src/parsers.js              ← ALL extraction logic. Edit the rules here only.
src/nodes/*.js              ← One file per n8n Code node.
build/build-workflow.js     ← Inlines parsers.js into each Code node, emits the JSON.
build/validate-workflow.js  ← Structural + policy checks on the generated workflow.
scripts/step0-probe.js      ← Step 0 live verification.
test/                       ← 99 tests (parsers + end-to-end node simulation).
workflow/                   ← The importable n8n workflow (generated, committed).
docs/                       ← Every extraction assumption, and where to change it.
```

**Do not edit the rules inside `workflow/companywall-mk-grant-leads.json`.**
The n8n Code node sandbox cannot `require` local files, so each Code node gets
its own inlined copy of `src/parsers.js` at build time — editing the JSON
directly means nine copies to keep in sync, and the next `npm run build`
overwrites them. The loop is: edit `src/parsers.js` → `npm run probe` →
`npm run verify` → re-import.

### Tests

```bash
npm test
```

- `test/parsers.test.js` (54) — MKD number formats (`128.450.900,00`, losses,
  parenthesised losses), percent-encoded href handling, end-of-pagination
  signals, challenge-vs-empty-page classification, every profile field, the
  descending-year financial table, the no-`<table>` fallback, and the sheet row
  shape.
- `test/workflow-sim.test.js` (45) — executes the **generated** Code nodes with
  mocked n8n globals: the real pagination loop (termination, repeat detection,
  403/429, caps), the per-company ЕМБС dedupe, error routing, and a full
  search → profile → dedupe → sheet run.

Both run against synthetic fixtures approximating the site's conventions. They
prove the pipeline is correct **given** markup in those conventions; they cannot
prove the rules match the real page. Only `npm run probe` does that.

---

## Known unknowns

1. **The real HTML structure.** Resolved by `npm run probe`. See
   [docs/extraction-assumptions.md](docs/extraction-assumptions.md).
2. **Whether `&p=1` is identical to page 1 with no `&p`.** The workflow omits
   `&p` on page 1. `npm run probe -- --compare-pages` settles it.
3. **Whether ScrapingBee needs the premium proxy.** Reported by the probe; flip
   `premiumProxy` to `"true"` in Config if so.
4. **Whether the ФИНАНСИСКО РЕЗИМЕ table is server-rendered.** If the probe
   cannot find the `Добивка/загуба` row *and* the row is absent from
   `tmp/profile.html`, it is JavaScript-rendered: set `renderJs` to `"true"`
   (this costs more ScrapingBee credits per request).
5. **Whether the year columns run oldest-first.** The parser does not assume
   either way — it selects the column whose header is the **maximum** year, and
   the probe prints the full year→value map so the choice can be checked.
