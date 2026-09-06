'use strict';

/*
 * CompanyWall.mk extraction library — grant-campaign lead scrape.
 *
 * SINGLE SOURCE OF TRUTH for every regex and every field rule. It is:
 *   1. used directly by scripts/step0-probe.js (live verification), and
 *   2. inlined verbatim into every n8n Code node by build/build-workflow.js.
 *
 * So: tweak the extraction HERE, re-run `npm run probe`, then `npm run build`
 * and re-import. Never hand-edit the copies inside
 * workflow/companywall-mk-grant-leads.json — the next build overwrites them.
 *
 * Dependency-free and ES2020-compatible: the n8n Code node sandbox has no npm
 * modules and no `require`.
 *
 * ---------------------------------------------------------------------------
 * WHY LINE-BASED PARSING AND NOT CSS SELECTORS
 * ---------------------------------------------------------------------------
 * No raw HTML from the site was available while this was written (screenshots
 * and URLs only), so class names and DOM nesting are unknown. Every extraction
 * below therefore runs against a *linearised text* form of the page — the HTML
 * flattened into trimmed text lines — and matches on the visible Cyrillic
 * labels ("ЕДБ", "ТЕЛ", "Е-ПОШТА", "Сопственик", "Управител", "НКЗ",
 * "Добивка/загуба", "Вкупен приход"), which are what the screenshots actually
 * show. Labels survive markup and CSS changes; selectors do not.
 *
 * Every label list and every regex is a documented ASSUMPTION. See
 * docs/extraction-assumptions.md, and run `npm run probe` to check them
 * against the live site before the first full run.
 */

var BASE_URL = 'https://www.companywall.com.mk';

/*
 * The campaign search URL, copied VERBATIM from the brief.
 *
 * The revenue floor is already baked in as dsm[0].From=4000000 — that filter is
 * not reconstructed or recomputed anywhere in this repo, it is simply carried
 * through as an opaque string. Pagination only ever APPENDS "&p=N".
 *
 * Brackets are deliberately left unencoded: that is the exact form the site was
 * confirmed to answer 200 for in the sister workflows.
 */
var DEFAULT_SEARCH_URL = BASE_URL + '/prebaruvanje?cr=MKD&n=&mv=&r=&c=&cp=&at=&area=&subarea=&sbjact=t&blckd=&dbf=&dbt=&type=&bly=2025&dsm[0].Code=201&dsm[0].From=4000000&dsm[0].To=4000000000&dsm[1].Code=48&dsm[1].From=0&dsm[1].To=0&dsm[-1].Code=0&dsm[-1].From=0&dsm[-1].To=0&distinctcodes=&xpnd=true';

/* ------------------------------------------------------------------ *
 * Text / HTML primitives
 * ------------------------------------------------------------------ */

var NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  laquo: '\u00ab', raquo: '\u00bb', ndash: '\u2013', mdash: '\u2014',
  hellip: '\u2026', middot: '\u00b7', shy: '', bull: '\u2022'
};

function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch (e) { return ''; }
}

function decodeEntities(input) {
  return String(input == null ? '' : input)
    .replace(/&#x([0-9a-fA-F]+);/g, function (m, hex) { return safeCodePoint(parseInt(hex, 16)); })
    .replace(/&#(\d+);/g, function (m, dec) { return safeCodePoint(parseInt(dec, 10)); })
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,10});/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m;
    });
}

/** Strip tags from a short fragment and collapse it to one line. */
function stripTags(s) {
  return decodeEntities(String(s == null ? '' : s).replace(/<[^>]*>/g, ' '))
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

/**
 * Flatten HTML into an array of trimmed, non-empty text lines.
 *
 * Inline tags (span, a, strong, small, label) break lines too, because the site
 * wraps each label and each value in its own inline element — "<span>ЕДБ</span>
 * <span>4030…</span>" must become two lines for the label/value readers below
 * to work.
 */
function htmlToLines(html) {
  var s = String(html == null ? '' : html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|td|th|h[1-6]|dt|dd|section|article|span|a|label|strong|b|em|small)>/gi, '\n')
    .replace(/<(p|div|li|tr|td|th|h[1-6]|dt|dd|section|article|table|ul|ol|dl|br)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  var lines = decodeEntities(s)
    .split('\n')
    .map(function (l) { return l.replace(/[\s\u00a0]+/g, ' ').trim(); })
    .filter(function (l) { return l.length > 0; });

  /*
   * Inline markup can strand an ownership percentage on its own line:
   *   "КИРИЛ ВОИНОВСКИ" / "(50,00%)"
   * Re-join it onto the preceding name so the Owners column keeps the share, as
   * the brief requires ("КИРИЛ ВОИНОВСКИ(50,00%)"). Never join onto a LABEL, or
   * "Сопственички удел" + "(50,00%)" would fuse and stop matching as a label.
   */
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    if (/^\(?\s*\d{1,3}([.,]\d{1,4})?\s*%\s*\)?$/.test(lines[i]) &&
        out.length && !isPersonLabel(out[out.length - 1])) {
      out[out.length - 1] += ' ' + lines[i];
    } else {
      out.push(lines[i]);
    }
  }
  return out;
}

function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[:.\s]+$/, '')
    .trim();
}

function digitsOnly(s) { return String(s == null ? '' : s).replace(/\D+/g, ''); }

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function uniqBy(arr, keyFn) {
  var seen = Object.create(null);
  var out = [];
  (arr || []).forEach(function (v) {
    var k = keyFn(v);
    if (!k || seen[k]) return;
    seen[k] = 1;
    out.push(v);
  });
  return out;
}

/**
 * Macedonian number format: "1.234.567,89" -> 1234567.89, "-12.500" -> -12500.
 * Returns null when there is nothing numeric to read. Negative values matter
 * here: "Добивка/загуба" is frequently a loss and must NOT be dropped.
 */
function mkNumber(s) {
  var src = String(s == null ? '' : s);
  // A leading "-" or a parenthesised value are both loss notations.
  var negative = /^\s*[-\u2212]/.test(src) || /^\s*\(.*\)\s*$/.test(src.trim());
  var t = src.replace(/[^\d.,]/g, '');
  t = t.replace(/^[.,]+/, '').replace(/[.,]+$/, '');
  if (!t || !/\d/.test(t)) return null;

  var hasDot = t.indexOf('.') >= 0;
  var hasComma = t.indexOf(',') >= 0;
  if (hasDot && hasComma) {
    t = t.replace(/\./g, '').replace(',', '.');            // dot = thousands, comma = decimal
  } else if (hasComma) {
    t = /,\d{3}(\D|$)/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  } else if (hasDot) {
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, ''); // pure thousands grouping
  }
  var n = parseFloat(t);
  if (!isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

function firstInt(s) {
  var m = String(s == null ? '' : s).match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}

/**
 * Readable text out of whatever n8n put in an item's `error` property.
 *
 * With `onError: continueRegularOutput` a failed node passes its input item
 * through with an `error` added, and that is usually an OBJECT (a NodeApiError,
 * or `{ message, description }`) — never a string. `String(err)` on it yields
 * "[object Object]", which is worse than useless when a Google Sheets append is
 * failing and this text is the only record of why.
 */
function errorMessage(e) {
  if (e === null || e === undefined) return '';
  if (typeof e === 'string') return e;
  if (typeof e !== 'object') return String(e);

  var parts = [];
  if (e.message) parts.push(String(e.message));
  if (e.description && String(e.description) !== String(e.message)) parts.push(String(e.description));
  if (!parts.length && e.error) return errorMessage(e.error);
  if (!parts.length && e.reason) return errorMessage(e.reason);
  if (parts.length) {
    if (e.httpCode) parts.push('HTTP ' + e.httpCode);
    return parts.join(' — ');
  }
  try { return JSON.stringify(e).slice(0, 500); } catch (x) { return String(e); }
}

/* ------------------------------------------------------------------ *
 * Validators
 * ------------------------------------------------------------------ */

var EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
var EMAIL_SCAN_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// The site's own addresses appear in the header/footer of every single page.
var EMAIL_BLOCK_RE = /(companywall|bisnode|poslovna|sentry|wixpress|example\.(com|org)|schema\.org|@2x|\.(png|jpe?g|gif|svg|webp|css|js)$)/i;

function isEmail(s) {
  var t = String(s == null ? '' : s).trim();
  return EMAIL_RE.test(t) && !EMAIL_BLOCK_RE.test(t);
}

/** Accepts "078 123 456", "02/3221-455", "+389 2 3111 222". */
function isPhone(s) {
  var t = String(s == null ? '' : s).trim();
  if (!/^[+(\d]/.test(t)) return false;
  if (!/^[+()\d\s\-\/.]{6,25}$/.test(t)) return false;
  var d = digitsOnly(t).length;
  return d >= 6 && d <= 15;
}

/** Dedupe key treating "+389 78 123456" and "078123456" as the same line. */
function phoneKey(s) {
  var d = digitsOnly(s);
  return d.length > 8 ? d.slice(-8) : d;
}

function cleanPhone(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * Label/value readers over linearised lines
 * ------------------------------------------------------------------ */

/**
 * Value for any of `labels`, handling both markup shapes:
 *   split:  ["ЕДБ", "4030…"]   -> "4030…"
 *   inline: ["ЕДБ: 4030…"]     -> "4030…"
 */
function labelValue(L, labels, maxAhead) {
  maxAhead = maxAhead || 2;
  for (var i = 0; i < L.length; i++) {
    var n = norm(L[i]);
    for (var k = 0; k < labels.length; k++) {
      var lab = norm(labels[k]);
      if (!lab) continue;
      if (n === lab) {
        for (var j = i + 1; j <= Math.min(L.length - 1, i + maxAhead); j++) {
          if (L[j] && norm(L[j]) !== lab) return L[j];
        }
      }
      var m = L[i].match(new RegExp('^' + escapeRe(labels[k]) + '\\s*[:\\-\u2013]?\\s+(.{1,250})$', 'i'));
      if (m && m[1].trim()) return m[1].trim();
    }
  }
  return '';
}

/** Same, but matches labels by PREFIX ("Приход" matches "Приходи (2024)"). */
function labelValueByPrefix(L, prefixes, maxAhead) {
  maxAhead = maxAhead || 2;
  for (var i = 0; i < L.length; i++) {
    var n = norm(L[i]);
    for (var k = 0; k < prefixes.length; k++) {
      var p = norm(prefixes[k]);
      if (!p || n.indexOf(p) !== 0) continue;
      var rest = L[i].slice(prefixes[k].length).replace(/^[\s:\-\u2013]+/, '').trim();
      if (rest) return rest;
      for (var j = i + 1; j <= Math.min(L.length - 1, i + maxAhead); j++) {
        if (L[j]) return L[j];
      }
    }
  }
  return '';
}

/**
 * Collect the run of values listed beneath a label, e.g.
 *   ТЕЛ / 02/3221-455 / 070 123 456 / Е-ПОШТА / info@x.mk
 *
 * Scans EVERY occurrence of the label (the brief requires ALL phones and ALL
 * emails, not just the first), stopping each run at `stopRe` or at the first
 * line that fails `validator` once collecting has started.
 */
function valuesUnderLabel(L, labelRe, stopRe, validator, max) {
  max = max || 25;
  var out = [];
  for (var i = 0; i < L.length; i++) {
    if (!labelRe.test(norm(L[i]))) continue;
    var got = 0;
    for (var j = i + 1; j < Math.min(L.length, i + 1 + max); j++) {
      var ln = L[j];
      if (stopRe && stopRe.test(norm(ln))) break;
      if (validator(ln)) { out.push(ln.trim()); got++; }
      else if (got) break;
    }
  }
  return out;
}

/*
 * Labels that appear inside a person row and are never a person's name.
 *
 * EVERY role label in the КОНТАКТИ block must be listed here, not just the two
 * we harvest. The block runs "Управител / NAME / Управител / NAME /
 * Овластено лице / NAME / …", and each label's value run stops at the next
 * label. A role that is missing from this list is invisible as a boundary, so
 * the Управител run reads straight through it and captures the label text plus
 * everyone underneath it. That is exactly how "Овластено лице" and the two
 * authorised persons ended up in the Managers column.
 */
var PERSON_LABELS = [
  // roles we harvest
  'сопственик', 'сопственици', 'управител', 'управители',
  'претставник', 'претставници',
  // roles we do NOT harvest, but which must still terminate a run
  'овластено лице', 'овластени лица', 'овластен потписник',
  'прокурист', 'прокуристи', 'директор', 'извршен директор',
  'законски застапник', 'застапник', 'ликвидатор', 'стечаен управник',
  'член', 'членови', 'претседател', 'основач', 'основачи',
  'содружник', 'содружници', 'акционер', 'акционери',
  // field labels inside the same block
  'позиција', 'функција', 'вид', 'сопственички удел', 'удел',
  'од', 'до', 'име', 'име и презиме',
  'контакти', 'тел', 'тел.', 'телефон', 'телефони', 'мобилен', 'факс',
  'е-пошта', 'е пошта', 'емаил', 'мејл', 'e-mail', 'веб', 'www',
  'адреса', 'седиште', 'дејност'
];

function isPersonLabel(s) {
  return PERSON_LABELS.indexOf(norm(s)) >= 0;
}

/**
 * Every value that follows ANY occurrence of a person label.
 *
 * The КОНТАКТИ block repeats the label once per person:
 *   Сопственик / КИРИЛ ВОИНОВСКИ(50,00%)
 *   Сопственик / ГОРАН ВОИНОВСКИ(50,00%)
 *   Управител  / КИРИЛ ВОИНОВСКИ
 * so every occurrence is walked and each contributes its own entry. The inline
 * shape ("Сопственик КИРИЛ ВОИНОВСКИ(50,00%)") is handled too.
 *
 * `maxPerLabel` allows more than one value under a single label occurrence, for
 * the alternative layout where the label is written once and the people are
 * listed beneath it.
 */
function valuesForRepeatedLabel(L, labelRe, maxPerLabel) {
  maxPerLabel = maxPerLabel || 4;
  var out = [];
  for (var i = 0; i < L.length; i++) {
    var line = L[i];
    var n = norm(line);

    // inline: "Сопственик КИРИЛ ВОИНОВСКИ(50,00%)"
    var inline = line.match(/^([^\s:]+)\s*[:\-\u2013]?\s+(.{2,160})$/);
    if (inline && labelRe.test(norm(inline[1])) && !isPersonLabel(inline[2])) {
      out.push(inline[2].trim());
      continue;
    }

    if (!labelRe.test(n)) continue;

    // split: label on its own line, value(s) on the following lines
    var taken = 0;
    for (var j = i + 1; j < Math.min(L.length, i + 1 + maxPerLabel + 2) && taken < maxPerLabel; j++) {
      var v = L[j];
      if (!v) continue;
      if (isPersonLabel(v)) break;          // next label -> this run is over
      if (isSectionHeading(v)) break;       // next section -> stop
      if (/^[\d\s.,%()+\/-]+$/.test(v)) break; // a bare number is not a person
      out.push(v.trim());
      taken++;
    }
  }
  return out;
}

var SECTION_HEADINGS = [
  'контакти', 'основни информации', 'финансиско резиме', 'резиме',
  'финансии', 'вработени', 'сопственост', 'поврзани лица', 'документи',
  'дејност', 'блокади', 'сметки', 'бонитет'
];

function isSectionHeading(s) {
  var n = norm(s);
  return SECTION_HEADINGS.indexOf(n) >= 0;
}

/**
 * Narrow the lines to one visual section, e.g. everything between the
 * "КОНТАКТИ" heading and the next section heading. Falls back to the whole page
 * when the heading is not found, so a renamed section degrades to a wider (but
 * still working) search rather than to an empty result.
 */
function sectionLines(L, headingRe, maxLines) {
  maxLines = maxLines || 120;
  for (var i = 0; i < L.length; i++) {
    if (!headingRe.test(norm(L[i]))) continue;
    var out = [];
    for (var j = i + 1; j < Math.min(L.length, i + 1 + maxLines); j++) {
      if (isSectionHeading(L[j]) && !headingRe.test(norm(L[j]))) break;
      out.push(L[j]);
    }
    if (out.length) return { lines: out, found: true };
  }
  return { lines: L, found: false };
}

/**
 * The raw-HTML window belonging to one section, so href-based fallbacks can be
 * scoped to it.
 *
 * `sectionLines` works on linearised text and therefore loses the tags; tel:
 * and mailto: hrefs only exist in the raw HTML. Scanning those page-wide is not
 * an option: CompanyWall's own support number and address sit in the header and
 * footer of every page, so a page-wide scan attaches the site's contact details
 * to every lead. Returns null when the heading is not present — in which case
 * the caller must report the field missing rather than guess.
 */
function sectionHtml(html, headingRe, windowChars) {
  var raw = String(html == null ? '' : html);
  windowChars = windowChars || 8000;

  // Locate the heading in the raw HTML by scanning tag-stripped windows.
  var re = /([А-ЯЀ-ЏA-Z][А-Яа-яЀ-ѿA-Za-z \-]{3,40})/g;
  var m;
  while ((m = re.exec(raw)) !== null) {
    if (!headingRe.test(norm(m[1]))) continue;
    var start = m.index;
    var slice = raw.slice(start, start + windowChars);

    // Trim at the next known section heading, so the window does not run on
    // into the footer.
    var cutAt = slice.length;
    for (var i = 0; i < SECTION_HEADINGS.length; i++) {
      if (headingRe.test(SECTION_HEADINGS[i])) continue;
      var idx = slice.toLowerCase().indexOf(SECTION_HEADINGS[i], 1);
      if (idx > 0 && idx < cutAt) cutAt = idx;
    }
    return slice.slice(0, cutAt);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Search URL
 * ------------------------------------------------------------------ */

/**
 * Append pagination to the campaign search URL — and do nothing else.
 *
 * The revenue/NKD filter parameters inside `baseUrl` are treated as an opaque
 * string and never rebuilt, per the brief. Page 1 is requested WITHOUT "&p="
 * (the brief says "&p=1" is believed equivalent; `npm run probe -- --page 1`
 * versus `--page 2` confirms it against the live site).
 */
function buildSearchUrl(baseUrl, page) {
  var url = String(baseUrl || DEFAULT_SEARCH_URL);
  var n = Number(page) || 1;
  if (n <= 1) return url;
  // Defensive: never append a second &p= if one is already present.
  url = url.replace(/([?&])p=\d+(&|$)/, function (m, pre, post) { return post === '&' ? pre : (pre === '?' ? '?' : ''); });
  url = url.replace(/[?&]$/, '');
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'p=' + n;
}

/* ------------------------------------------------------------------ *
 * Revenue bands — getting past the site's ~60-result ceiling
 * ------------------------------------------------------------------ */

/*
 * CompanyWall serves at most ~60 results per search however deep you page.
 * That is a display ceiling on the site, not a pagination bug: a search
 * matching 400 companies still stops handing them over at ~60. The sister
 * CompanyWall workflow hit the same wall and worked around it by splitting one
 * broad search into several narrow ones.
 *
 * Here the split is by REVENUE BAND, which has a property the town/headcount
 * splits do not: consecutive bands partition the range exactly — no overlap, no
 * gaps — so the union of the slices is provably the same set the single search
 * was asking for.
 *
 * The initial band is READ OUT of the configured URL rather than invented, and
 * subdivision only ever narrows within it. The campaign filter is therefore
 * never reconstructed or widened: every request still carries
 * dsm[0].From >= 4000000.
 */

/** The dsm[0] revenue range currently encoded in a search URL. */
function readRevenueBand(url) {
  var u = String(url || '');
  var from = u.match(/dsm\[0\]\.From=(\d+)/);
  var to = u.match(/dsm\[0\]\.To=(\d+)/);
  if (!from || !to) return null;
  return { from: parseInt(from[1], 10), to: parseInt(to[1], 10) };
}

/**
 * The same URL with ONLY dsm[0].From / dsm[0].To rewritten.
 *
 * Every other parameter — the NKD codes, bly, sbjact, the dsm[1] and dsm[-1]
 * groups, the literal bracket form — is left byte-for-byte as configured.
 */
function withRevenueBand(url, from, to) {
  return String(url || '')
    .replace(/(dsm\[0\]\.From=)\d+/, '$1' + String(Math.round(from)))
    .replace(/(dsm\[0\]\.To=)\d+/, '$1' + String(Math.round(to)));
}

/**
 * Bisect a band into two that partition it exactly.
 *
 * Returns null when the band is too narrow to split — revenue is in whole
 * denari, so a width of 1 cannot be halved. The caller reports that as a band
 * it could not get under the ceiling.
 */
function splitBand(from, to) {
  var f = Math.round(from);
  var t = Math.round(to);
  if (!(t > f + 1)) return null;
  var mid = Math.floor(f + (t - f) / 2);
  if (mid <= f || mid >= t) return null;
  // [f, mid] and [mid + 1, t]: adjacent, non-overlapping, and together exactly
  // the original band.
  return [{ from: f, to: mid }, { from: mid + 1, to: t }];
}

function formatBand(band) {
  return band ? band.from + '-' + band.to : '(none)';
}

/* ------------------------------------------------------------------ *
 * Response health checks
 * ------------------------------------------------------------------ */

/**
 * Classify a response so a block is never mistaken for "no more results", and
 * an ordinary empty result page is never mistaken for a block.
 *
 * Every challenge marker is qualified by whether the page ALSO carries real
 * site content: CompanyWall's own login form loads reCAPTCHA, so "recaptcha"
 * appears in the HTML of perfectly ordinary pages. A genuine interstitial is a
 * SMALL page served INSTEAD of the site, with no company links at all.
 */
function diagnoseResponse(html, expect) {
  var h = String(html == null ? '' : html);
  var flags = [];
  if (!h) { flags.push('EMPTY_BODY'); return flags; }
  // 'search' (default) or 'profile'. Only a search page can meaningfully be
  // "empty"; a profile page carries no /kompanija/ links of its own.
  var kind = expect === 'profile' ? 'profile' : 'search';

  var hasCompanyLinks = /\/kompanija\//i.test(h);
  var looksReal = hasCompanyLinks || h.length > 30000 ||
    (kind === 'profile' && /ЕДБ|ЕМБС|КОНТАКТИ/i.test(h));

  if (h.length < 1500) flags.push('SUSPICIOUSLY_SHORT');
  // A complete document ends with </html>; a cut-off transfer usually does not.
  if (!/<\/html\s*>/i.test(h)) flags.push('TRUNCATED_BODY');

  if (/cf-browser-verification|cf_chl|Checking your browser|Just a moment|Attention Required/i.test(h)) {
    flags.push(looksReal ? 'CF_MARKER_PRESENT_IGNORED' : 'CLOUDFLARE_CHALLENGE');
  }
  if (/captcha|recaptcha|hcaptcha/i.test(h)) {
    flags.push(looksReal ? 'CAPTCHA_SCRIPT_PRESENT_IGNORED' : 'CAPTCHA');
  }
  if (/\/registracija|\/najava|Најави се|Регистрирај се/i.test(h) && !looksReal) {
    flags.push('POSSIBLE_LOGIN_WALL');
  }
  if (kind === 'search' && looksReal && !hasCompanyLinks) flags.push('NO_RESULTS_ON_PAGE');
  return flags;
}

/** True only for flags meaning "the site refused to serve us content". */
function isBlockingFlag(f) {
  return f === 'CLOUDFLARE_CHALLENGE' || f === 'CAPTCHA' ||
    f === 'POSSIBLE_LOGIN_WALL' || f === 'EMPTY_BODY' || f === 'TRUNCATED_BODY';
}

/*
 * ---------------------------------------------------------------------------
 * END-OF-PAGINATION DETECTION  <<< ADJUST HERE IF THE SITE DISAGREES >>>
 * ---------------------------------------------------------------------------
 * The exact "no more results" markup is not known, so three independent signals
 * are used and ANY of them ends pagination:
 *
 *   1. PRIMARY  — the page contains zero /kompanija/ profile anchors.
 *                 This is the signal the brief asks for ("results container is
 *                 empty") and it does not depend on any wording.
 *   2. EXPLICIT — one of the Cyrillic "no results" phrases below appears while
 *                 the page also has no profile anchors.
 *   3. REPEAT   — the page returns only companies already collected, i.e. the
 *                 site served page 1 again instead of 404-ing past the last
 *                 page (this is handled in src/nodes/parse-search-results.js).
 *
 * If a first live run stops too early or never stops, this list and
 * findProfileAnchors() below are the two places to adjust.
 */
var NO_RESULTS_PATTERNS = [
  /нема\s+резултати/i,
  /нема\s+пронајдени/i,
  /не\s+се\s+пронајдени/i,
  /нема\s+податоци/i,
  /не\s+постојат\s+резултати/i,
  /вашето\s+пребарување\s+не/i,
  /no\s+results?\s+found/i
];

function detectNoResultsMarker(html) {
  var text = htmlToLines(html).join('\n');
  for (var i = 0; i < NO_RESULTS_PATTERNS.length; i++) {
    var m = text.match(NO_RESULTS_PATTERNS[i]);
    if (m) return m[0];
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Search results page — profile links ONLY
 * ------------------------------------------------------------------ */

/*
 * The href is captured EXACTLY as it appears in the raw HTML, per the brief.
 * The slug is Cyrillic and will normally arrive percent-encoded
 * ("/kompanija/%D0%B5%D1%83%D1%80%D0%BE.../MMA8dAgq"); it is never decoded,
 * re-encoded or reconstructed here — only "&amp;" is un-escaped, because that
 * is HTML-level escaping rather than URL encoding.
 */
var PROFILE_HREF_RE = /href\s*=\s*["'](\/kompanija\/[^"'#\s]+)["']/gi;

/**
 * A profile path is exactly /kompanija/{slug}/{id}.
 * Anything with more segments (e.g. /kompanija/{slug}/{id}/lica) is a sub-page
 * and is deliberately NOT followed — the brief only asks for the Резиме tab.
 */
function isProfilePath(p) {
  var parts = String(p).split('?')[0].split('/').filter(function (x) { return x.length > 0; });
  return parts.length === 3 &&
    parts[0] === 'kompanija' &&
    parts[1].length > 0 &&
    /^[A-Za-z0-9_-]{4,32}$/.test(parts[2]);
}

/**
 * Ordered, de-duplicated profile links for one search-results page.
 *
 * Dedupe is by path across the WHOLE page, not just between neighbours: each
 * result row commonly links the company twice (logo + title), and a repeat
 * elsewhere on the page must not invent an extra company.
 */
function findProfileAnchors(html) {
  var raw = String(html == null ? '' : html);
  var out = [];
  var seen = Object.create(null);
  var re = new RegExp(PROFILE_HREF_RE.source, 'gi');
  var m;
  while ((m = re.exec(raw)) !== null) {
    // Only "&amp;" is decoded; percent-encoding is preserved byte for byte.
    var path = m[1].replace(/&amp;/gi, '&').replace(/\/+$/, '');
    if (!isProfilePath(path) || seen[path]) continue;
    seen[path] = 1;
    out.push({ path: path, index: m.index });
  }
  return out;
}

/**
 * Parse one search-results page down to the list of profile URLs.
 *
 * No other field is read from the search page: the brief takes every data field
 * from the individual profile pages instead.
 */
function parseSearchResults(html) {
  var raw = String(html == null ? '' : html);
  var anchors = findProfileAnchors(raw);
  return {
    profileUrls: anchors.map(function (a) { return BASE_URL + a.path; }),
    profilePaths: anchors.map(function (a) { return a.path; }),
    rowCount: anchors.length,
    noResultsMarker: anchors.length === 0 ? detectNoResultsMarker(raw) : null,
    flags: diagnoseResponse(raw)
  };
}

/* ------------------------------------------------------------------ *
 * HTML tables — the "ФИНАНСИСКО РЕЗИМЕ" summary
 * ------------------------------------------------------------------ */

/** Every <table> on the page, as arrays of stripped cell strings. */
function parseHtmlTables(html) {
  var raw = String(html == null ? '' : html);
  var tables = [];
  var tRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  var t;
  while ((t = tRe.exec(raw)) !== null) {
    var rows = [];
    var rRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    var r;
    while ((r = rRe.exec(t[1])) !== null) {
      var cells = [];
      var cRe = /<t([hd])\b[^>]*>([\s\S]*?)<\/t\1>/gi;
      var c;
      while ((c = cRe.exec(r[1])) !== null) cells.push(stripTags(c[2]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

function isYearToken(s) {
  var t = String(s == null ? '' : s).trim();
  var m = t.match(/^(19|20)\d{2}$/);
  return m ? parseInt(t, 10) : null;
}

/** Year columns of a table: [{ index, year }], from the row with the most years. */
function findYearHeader(rows) {
  var best = null;
  for (var i = 0; i < rows.length; i++) {
    var found = [];
    for (var j = 0; j < rows[i].length; j++) {
      var y = isYearToken(rows[i][j]);
      if (y) found.push({ index: j, year: y });
    }
    if (found.length >= 2 && (!best || found.length > best.years.length)) {
      best = { rowIndex: i, years: found };
    }
  }
  return best;
}

/**
 * Read one labelled row of a year-column table and return the value for the
 * LATEST year.
 *
 * The brief explicitly warns against assuming "rightmost = latest", so the
 * latest year is chosen by MAX over the parsed year headers and the value is
 * read from that year's own column. `rightmostIsLatest` in the result records
 * whether the two happened to coincide, which the probe prints so the ordering
 * assumption can be checked against a real page.
 *
 * Alignment is attempted twice:
 *   1. by column index (correct when header and data rows have the same shape);
 *   2. by zipping the row's numeric cells onto the years in order (correct when
 *      the header omits the leading label cell, which shifts every index by 1).
 */
function readYearRow(rows, header, labelRe) {
  for (var i = 0; i < rows.length; i++) {
    if (i === header.rowIndex) continue;
    var cells = rows[i];
    var labelCell = cells[0] || '';
    if (!labelRe.test(norm(labelCell))) continue;

    var years = header.years.slice().sort(function (a, b) { return a.year - b.year; });
    var latest = years[years.length - 1];
    var maxIndex = years.reduce(function (mx, y) { return Math.max(mx, y.index); }, 0);

    var byYear = {};
    var strategy = 'index-aligned';

    // (1) index alignment
    var indexOk = false;
    for (var k = 0; k < years.length; k++) {
      var v = cells[years[k].index];
      byYear[years[k].year] = v === undefined ? '' : v;
      if (mkNumber(v) !== null) indexOk = true;
    }

    // (2) numeric-cell zip, used when index alignment produced nothing numeric
    if (!indexOk) {
      var numeric = [];
      for (var c = 0; c < cells.length; c++) {
        if (c === 0) continue;                    // column 0 is the row label
        if (mkNumber(cells[c]) !== null) numeric.push(cells[c]);
      }
      if (numeric.length) {
        strategy = 'numeric-zip';
        byYear = {};
        // Right-align: the last numeric cell belongs to the last year column.
        var offset = numeric.length - years.length;
        for (var z = 0; z < years.length; z++) {
          var idx = z + (offset > 0 ? offset : 0);
          byYear[years[z].year] = idx >= 0 && idx < numeric.length ? numeric[idx] : '';
        }
      }
    }

    var rawValue = byYear[latest.year];
    return {
      found: true,
      label: labelCell,
      year: latest.year,
      raw: rawValue === undefined ? '' : String(rawValue).trim(),
      value: mkNumber(rawValue),
      byYear: byYear,
      years: years.map(function (y) { return y.year; }),
      rightmostIsLatest: latest.index === maxIndex,
      strategy: strategy
    };
  }
  return { found: false };
}

/**
 * Fallback for a financial summary rendered without <table> markup.
 *
 * Locates the label among the linearised lines, reads the numeric values that
 * follow it, and zips them onto the nearest preceding run of year headings.
 * Values are right-aligned onto the years, then the LATEST year is selected by
 * max — never by position.
 */
function readYearRowFromLines(L, labelRe) {
  for (var i = 0; i < L.length; i++) {
    if (!labelRe.test(norm(L[i]))) continue;

    // years: the closest run of year tokens above this row (the table header)
    var years = [];
    for (var b = i - 1; b >= Math.max(0, i - 40) && years.length < 12; b--) {
      var y = isYearToken(L[b]);
      if (y) years.unshift(y);
      else if (years.length) break;
    }

    var values = [];
    for (var f = i + 1; f < Math.min(L.length, i + 1 + 14); f++) {
      if (mkNumber(L[f]) !== null && !isYearToken(L[f])) values.push(L[f]);
      else if (values.length) break;
    }

    /*
     * Without a tag boundary between them, two year columns can land on ONE
     * line ("250 255"). mkNumber() then strips the space and reads that as
     * 250255 — which is how an employee count of 250 became 250,255.
     *
     * So: when the collected values are fewer than the year columns, try
     * splitting each on whitespace and keep the expansion only if it makes the
     * counts line up. Requiring the exact match is what keeps a genuine
     * space-grouped number ("1 234 567") from being torn into three.
     */
    if (years.length > 1 && values.length < years.length) {
      var expanded = [];
      for (var e = 0; e < values.length; e++) {
        var toks = String(values[e]).split(/[\s\u00a0]+/)
          .filter(function (tk) { return /\d/.test(tk) && mkNumber(tk) !== null; });
        expanded = expanded.concat(toks.length ? toks : [values[e]]);
      }
      if (expanded.length === years.length) values = expanded;
    }
    // Inline shape: "Добивка/загуба -1.234 5.678 9.012"
    if (!values.length) {
      var rest = L[i].replace(labelRe, '').trim();
      var toks = rest.split(/\s{1,}/).filter(function (t) { return mkNumber(t) !== null; });
      if (toks.length) values = toks;
    }
    if (!values.length) continue;

    if (!years.length) {
      // No header found: the best we can do is the last value. Flagged as such.
      var last = values[values.length - 1];
      return {
        found: true, label: L[i], year: null, raw: String(last).trim(),
        value: mkNumber(last), byYear: {}, years: [],
        rightmostIsLatest: true, strategy: 'lines-no-year-header'
      };
    }

    var sorted = years.slice().sort(function (a, b2) { return a - b2; });
    var latestYear = sorted[sorted.length - 1];
    var offset = values.length - years.length;
    var byYear = {};
    for (var z = 0; z < years.length; z++) {
      var idx = z + (offset > 0 ? offset : 0);
      byYear[years[z]] = idx >= 0 && idx < values.length ? values[idx] : '';
    }
    var rawValue = byYear[latestYear];
    return {
      found: true,
      label: L[i],
      year: latestYear,
      raw: rawValue === undefined ? '' : String(rawValue).trim(),
      value: mkNumber(rawValue),
      byYear: byYear,
      years: years,
      rightmostIsLatest: years[years.length - 1] === latestYear,
      strategy: 'lines-zip'
    };
  }
  return { found: false };
}

/** Table parse first, line fallback second. */
function readFinancialRow(tables, L, labelRe) {
  for (var i = 0; i < tables.length; i++) {
    var header = findYearHeader(tables[i]);
    if (!header) continue;
    var hit = readYearRow(tables[i], header, labelRe);
    if (hit.found) return hit;
  }
  return readYearRowFromLines(L, labelRe);
}

/*
 * Financial-summary row labels.  <<< ADJUST HERE IF A ROW IS NOT FOUND >>>
 * Matched against the normalised (lowercased, trimmed) first cell, so
 * "Добивка/загуба", "ДОБИВКА / ЗАГУБА" and "Добивка/загуба (нето)" all match.
 */
var PROFIT_LABEL_RE = /^добивка\s*\/?\s*загуба|^добивка$|^нето\s+добивка|^загуба$/;
var REVENUE_LABEL_RE = /^вкупен\s+приход|^вкупни\s+приходи|^приход(и)?$/;
var EMPLOYEES_LABEL_RE = /^просечен\s+број\s+на\s+вработени|^број\s+на\s+вработени|^вработени/;

/* ------------------------------------------------------------------ *
 * Company profile page ("Резиме" tab)
 * ------------------------------------------------------------------ */

function parseProfile(html) {
  var raw = String(html == null ? '' : html);
  var L = htmlToLines(raw);
  var text = L.join('\n');
  var tables = parseHtmlTables(raw);
  /*
   * `missing`  — REQUIRED fields. Every profile should have these; an absence
   *              means the extraction rule did not match and needs a look.
   * `blank`    — OPTIONAL fields. Plenty of real companies list no phone, no
   *              e-mail, no owner and no manager. Those are blank cells, not
   *              failures: flagging them would route nearly every company to
   *              the Errors tab and drown the real problems.
   */
  var missing = [];
  var blank = [];
  var notes = [];

  /* --- (a) Company name: the page heading ---------------------------- */
  var name = '';
  var h1 = raw.match(/<h1[^>]*>([\s\S]{1,400}?)<\/h1>/i);
  if (h1) name = stripTags(h1[1]);
  var nameFromTitle = false;
  if (!name) {
    // Site titles are "NAME | CompanyWall" — keep the leading segment. Reject
    // the site's own name: on a page the rules cannot read, the bare title
    // would otherwise be written into the sheet as the company name.
    var t = raw.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
    if (t) {
      var candidate = stripTags(t[1]).split(/\s*[|\u2013\u2014]\s*/)[0].trim();
      if (candidate && !/^companywall/i.test(candidate) && candidate.length > 2) {
        name = candidate;
        nameFromTitle = true;
        notes.push('name:from-title');
      }
    }
  }
  if (!name) missing.push('Company Name');

  /* --- (b)(c) ЕДБ / ЕМБС -------------------------------------------- *
   * ЕДБ is a 13-digit tax number, ЕМБС a 6-8 digit registration number.
   * The label-anchored form is tried first; the bare-number fallback is only
   * used for ЕДБ, whose 13-digit shape is distinctive enough to be safe.
   */
  var edb = (text.match(/ЕДБ[^\d]{0,15}(\d{13})/i) || [])[1] ||
    (text.match(/(?:^|\D)(?:МК)?(\d{13})(?:\D|$)/) || [])[1] || '';
  if (!edb) missing.push('EDB');

  var embs = (text.match(/ЕМБС[^\d]{0,15}(\d{6,8})/i) || [])[1] ||
    (text.match(/Матичен\s+број[^\d]{0,15}(\d{6,8})/i) || [])[1] || '';
  if (!embs) missing.push('EMBS');

  /* --- (d) Датум на основање ---------------------------------------- */
  var dateFounded = labelValue(L, ['Датум на основање', 'Датум на регистрација', 'Основана', 'Основано'], 3);
  if (!dateFounded) {
    // Profiles also carry the sentence "… и работи од 12.03.2005 година."
    dateFounded = (text.match(/работи\s+од\s+(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4})\s*(?:год|година)/i) || [])[1] || '';
    if (dateFounded) notes.push('dateFounded:from-sentence');
  }
  dateFounded = String(dateFounded || '').trim();
  if (!dateFounded) missing.push('Date Founded');

  /* --- (e)(f) КОНТАКТИ: ALL phones and ALL emails -------------------- *
   * Scoped to the КОНТАКТИ section when that heading is found, so the site's
   * own footer phone/email are not harvested as the company's. Falls back to
   * the whole page (flagged) when the heading is missing.
   */
  var contacts = sectionLines(L, /^контакти$/, 160);
  var CL = contacts.lines;
  if (!contacts.found) notes.push('contacts:section-not-found');

  var telBlock = valuesUnderLabel(
    CL,
    /^(тел|тел\.|телефон|телефони|телефонски броеви|мобилен)$/,
    /^(е-пошта|е пошта|е-маил|e-?mail|факс|веб|www|адреса|дејност|сопственик|управител)/,
    isPhone, 25
  );
  var phones = uniqBy(telBlock.map(cleanPhone).filter(isPhone), phoneKey);

  /*
   * tel: hrefs are a FALLBACK, not an additional source. They are collected
   * page-wide, and the site's own support number sits in the header/footer of
   * every page — merging them into a good КОНТАКТИ block would attach
   * CompanyWall's phone number to every lead. They are only used when the
   * labelled block yielded nothing, and that is flagged.
   */
  var contactsHtml = sectionHtml(raw, /^контакти$/, 8000);
  if (!phones.length && contactsHtml) {
    var telHrefs = [];
    var reTel = /href\s*=\s*["']tel:([^"']+)["']/gi, mt;
    while ((mt = reTel.exec(contactsHtml)) !== null) telHrefs.push(decodeEntities(mt[1]).trim());
    phones = uniqBy(telHrefs.map(cleanPhone).filter(isPhone), phoneKey);
    if (phones.length) notes.push('phones:from-tel-href');
  }
  if (!phones.length) blank.push('Phone Numbers');

  var mailBlock = valuesUnderLabel(
    CL,
    /^(е-пошта|е пошта|е-маил|е маил|e-?mail|емаил|мејл|пошта)$/,
    /^(тел|телефон|факс|веб|www|адреса|дејност|сопственик|управител)/,
    isEmail, 25
  );
  var emails = uniqBy(
    mailBlock.map(function (e) { return String(e).trim().replace(/[.,;]+$/, ''); }).filter(isEmail),
    function (e) { return e.toLowerCase(); }
  );
  // Same fallback-only rule as phones. (EMAIL_BLOCK_RE already drops the site's
  // own addresses, but a page-wide merge would still pull in unrelated ones.)
  if (!emails.length && contactsHtml) {
    var mailHrefs = [];
    var reMail = /href\s*=\s*["']mailto:([^"'?]+)/gi, mm;
    while ((mm = reMail.exec(contactsHtml)) !== null) mailHrefs.push(decodeEntities(mm[1]).trim());
    emails = uniqBy(
      mailHrefs.map(function (e) { return String(e).trim().replace(/[.,;]+$/, ''); }).filter(isEmail),
      function (e) { return e.toLowerCase(); }
    );
    if (emails.length) notes.push('emails:from-mailto-href');
  }
  if (!emails.length && contacts.found) {
    // Last resort, and only within the КОНТАКТИ block: a page-wide scan picks
    // up unrelated addresses from the chrome.
    emails = uniqBy((CL.join('\n').match(EMAIL_SCAN_RE) || []).filter(isEmail),
      function (e) { return e.toLowerCase(); });
    if (emails.length) notes.push('email:blind-scan');
  }
  if (!emails.length) blank.push('Emails');

  /* --- (g)(h) Сопственик / Управител --------------------------------- *
   * Both labels repeat once per person. Every occurrence is collected and the
   * ownership percentage is kept attached to the name, as the brief requires.
   */
  var owners = uniqBy(
    valuesForRepeatedLabel(CL, /^(сопственик|сопственици)$/, 6)
      .map(function (s) { return s.replace(/\s{2,}/g, ' ').trim(); })
      .filter(function (s) { return s.length > 1 && !isPersonLabel(s); }),
    function (s) { return norm(s); }
  );
  var managers = uniqBy(
    valuesForRepeatedLabel(CL, /^(управител|управители|претставник|претставници)$/, 6)
      .map(function (s) { return s.replace(/\s{2,}/g, ' ').trim(); })
      .filter(function (s) { return s.length > 1 && !isPersonLabel(s); }),
    function (s) { return norm(s); }
  );
  if (!owners.length) blank.push('Owners');
  if (!managers.length) blank.push('Managers');

  /* --- (i) НКЗ: numeric code only ------------------------------------ *
   * The field reads "46.710 - Трговија на големо со моторни возила"; only the
   * leading code is kept, the description after the dash is discarded.
   * A Cyrillic description is required for the page-wide fallback so a stray
   * decimal number elsewhere on the page cannot be mistaken for a code.
   */
  var nkdCode = '';
  var nkdRaw = labelValue(L, ['НКЗ', 'НКД', 'Дејност', 'Главна дејност', 'Шифра на дејност'], 3);
  if (nkdRaw) {
    var codeInLabel = String(nkdRaw).match(/(\d{2}\.\d{2,3})/);
    if (codeInLabel) nkdCode = codeInLabel[1];
  }
  if (!nkdCode) {
    var anyNkd = text.match(/(\d{2}\.\d{2,3})\s*[-\u2013\u2014]\s*[^\n]{0,4}[А-Яа-яЀ-ѿ]/);
    if (anyNkd) { nkdCode = anyNkd[1]; notes.push('nkd:page-wide-fallback'); }
  }
  if (!nkdCode) missing.push('NKD Code');

  /* --- (j)(k)(l) ФИНАНСИСКО РЕЗИМЕ ----------------------------------- */
  var profit = readFinancialRow(tables, L, PROFIT_LABEL_RE);
  var revenue = readFinancialRow(tables, L, REVENUE_LABEL_RE);
  var employees = readFinancialRow(tables, L, EMPLOYEES_LABEL_RE);

  if (!profit.found) missing.push('Profit/Loss (latest year)');
  if (!revenue.found) missing.push('Revenue (from list page)');
  // Employees is explicitly optional in the brief: blank rather than an error.
  var employeesValue = '';
  if (employees.found) {
    employeesValue = employees.value === null ? String(employees.raw || '').trim() : employees.value;
  } else {
    var empLine = labelValueByPrefix(L, [
      'Просечен број на вработени', 'Број на вработени', 'Вработени лица', 'Вработени'
    ]);
    var empInt = empLine ? firstInt(empLine) : null;
    if (empInt !== null) { employeesValue = empInt; notes.push('employees:from-label-line'); }
  }

  if (profit.found && profit.rightmostIsLatest === false) notes.push('profit:latest-year-not-rightmost');
  if (revenue.found && revenue.rightmostIsLatest === false) notes.push('revenue:latest-year-not-rightmost');
  if (profit.found && profit.strategy !== 'index-aligned') notes.push('profit:' + profit.strategy);
  if (revenue.found && revenue.strategy !== 'index-aligned') notes.push('revenue:' + revenue.strategy);

  return {
    name: name,
    edb: edb,
    embs: embs,
    dateFounded: dateFounded,
    phones: phones,
    emails: emails,
    owners: owners,
    managers: managers,
    nkdCode: nkdCode,
    profit: profit.found ? (profit.value === null ? String(profit.raw || '').trim() : profit.value) : '',
    profitYear: profit.found ? profit.year : null,
    revenue: revenue.found ? (revenue.value === null ? String(revenue.raw || '').trim() : revenue.value) : '',
    revenueYear: revenue.found ? revenue.year : null,
    employees: employeesValue,
    financialYears: (profit.years || revenue.years || []),
    missing: missing,
    blank: blank,
    /*
     * True when essentially nothing was extracted. That is not a "partial row"
     * — it means the label rules do not match this site's markup at all, and a
     * blank row in the sheet would hide it. The caller turns this into a loud
     * Errors row pointing at `npm run probe`.
     */
    /*
     * A title-derived name does not count as evidence the page parsed: the
     * <title> is present on every page including ones the rules cannot read.
     * Only a real heading or an extracted identifier/figure counts.
     */
    looksUnparsed: (!name || nameFromTitle) && !edb && !embs &&
      !nkdCode && !profit.found && !revenue.found,
    notes: notes,
    flags: diagnoseResponse(raw, 'profile')
  };
}

/* ------------------------------------------------------------------ *
 * Google Sheets row shaping
 * ------------------------------------------------------------------ */

/*
 * Exactly the 14 columns from the brief, in exactly this order. The Google
 * Sheets node uses auto-map, so these strings MUST equal row 1 of the sheet
 * character for character.
 *
 * "Revenue (from list page)" keeps the brief's column name even though the
 * value is read from the ФИНАНСИСКО РЕЗИМЕ table on the profile page — no data
 * is taken from the search-results page at all in this workflow.
 */
var SHEET_HEADERS = [
  'EMBS',
  'Company Name',
  'EDB',
  'Date Founded',
  'Phone Numbers',
  'Emails',
  'Owners',
  'Managers',
  'NKD Code',
  'Revenue (from list page)',
  'Number of Employees',
  'Profit/Loss (latest year)',
  'Profile URL',
  'Date Scraped'
];

/** Columns of the separate "Errors" tab. */
var ERROR_SHEET_HEADERS = [
  'EMBS',
  'Company Name',
  'Profile URL',
  'Error',
  'Missing Fields',
  'Written To Main Sheet',
  'Date Scraped'
];

var MULTI_SEP = '; ';

function buildSheetRow(p, profileUrl, scrapedAt) {
  return {
    'EMBS': p.embs || '',
    'Company Name': p.name || '',
    'EDB': p.edb || '',
    'Date Founded': p.dateFounded || '',
    'Phone Numbers': (p.phones || []).join(MULTI_SEP),
    'Emails': (p.emails || []).join(MULTI_SEP),
    'Owners': (p.owners || []).join(MULTI_SEP),
    'Managers': (p.managers || []).join(MULTI_SEP),
    'NKD Code': p.nkdCode || '',
    'Revenue (from list page)': p.revenue === null || p.revenue === undefined ? '' : p.revenue,
    'Number of Employees': p.employees === null || p.employees === undefined ? '' : p.employees,
    // NOTE: never filtered on. A loss is written exactly like a profit.
    'Profit/Loss (latest year)': p.profit === null || p.profit === undefined ? '' : p.profit,
    'Profile URL': profileUrl || '',
    'Date Scraped': scrapedAt || ''
  };
}

function buildErrorRow(fields) {
  return {
    'EMBS': fields.embs || '',
    'Company Name': fields.name || '',
    'Profile URL': fields.profileUrl || '',
    'Error': fields.error || '',
    'Missing Fields': (fields.missing || []).join(MULTI_SEP),
    'Written To Main Sheet': fields.written ? 'yes' : 'no',
    'Date Scraped': fields.scrapedAt || ''
  };
}

/* === EXPORTS (stripped by build/build-workflow.js) === */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BASE_URL: BASE_URL,
    DEFAULT_SEARCH_URL: DEFAULT_SEARCH_URL,
    decodeEntities: decodeEntities,
    stripTags: stripTags,
    htmlToLines: htmlToLines,
    norm: norm,
    digitsOnly: digitsOnly,
    escapeRe: escapeRe,
    uniqBy: uniqBy,
    errorMessage: errorMessage,
    mkNumber: mkNumber,
    firstInt: firstInt,
    isEmail: isEmail,
    isPhone: isPhone,
    phoneKey: phoneKey,
    cleanPhone: cleanPhone,
    labelValue: labelValue,
    labelValueByPrefix: labelValueByPrefix,
    valuesUnderLabel: valuesUnderLabel,
    valuesForRepeatedLabel: valuesForRepeatedLabel,
    isPersonLabel: isPersonLabel,
    isSectionHeading: isSectionHeading,
    sectionLines: sectionLines,
    sectionHtml: sectionHtml,
    buildSearchUrl: buildSearchUrl,
    readRevenueBand: readRevenueBand,
    withRevenueBand: withRevenueBand,
    splitBand: splitBand,
    formatBand: formatBand,
    diagnoseResponse: diagnoseResponse,
    isBlockingFlag: isBlockingFlag,
    detectNoResultsMarker: detectNoResultsMarker,
    findProfileAnchors: findProfileAnchors,
    isProfilePath: isProfilePath,
    parseSearchResults: parseSearchResults,
    parseHtmlTables: parseHtmlTables,
    findYearHeader: findYearHeader,
    readYearRow: readYearRow,
    readYearRowFromLines: readYearRowFromLines,
    readFinancialRow: readFinancialRow,
    PROFIT_LABEL_RE: PROFIT_LABEL_RE,
    REVENUE_LABEL_RE: REVENUE_LABEL_RE,
    EMPLOYEES_LABEL_RE: EMPLOYEES_LABEL_RE,
    parseProfile: parseProfile,
    SHEET_HEADERS: SHEET_HEADERS,
    ERROR_SHEET_HEADERS: ERROR_SHEET_HEADERS,
    MULTI_SEP: MULTI_SEP,
    buildSheetRow: buildSheetRow,
    buildErrorRow: buildErrorRow
  };
}
