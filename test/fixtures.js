'use strict';

/*
 * Synthetic HTML approximating CompanyWall.mk's conventions.
 *
 * IMPORTANT: these are NOT captures of the real site — no raw HTML was
 * available when this repo was written. They encode the *shape* described in
 * the brief's screenshots (Cyrillic label followed by value, КОНТАКТИ block,
 * ОСНОВНИ ИНФОРМАЦИИ box, ФИНАНСИСКО РЕЗИМЕ year table) in several plausible
 * markup variants, so the tests prove the parsers handle that shape and its
 * variations. They cannot prove the parsers match the real markup — only
 * `npm run probe` does that.
 */

/* The Cyrillic slug percent-encoded, exactly as it arrives in raw HTML. */
const ENCODED_SLUG =
  '%D0%B5%D1%83%D1%80%D0%BE%D0%B8%D0%BC%D0%BF%D0%B5%D0%BA%D1%81-%D0%B4%D0%BE%D0%BE-%D1%81%D0%BA%D0%BE%D0%BF%D1%98%D0%B5';

function page(bodyHtml) {
  return `<!doctype html><html lang="mk"><head><meta charset="utf-8">
<title>CompanyWall</title></head><body>
<header><a href="/najava">Најави се</a><a href="mailto:info@companywall.com.mk">info@companywall.com.mk</a>
<a href="tel:+38923112233">02/311-2233</a></header>
${bodyHtml}
<footer><span>Copyright CompanyWall</span></footer>
${'<!-- padding '.repeat(2400)}-->
</body></html>`;
}

/** A search-results page linking `count` companies, each linked twice. */
function searchPage(count, startAt) {
  const start = startAt || 1;
  let rows = '';
  for (let i = start; i < start + count; i++) {
    const href = `/kompanija/${ENCODED_SLUG}-${i}/MMA8dAg${i}`;
    rows += `
    <div class="result-row">
      <a href="${href}"><img src="/logo.png" alt=""></a>
      <a href="${href}"><h3>ЕУРОИМПЕКС ДОО СКОПЈЕ ${i}</h3></a>
      <span>ЕДБ</span><span>403000000000${i % 10}</span>
      <a href="${href}/lica">Лица</a>
    </div>`;
  }
  return page(`<main id="results">${rows}</main>`);
}

/** The "no more results" page: complete document, zero company links. */
const emptySearchPage = page(`<main id="results">
  <div class="empty"><p>Нема резултати за вашето пребарување.</p></div>
</main>`);

/** A results page with no company links and no "no results" wording either. */
const emptySearchPageNoMarker = page('<main id="results"></main>');

const cloudflarePage =
  '<html><head><title>Just a moment...</title></head><body>' +
  '<div class="cf-browser-verification">Checking your browser before accessing.</div></body></html>';

/* ------------------------------------------------------------------ *
 * Profile pages
 * ------------------------------------------------------------------ */

const CONTACTS_BLOCK = `
<section class="contacts">
  <h2>КОНТАКТИ</h2>
  <div class="row"><span class="label">ТЕЛ</span><span class="value">02/3221-455</span></div>
  <div class="row"><span class="label">ТЕЛ</span><span class="value">070 123 456</span></div>
  <div class="row"><span class="label">Е-ПОШТА</span><span class="value">kontakt@euroimpeks.mk</span></div>
  <div class="row"><span class="label">Е-ПОШТА</span><span class="value">prodazba@euroimpeks.mk</span></div>
  <div class="row"><span class="label">Сопственик</span><span class="value">КИРИЛ ВОИНОВСКИ(50,00%)</span></div>
  <div class="row"><span class="label">Сопственик</span><span class="value">ГОРАН ВОИНОВСКИ(50,00%)</span></div>
  <div class="row"><span class="label">Управител</span><span class="value">КИРИЛ ВОИНОВСКИ</span></div>
  <div class="row"><span class="label">Управител</span><span class="value">АНА СТОЈАНОВА</span></div>
</section>`;

const BASIC_INFO_BLOCK = `
<aside class="basic-info">
  <h2>ОСНОВНИ ИНФОРМАЦИИ</h2>
  <div><span>ЕМБС</span><span>6543210</span></div>
  <div><span>НКЗ</span><span>46.710 - Трговија на големо со моторни возила</span></div>
  <div><span>Големина</span><span>Мала</span></div>
</aside>`;

/** Ascending year columns — the ordinary case. */
const FINANCIAL_TABLE_ASC = `
<section class="financials">
  <h2>ФИНАНСИСКО РЕЗИМЕ</h2>
  <table>
    <thead><tr><th></th><th>2023</th><th>2024</th><th>2025</th></tr></thead>
    <tbody>
      <tr><td>Вкупен приход</td><td>98.450.000,00</td><td>112.300.500,00</td><td>128.450.900,00</td></tr>
      <tr><td>Добивка/загуба</td><td>1.200.000,00</td><td>-450.000,00</td><td>3.870.250,00</td></tr>
      <tr><td>Просечен број на вработени</td><td>24</td><td>26</td><td>31</td></tr>
    </tbody>
  </table>
</section>`;

/** Descending year columns — latest is the LEFTMOST, not the rightmost. */
const FINANCIAL_TABLE_DESC = `
<section class="financials">
  <h2>ФИНАНСИСКО РЕЗИМЕ</h2>
  <table>
    <thead><tr><th></th><th>2025</th><th>2024</th><th>2023</th></tr></thead>
    <tbody>
      <tr><td>Вкупен приход</td><td>128.450.900,00</td><td>112.300.500,00</td><td>98.450.000,00</td></tr>
      <tr><td>Добивка/загуба</td><td>3.870.250,00</td><td>-450.000,00</td><td>1.200.000,00</td></tr>
      <tr><td>Просечен број на вработени</td><td>31</td><td>26</td><td>24</td></tr>
    </tbody>
  </table>
</section>`;

/** No <table> markup at all — the div-grid fallback path. */
const FINANCIAL_DIVS = `
<section class="financials">
  <h2>ФИНАНСИСКО РЕЗИМЕ</h2>
  <div class="grid">
    <div class="hdr"><span></span><span>2023</span><span>2024</span><span>2025</span></div>
    <div class="r"><span>Вкупен приход</span><span>98.450.000,00</span><span>112.300.500,00</span><span>128.450.900,00</span></div>
    <div class="r"><span>Добивка/загуба</span><span>1.200.000,00</span><span>-450.000,00</span><span>3.870.250,00</span></div>
  </div>
</section>`;

/*
 * The КОНТАКТИ shape seen on a real page (ДМ ДРОГЕРИЕ МАРКТ): Управител rows
 * followed by Овластено лице rows. Only the Управител people are Managers.
 */
const CONTACTS_WITH_EXTRA_ROLES = `
<section class="contacts">
  <h2>КОНТАКТИ</h2>
  <div class="row"><span class="label">ТЕЛ</span><span class="value">02/3224-407</span></div>
  <div class="row"><span class="label">Е-ПОШТА</span><span class="value">vesna.s@dm-drogeriemarkt.rs</span></div>
  <div class="row"><span class="label">Сопственик</span><span class="value">дм дрогерие маркт ГмбХ (100,00%)</span></div>
  <div class="row"><span class="label">Управител</span><span class="value">АЛЕКСАНДРА ОЛИВЕРА КОРИШИ</span></div>
  <div class="row"><span class="label">Управител</span><span class="value">ВЕСНА СТОЈАНОВИЌ</span></div>
  <div class="row"><span class="label">Овластено лице</span><span class="value">КАТЕРИНА ДОНЕВА</span></div>
  <div class="row"><span class="label">Овластено лице</span><span class="value">ЕЛЕНА ТРАЈКОВСКА</span></div>
</section>`;

/* Two year columns landing on one line, with no tag boundary between them. */
const FINANCIAL_MERGED_CELLS = `
<section class="financials">
  <h2>ФИНАНСИСКО РЕЗИМЕ</h2>
  <div class="grid">
    <div><span>2024</span></div><div><span>2025</span></div>
    <div><span>Вкупен приход</span><span>3.100.000.000,00 3.595.905.000,00</span></div>
    <div><span>Добивка/загуба</span><span>140.000.000,00 168.612.000,00</span></div>
    <div><span>Просечен број на вработени</span><span>250 255</span></div>
  </div>
</section>`;

function profilePage(opts) {
  const o = opts || {};
  const financial = o.financial === undefined ? FINANCIAL_TABLE_ASC : o.financial;
  const contacts = o.contacts === undefined ? CONTACTS_BLOCK : o.contacts;
  const basic = o.basic === undefined ? BASIC_INFO_BLOCK : o.basic;
  const header = o.header === undefined
    ? `<h1>ЕУРОИМПЕКС ДОО УВОЗ-ИЗВОЗ СКОПЈЕ</h1>
       <div class="ids">
         <span>ЕДБ</span><span>4030995123456</span>
         <span>ЕМБС</span><span>6543210</span>
         <span>Датум на основање</span><span>12.03.2005</span>
       </div>`
    : o.header;
  return page(`<main class="profile">${header}${contacts}${basic}${financial}</main>`);
}

module.exports = {
  ENCODED_SLUG,
  page,
  searchPage,
  emptySearchPage,
  emptySearchPageNoMarker,
  cloudflarePage,
  profilePage,
  CONTACTS_BLOCK,
  CONTACTS_WITH_EXTRA_ROLES,
  FINANCIAL_MERGED_CELLS,
  BASIC_INFO_BLOCK,
  FINANCIAL_TABLE_ASC,
  FINANCIAL_TABLE_DESC,
  FINANCIAL_DIVS,
};
