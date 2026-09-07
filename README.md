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
mapping are covered by **137 passing tests**. What is *unverified* is whether the
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
npm test                                  # 137 tests, no dependencies to install

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
| `nkdCodes` | `"all"` | The **industry sweep** — the second slicing axis. `"all"` = every 2-digit NKD sector (01–99); a list like `"46,47,62"` = just those; `""` = no industry filter, i.e. one revenue sweep (the old behaviour). |
| `sheetName` | `Leads` | Main tab. |
| `errorSheetName` | `Errors` | Failure-log tab. |
| `maxPages` | `50` | Safety cap on pagination, **per band**. |
| `maxCompanies` | `0` | `0` = unlimited. Set to `3` for a first trial run. |
| `resultCeiling` | `60` | How many results a single search hands over before the site truncates. A band returning this many is assumed truncated and gets bisected. **If a run comes back short, this and `maxBands` are the two knobs — and they must be changed together** (see below). |
| `autoSplitOnCeiling` | `"true"` | `"false"` reproduces the old single-search behaviour — and caps you at ~60 again. |
| `maxBands` | `2000` | Backstop on subdivision depth. Hitting it silently loses companies, so it is deliberately generous. |

**If a run comes back short**, open `Run Summary` and read `maxBandSize`,
`observedCapBelowConfigured`, `observedPageSize` and the `bands` array. Then:

| What you see | Fix |
|---|---|
| `errors` mentions `maxBands` | Raise `maxBands`. |
| Band `found` values cluster at a number below `resultCeiling` | Set `resultCeiling` to that number **and** raise `maxBands` — lowering the ceiling alone makes things worse, because the extra splitting exhausts the band budget. |
| `paginationStopReason` is `http_429` or `blocked_*` | Set `premiumProxy` to `"true"`. A block aborts the whole crawl, keeping only what was collected. |
| `duplicatesSkipped` is large | The run was fine; those companies were already in the sheet from an earlier run. |

Runs are **additive** — dedupe is by EMBS against the sheet — so re-running with
different settings tops up the missing companies without creating duplicates.
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

**Pass 1 — search, split into revenue bands.** CompanyWall serves **at most
~60 results per search, however deep you page** — a display ceiling on the site,
not a pagination bug. A single search therefore cannot return the whole campaign
list; a live run capped out at exactly 60. (The sister CompanyWall workflow hit
the same wall and worked around it the same way, by splitting one broad search
into several narrow ones.)

So the crawl works a **queue of revenue bands**. It starts with the band already
in `searchUrl` (4,000,000 – 4,000,000,000), pages through it, and whenever a
band comes back at the ceiling it bisects it and queues both halves — repeating
until every band comes back short. Consecutive bands partition the range
exactly, with no overlap and no gaps, so the union is provably the same set the
single search was asking for.

Only `dsm[0].From` / `dsm[0].To` are ever rewritten; every other parameter is
passed through byte-for-byte, and every request still carries
`From >= 4000000`. The validator checks all of that functionally, and a test
runs the whole crawl against a mock site that enforces the 60-cap: **470 of 470
companies recovered, versus 60 with subdivision turned off.**

Rough cost: ~110 search requests for ~470 companies (plus one profile request
each). If a band cannot be split far enough — 60+ companies on an identical
revenue figure — `Run Summary.diagnosis` says so rather than letting the run
look complete.

Requests page 1 with no `&p`, then `&p=2`, `&p=3`, … The *only* thing taken from
these pages is each company's profile `href`, exactly as it appears in the raw
HTML (percent-encoded Cyrillic slug and all — never decoded, re-encoded or
reconstructed from the company name).

**Pass 2 — profile pages.** One request per company. All 12 fields come from the
*Резиме* tab.

**Required vs optional fields.** Only a missing *required* field routes a
company to the `Errors` tab. Contact details (phone, e-mail, owners, managers)
and the employee count are optional: many real companies list none of them, so
flagging them would send nearly every company down the error branch and bury the
real problems. They show up as empty cells in `Leads`, which is where you would
filter on them anyway.

**Two slicing axes, not one.** Revenue bisection alone has a floor: once a band
cannot be narrowed further, the ~60 cap still bites, and a single revenue sweep
tops out well short of the full population. The campaign URL ships with `at=`
**empty** — no industry filter — so every search competes for the same 60-slot
budget.

NKD is a second, independent axis and a natural partition (each company has one
primary activity), so it shrinks the per-search result count directly instead of
fighting the cap. It is the same parameter the sister CompanyWall workflow is
built around, and it accepts 2-digit sectors. Measured on the simulator, with a
revenue filter coarse enough to stall bisection:

| Sweep | Companies found |
|---|---|
| Revenue only | 655 of 2410 (27%) |
| NKD × revenue | **2287 of 2410 (95%)** |

The subdivision budget (`maxBands`) is spent **per NKD code**, not per run — a
single shared budget would give each of 99 sectors `maxBands/99` splits and
starve every one of them, which can make a sweep return *fewer* companies than a
plain revenue crawl.

**Cost, and surviving a long run.** The sweep is much more expensive: budget
several hours and one ScrapingBee credit per request. Three things make that
survivable:

- **The loop item stays small.** The accumulated URL list lives in workflow
  static data, not in the item that travels the loop. Carried in the item, n8n
  retained a full copy of a growing list for *every* node execution — thousands
  of copies of a list thousands long, which is what makes a long sweep run out
  of memory. A test pins the item size.
- **`executionTimeout` is set to 24h** and `saveDataSuccessExecution` to
  `none`, so a low instance default cannot kill the run and n8n is not asked to
  retain tens of thousands of node executions. Errors are still saved in full,
  and `Run Summary` is visible live while the run is going.
- **Interrupted runs resume cheaply.** A Google Sheets lookup on `Profile URL`
  runs *before* the profile fetch, so a company already in the sheet costs one
  Sheets read instead of a ScrapingBee credit and a 2-second wait. The `EMBS`
  check still runs after the fetch, exactly as specified.

**Run it in chunks anyway** — `nkdCodes: "01,…,20"`, then `"21,…,40"`, and so
on. Each execution stays short, and runs are additive because dedupe is against
the sheet, so nothing is duplicated and you can stop and resume between chunks.

**Row shaping.** `Build Sheet Row` emits exactly the 14 columns and nothing
else. That node exists on purpose: with `autoMapInputData`, a key that has no
matching header is *not* quietly ignored — n8n either adds a column to your
sheet or fails the append. No control key ever reaches the Sheets node, and the
validator enforces it.

**Deduplication** happens twice, both per company and inside the loop. First a
`Profile URL` lookup *before* the profile is fetched — that is the resume check,
and it is what stops an interrupted sweep re-spending credits on companies it
already has. Then the `EMBS` check right before the write:
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
| Profile parses, a **required** field blank | Row → `Leads` **and** a note row → `Errors`. Required = Company Name, EDB, EMBS, Date Founded, NKD Code, Revenue, Profit/Loss. |
| Profile parses, an **optional** field blank | Blank cell, no Errors row. Optional = Phone Numbers, Emails, Owners, Managers, Number of Employees — real companies routinely list none of these, and you can filter on the empty cells in the sheet. |
| Nothing at all could be extracted | Row → `Errors` with "nothing could be extracted … run `npm run probe`". Never written to `Leads` as a blank row. |
| Google Sheets append fails | Retried 3× with backoff, then routed to `Errors` with the real API message, and the run continues. If the whole spreadsheet is unreachable the `Errors` append fails too — `Run Summary.diagnosis` is then the only record, and it names the likely cause. |
| Google Sheets lookup fails — **configuration** (tab not found, bad ID, no permission) | The run **stops on the first company**, with the message quoting what Google said and naming the Config field to change. It will not fix itself, and continuing would burn the whole list's ScrapingBee credits before the appends made it visible. |
| Google Sheets lookup fails — **transient** (429, 503, timeout) | The lead is written anyway (better than losing it) and the duplicate risk is logged to `Run Summary`. |

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
test/                       ← 137 tests (parsers + end-to-end node simulation).
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

- `test/parsers.test.js` (65) — MKD number formats (`128.450.900,00`, losses,
  parenthesised losses), percent-encoded href handling, end-of-pagination
  signals, challenge-vs-empty-page classification, every profile field, the
  descending-year financial table, the no-`<table>` fallback, and the sheet row
  shape.
- `test/workflow-sim.test.js` (72) — executes the **generated** Code nodes with
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
4. **Whether the ceiling is exactly 60.** A live run capped at 60 and the
   sister workflow reports "~60". `resultCeiling` in Config is the knob; lower
   it if you see bands stopping just short of 60 and suspect truncation.
5. **Whether the ФИНАНСИСКО РЕЗИМЕ table is server-rendered.** If the probe
   cannot find the `Добивка/загуба` row *and* the row is absent from
   `tmp/profile.html`, it is JavaScript-rendered: set `renderJs` to `"true"`
   (this costs more ScrapingBee credits per request).
6. **Whether the year columns run oldest-first.** The parser does not assume
   either way — it selects the column whose header is the **maximum** year, and
   the probe prints the full year→value map so the choice can be checked.
