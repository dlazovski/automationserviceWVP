# Extraction assumptions

No raw HTML from companywall.com.mk was available while this workflow was built
— only the brief's screenshots and URLs, and the build environment has no
network route to the site. **Every rule below is therefore an assumption**, and
each one names exactly where to change it.

Run `SCRAPINGBEE_API_KEY=... npm run probe` to check all of them against a live
page in one shot. It saves the raw HTML to `tmp/` and prints per-field coverage.

## The general strategy — and why there are no CSS selectors

Class names and DOM nesting are unknown, so a selector like
`.company-info__value` would be a pure guess that fails silently. Instead:

1. The HTML is flattened into **trimmed text lines** (`htmlToLines`). Block
   *and* inline tags become line breaks, because the site wraps each label and
   each value in its own `<span>`, so `<span>ЕДБ</span><span>4030…</span>`
   becomes two lines.
2. Fields are found by their **visible Cyrillic label** — the text actually
   shown in the screenshots — using small label/value readers over those lines.

This survives markup and CSS changes; selectors would not. The cost is that a
*renamed label* breaks a field, which is why every rule below lists its label
variants and every one has a fallback.

---

## Pagination and the search page

| # | Assumption | Where to change it | How to check |
|---|---|---|---|
| 1 | Page 1 is requested with **no `&p`**; later pages append `&p=2`, `&p=3`, … | `buildSearchUrl()` in `src/parsers.js` | `npm run probe -- --compare-pages` fetches both forms of page 1 and reports whether they are identical |
| 2 | The revenue/NKD filter in `searchUrl` is opaque and must never be rebuilt — only `&p=` is appended | `buildSearchUrl()`; enforced by a check in `build/validate-workflow.js` | a test asserts `dsm[0].From=4000000` survives pagination |
| 3 | Every company on a results page is linked as `href="/kompanija/{slug}/{id}"` | `PROFILE_HREF_RE` in `src/parsers.js` | the probe prints how many links it found on the page |
| 4 | A profile path has exactly 3 segments; `{id}` is 4–32 chars of `[A-Za-z0-9_-]` (the brief's example is `MMA8dAgq`). This is what excludes sub-pages like `/lica` | `isProfilePath()` | as above — if the count is 0 but the page clearly has results, this is the rule to widen |
| 5 | A company may be linked more than once per row (logo + title). Links are de-duplicated by path across the whole page | `findProfileAnchors()` | if the probe reports roughly twice the expected number of companies, this is why |
| 6 | The href is used **exactly as it appears** in the raw HTML — percent-encoded Cyrillic slug preserved byte for byte, only `&amp;` un-escaped | `findProfileAnchors()` | the probe prints the first 5 URLs; they should look like the brief's example |

### End of pagination

Three independent signals, **any** of which stops the crawl. The exact "no more
results" markup is unknown, so no single one is trusted:

| Signal | What it is | Where to change it |
|---|---|---|
| **Primary** | The page yields **zero** `/kompanija/` profile links. Depends on no site wording at all. | `PROFILE_HREF_RE` / `isProfilePath()` |
| **Explicit** | One of the Cyrillic "no results" phrases appears (`Нема резултати`, `Не се пронајдени`, `Нема податоци`, …). Recorded as the stop reason so the first run shows which signal fired. | `NO_RESULTS_PATTERNS` in `src/parsers.js` |
| **Repeat** | The page returns only companies already collected — the site served page 1 again instead of 404-ing past the last page. | `src/nodes/parse-search-results.js` |

Plus `Config.maxPages` (default 50) as a backstop.

**A 403/429, an anti-bot challenge or a truncated response is treated as a
FAILURE, never as end-of-pagination** — otherwise a block would silently look
like "we're done". `diagnoseResponse()` / `isBlockingFlag()` draw that line, and
`Parse Search Results` logs the distinction explicitly.

One subtlety that the sister workflows learned the hard way: CompanyWall's own
login form loads reCAPTCHA, so the string `recaptcha` appears in the HTML of
perfectly ordinary pages. A challenge marker only counts as a block when the
page carries **no** real site content — otherwise it is recorded as
`CAPTCHA_SCRIPT_PRESENT_IGNORED` and ignored.

---

## Profile page fields

All from the *Резиме* tab. Labels are matched case-insensitively against a
normalised (lowercased, punctuation-trimmed) form, so `ТЕЛ`, `Тел` and `Тел.`
all match.

| Field | Rule | Fallbacks | Where to change it |
|---|---|---|---|
| **(a) Company Name** | first `<h1>` on the page | `<title>`, keeping the segment before `\|` | `parseProfile()`, "company name" block |
| **(b) EDB** | 13 digits within 15 non-digits after `ЕДБ` | any bare 13-digit run on the page (that shape is distinctive enough to be safe) | `parseProfile()` |
| **(c) EMBS** | 6–8 digits after `ЕМБС` | after `Матичен број` | `parseProfile()` |
| **(d) Date Founded** | value after `Датум на основање` | `Датум на регистрација` / `Основана` / `Основано`; then the sentence `… и работи од {date} година` | `parseProfile()` |
| **(e) Phone Numbers** | **all** values under **every** `ТЕЛ` label inside the `КОНТАКТИ` section | `tel:` hrefs **within the КОНТАКТИ block only** | `valuesUnderLabel` call in `parseProfile()` |
| **(f) Emails** | **all** values under **every** `Е-ПОШТА` label inside `КОНТАКТИ` | `mailto:` hrefs within the block; then a blind scan of the block | same |
| **(g) Owners** | **all** values after **every** `Сопственик` label in `КОНТАКТИ`, percentage kept attached (`КИРИЛ ВОИНОВСКИ(50,00%)`) | inline form `Сопственик КИРИЛ ВОИНОВСКИ(50,00%)`; a percentage stranded on its own line is re-joined onto the name | `valuesForRepeatedLabel()` |
| **(h) Managers** | **all** values after every `Управител` label | also matches `Претставник` | same |
| **(i) NKD Code** | value after `НКЗ`, keeping **only** the leading `\d{2}\.\d{2,3}` — the description after the dash is discarded | labels `НКД` / `Дејност` / `Шифра на дејност`; then a page-wide `{code} - {Cyrillic text}` match | `parseProfile()`, "НКЗ" block |
| **(j) Profit/Loss** | row `Добивка/загуба` of the `ФИНАНСИСКО РЕЗИМЕ` table, **latest year column** | see below | `PROFIT_LABEL_RE` |
| **(k) Revenue** | row `Вкупен приход`, latest year column | see below | `REVENUE_LABEL_RE` |
| **(l) Employees** | row `Просечен број на вработени`, latest year column | a labelled line anywhere on the page. **Optional** — blank, never an error | `EMPLOYEES_LABEL_RE` |

### Why contact fallbacks are scoped to the КОНТАКТИ block

`tel:` and `mailto:` hrefs are collected **only from within the КОНТАКТИ
section**, and only when the labelled block found nothing. CompanyWall's own
support number and address sit in the header and footer of every page, so a
page-wide scan would attach *the site's* contact details to every lead. If the
`КОНТАКТИ` heading is not found at all, the fields are reported missing rather
than guessed — a blank cell is better than a wrong phone number. A test asserts
this.

### The year-column assumption — handled, not assumed

The brief warns against assuming "rightmost column = latest year". The parser
does not assume it:

1. Parse the table's header row and read **every** 4-digit year with its column
   index.
2. Pick the **maximum** year — wherever its column happens to sit.
3. Read that year's own column from the labelled row.

Both orderings are covered by tests. If the columns turn out to run
newest-first, the correct value is still selected and the row is annotated
`profit:latest-year-not-rightmost`.

Column alignment is attempted twice, because the header row may or may not carry
a leading empty cell above the row labels:

1. **by index** — correct when header and data rows have the same shape;
2. **by numeric zip** — the row's numeric cells are right-aligned onto the
   years, used when index alignment yields nothing numeric.

Whichever ran is recorded in the row's notes (`profit:numeric-zip`).

**If the summary is not a `<table>` at all**, a line-based fallback locates the
label, reads the numeric values that follow it, and zips them onto the nearest
preceding run of year headings (`readYearRowFromLines`). If no year header can
be found, the last value is taken and the row is annotated
`profit:lines-no-year-header` — that is the one case where the value is a
positional guess, and it is flagged as such.

**If the row is missing from `tmp/profile.html` entirely**, the table is
rendered by JavaScript: re-run the probe with `--render-js` and set
`Config.renderJs = "true"`.

### Number formats

Macedonian convention — `.` groups thousands, `,` is the decimal separator:
`128.450.900,00` → `128450900`. Both `-450.000,00` and `(450.000,00)` parse as
`-450000`; **losses are preserved as negative numbers and never dropped**
(`mkNumber()`).

---

## The one column name that is deliberately "wrong"

The main sheet's tenth column is named **`Revenue (from list page)`**, exactly as
the brief specifies. The value is actually read from the `Вкупен приход` row of
the ФИНАНСИСКО РЕЗИМЕ table on the **profile** page — this workflow takes no
data at all from the search-results page, only the profile links. The column
name is kept verbatim because the Google Sheets node auto-maps by header text,
so it must match row 1 of your sheet character for character.

---

## What to do when the probe reports a `FAIL`

1. Open the saved HTML: `tmp/profile.html` or `tmp/search-p1.html`.
2. Find the field's visible label in the markup, and see how the value is
   actually attached to it.
3. Fix the corresponding rule in `src/parsers.js` — the table above names it.
   Add a label variant rather than replacing one, so the existing paths keep
   working.
4. `npm run probe` again until clean.
5. `npm run verify` — rebuilds the workflow JSON, re-runs the structural checks
   and all 93 tests.
6. Re-import `workflow/companywall-mk-grant-leads.json` into n8n.

Never edit the extraction rules inside the workflow JSON: each of the 9 Code
nodes carries its own inlined copy of `src/parsers.js`, and the next build
overwrites them.
