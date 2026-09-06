#!/usr/bin/env node
'use strict';

/*
 * Generates workflow/companywall-mk-grant-leads.json.
 *
 * The n8n Code node sandbox cannot `require` local files, so every Code node
 * needs its own copy of the parser library. This script inlines src/parsers.js
 * into each node source at the `// @inject-parsers` marker, which keeps
 * src/parsers.js the single place where extraction logic is edited.
 *
 * Run: npm run build
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'workflow', 'companywall-mk-grant-leads.json');

const SCRAPINGBEE_CREDENTIAL_NAME = 'ScrapingBee API';
const GOOGLE_SHEETS_CREDENTIAL_NAME = 'Google Sheets account';
const SHEET_ID_PLACEHOLDER = 'REPLACE_WITH_GOOGLE_SHEET_ID';

// The brief asks for 1-2s between requests. 2s is the top of that range.
// The sister CompanyWall workflows use 4s, matching the site's own guidance
// ("Не испраќајте премногу барања за пребарување одеднаш" / 3-5s) — raise this
// if the run trips rate limiting. build/validate-workflow.js allows 1-5s.
const WAIT_SECONDS = 2;

const { SHEET_HEADERS, ERROR_SHEET_HEADERS, DEFAULT_SEARCH_URL } = require('../src/parsers');

/* ------------------------------------------------------------------ *
 * Code node assembly
 * ------------------------------------------------------------------ */

const parsersSource = (function () {
  const raw = fs.readFileSync(path.join(ROOT, 'src', 'parsers.js'), 'utf8');
  const marker = '/* === EXPORTS (stripped by build/build-workflow.js) === */';
  const idx = raw.indexOf(marker);
  if (idx === -1) {
    throw new Error('Export sentinel not found in src/parsers.js — cannot strip module.exports.');
  }
  return raw
    .slice(0, idx)
    .replace(/^'use strict';\n/, '')
    .trimEnd();
})();

function codeFor(nodeFile) {
  const file = path.join(ROOT, 'src', 'nodes', nodeFile);
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes('// @inject-parsers')) {
    throw new Error(`${nodeFile} is missing the "// @inject-parsers" marker.`);
  }
  const header = [
    '/* ---------------------------------------------------------------- *',
    ' * GENERATED FILE — do not edit inside n8n.',
    ` * Source: src/nodes/${nodeFile} + src/parsers.js`,
    ' * Edit those, then run `npm run build` and re-import this workflow.',
    ' * ---------------------------------------------------------------- */',
    '',
  ].join('\n');

  // A FUNCTION replacer, deliberately: with a string replacement, `$&`, `$'`
  // and `$\`` inside parsersSource would be interpreted as substitution
  // patterns and silently corrupt the inlined library (parsers.js contains
  // `$'` in a regex-building expression).
  return header + src.replace('// @inject-parsers', function () { return parsersSource; });
}

/* ------------------------------------------------------------------ *
 * Node factories
 * ------------------------------------------------------------------ */

let idSeq = 0;
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function nodeId(name) {
  idSeq += 1;
  return `cwg-${String(idSeq).padStart(2, '0')}-${slug(name)}`;
}

function codeNode(name, file, position) {
  return {
    parameters: { jsCode: codeFor(file) },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
  };
}

function waitNode(name, position, seconds) {
  return {
    parameters: { amount: seconds, unit: 'seconds' },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.wait',
    typeVersion: 1.1,
    position,
    // Wait nodes always carry a webhookId; intervals under ~65s resume in
    // memory without ever calling it.
    webhookId: `cwg-wait-${slug(name)}`,
  };
}

/*
 * ScrapingBee GET — identical configuration to the sister CompanyWall
 * workflows:
 *  - Query Auth credential supplies `api_key`; it is never written into the JSON.
 *  - fullResponse + neverError so a 403/429 reaches the Code node as data
 *    instead of throwing and losing the loop state.
 *  - render_js off by default: these are server-rendered pages. Flip
 *    Config.renderJs to "true" only if the probe shows the financial summary
 *    table is missing from the raw HTML.
 */
function scrapingBeeNode(name, position, notes) {
  return {
    parameters: {
      url: 'https://app.scrapingbee.com/api/v1/',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpQueryAuth',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'url', value: '={{ $json.targetUrl }}' },
          { name: 'render_js', value: '={{ $json.renderJs }}' },
          { name: 'premium_proxy', value: '={{ $json.premiumProxy }}' },
        ],
      },
      options: {
        timeout: 180000,
        response: {
          response: {
            fullResponse: true,
            neverError: true,
            responseFormat: 'text',
            outputPropertyName: 'body',
          },
        },
      },
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    retryOnFail: false, // never hammer the site after a rejection
    onError: 'continueRegularOutput',
    credentials: {
      httpQueryAuth: {
        id: 'REPLACE_WITH_SCRAPINGBEE_CREDENTIAL_ID',
        name: SCRAPINGBEE_CREDENTIAL_NAME,
      },
    },
    notes,
    notesInFlow: true,
  };
}

function splitInBatchesNode(name, position) {
  return {
    parameters: { batchSize: 1, options: { reset: false } },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.splitInBatches',
    typeVersion: 3,
    position,
  };
}

function ifNode(name, expression, position, notes) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: `${slug(name)}-cond-1`,
            leftValue: expression,
            rightValue: '',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      looseTypeValidation: true,
      options: {},
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position,
    notes,
    notesInFlow: Boolean(notes),
  };
}

function sheetsCredentials() {
  return {
    googleSheetsOAuth2Api: {
      id: 'REPLACE_WITH_GOOGLE_SHEETS_CREDENTIAL_ID',
      name: GOOGLE_SHEETS_CREDENTIAL_NAME,
    },
  };
}

/** Google Sheets append, auto-mapped by header name. */
function sheetsAppendNode(name, position, sheetNameExpr, notes) {
  return {
    parameters: {
      operation: 'append',
      documentId: {
        __rl: true,
        value: "={{ $('Config').first().json.googleSheetId }}",
        mode: 'id',
      },
      sheetName: { __rl: true, value: sheetNameExpr, mode: 'name' },
      columns: {
        mappingMode: 'autoMapInputData',
        value: {},
        matchingColumns: [],
        schema: [],
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
      options: { cellFormat: 'USER_ENTERED' },
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4.5,
    position,
    // A Sheets hiccup must not abort the scrape mid-run.
    onError: 'continueRegularOutput',
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    credentials: sheetsCredentials(),
    notes,
    notesInFlow: true,
  };
}

/*
 * Google Sheets lookup — the per-company duplicate check.
 *
 * Reads the main tab filtered to rows whose EMBS column equals this company's
 * ЕМБС. alwaysOutputData is essential: with no match the node returns zero
 * items, and a node with zero input items never executes, which would stall the
 * loop for every new company.
 */
function sheetsLookupNode(name, position) {
  return {
    parameters: {
      operation: 'read',
      documentId: {
        __rl: true,
        value: "={{ $('Config').first().json.googleSheetId }}",
        mode: 'id',
      },
      sheetName: {
        __rl: true,
        value: "={{ $('Config').first().json.sheetName }}",
        mode: 'name',
      },
      filtersUI: {
        values: [
          { lookupColumn: 'EMBS', lookupValue: '={{ $json.embs }}' },
        ],
      },
      options: {},
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4.5,
    position,
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    credentials: sheetsCredentials(),
    notes: 'Duplicate check: looks up this company\'s EMBS in the sheet before writing.',
    notesInFlow: true,
  };
}

function stickyNote(content, position, [width, height], color) {
  idSeq += 1;
  return {
    parameters: { content, height, width, color },
    id: `cwg-sticky-${idSeq}`,
    name: `Sticky Note ${idSeq}`,
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position,
  };
}

/* ------------------------------------------------------------------ *
 * Workflow
 * ------------------------------------------------------------------ */

const nodes = [
  {
    parameters: {},
    id: nodeId('Manual Trigger'),
    name: 'Manual Trigger',
    type: 'n8n-nodes-base.manualTrigger',
    typeVersion: 1,
    position: [-820, 300],
    notes: 'Run on demand. No schedule — this is a one-off campaign list build.',
    notesInFlow: true,
  },

  {
    parameters: {
      assignments: {
        assignments: [
          {
            id: 'cfg-search-url',
            name: 'searchUrl',
            value: DEFAULT_SEARCH_URL,
            type: 'string',
          },
          { id: 'cfg-sheet-id', name: 'googleSheetId', value: SHEET_ID_PLACEHOLDER, type: 'string' },
          { id: 'cfg-sheet-name', name: 'sheetName', value: 'Leads', type: 'string' },
          { id: 'cfg-error-sheet', name: 'errorSheetName', value: 'Errors', type: 'string' },
          { id: 'cfg-max-pages', name: 'maxPages', value: 50, type: 'number' },
          { id: 'cfg-max-companies', name: 'maxCompanies', value: 0, type: 'number' },
          // The site serves at most ~60 results per search however deep you
          // page. A band that comes back at this number is assumed truncated
          // and is bisected until every band comes back short.
          { id: 'cfg-ceiling', name: 'resultCeiling', value: 60, type: 'number' },
          { id: 'cfg-autosplit', name: 'autoSplitOnCeiling', value: 'true', type: 'string' },
          { id: 'cfg-max-bands', name: 'maxBands', value: 200, type: 'number' },
          { id: 'cfg-render-js', name: 'renderJs', value: 'false', type: 'string' },
          { id: 'cfg-premium', name: 'premiumProxy', value: 'false', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    id: nodeId('Config'),
    name: 'Config',
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position: [-600, 300],
    notes: 'SET googleSheetId HERE. searchUrl carries the >4,000,000 MKD revenue filter; the crawl subdivides it to beat the site\'s ~60-result ceiling.',
    notesInFlow: true,
  },

  codeNode('Init Run', 'init-run.js', [-380, 300]),

  /* --- pass 1: paginated search ----------------------------------- */
  codeNode('Build Search URL', 'build-search-url.js', [-160, 300]),
  waitNode('Wait Before Search', [60, 300], WAIT_SECONDS),
  scrapingBeeNode('ScrapingBee: Search', [280, 300],
    'GET one search-results page. Pagination appends &p=N to the Config URL.'),
  codeNode('Parse Search Results', 'parse-search-results.js', [500, 300]),
  ifNode('More Pages?', '={{ $json.hasMore }}', [720, 300],
    'true = another page of this band, or the next band; false = every band done.'),

  codeNode('Emit Profile URLs', 'emit-profile-urls.js', [940, 420]),

  /* --- pass 2: one profile per company ---------------------------- */
  splitInBatchesNode('Loop Companies', [1160, 420]),
  ifNode('Has Company?', '={{ $json.hasCompany }}', [1380, 540],
    'Guards the "search found nothing" marker item.'),
  codeNode('Build Profile Request', 'build-profile-request.js', [1600, 640]),
  waitNode('Wait Before Profile', [1820, 640], WAIT_SECONDS),
  scrapingBeeNode('ScrapingBee: Profile', [2040, 640],
    'GET the public /kompanija/ profile page (Резиме tab).'),
  codeNode('Parse Profile', 'parse-profile.js', [2260, 640]),
  ifNode('Profile OK?', '={{ $json.ok }}', [2480, 640],
    'false = fetch failed / blocked / no EMBS -> Errors tab, run continues.'),

  /* --- dedupe + write --------------------------------------------- */
  sheetsLookupNode('Google Sheets: Lookup EMBS', [2700, 540]),
  codeNode('Check Duplicate', 'check-duplicate.js', [2920, 540]),
  ifNode('Is New?', '={{ $json.__isNew }}', [3140, 540],
    'false = this EMBS is already in the sheet -> skip the company entirely.'),
  codeNode('Build Sheet Row', 'build-sheet-row.js', [3360, 380]),
  sheetsAppendNode('Google Sheets: Append Row', [3580, 380],
    "={{ $('Config').first().json.sheetName }}",
    'Appends one lead row. Header row must match the 14 column names exactly.'),
  ifNode('Log Missing Fields?',
    "={{ $('Parse Profile').first().json.hasMissing || !!$json.error }}", [3800, 380],
    'Logs blank fields, and a Sheets append that failed after its retries.'),

  codeNode('Build Error Row', 'build-error-row.js', [3580, 800]),
  sheetsAppendNode('Google Sheets: Append Error Row', [3800, 800],
    "={{ $('Config').first().json.errorSheetName }}",
    'Separate "Errors" tab — 7 columns, see README.'),

  /* --- finish ------------------------------------------------------ */
  codeNode('Run Summary', 'run-summary.js', [1380, 260]),
  {
    parameters: {},
    id: nodeId('Done'),
    name: 'Done',
    type: 'n8n-nodes-base.noOp',
    typeVersion: 1,
    position: [1600, 260],
  },
];

/* --- documentation stickies --- */
nodes.push(
  stickyNote(
    [
      '## Before the first run',
      '',
      '1. **Config** → set `googleSheetId` (and `sheetName` / `errorSheetName`',
      '   if your tabs are named differently).',
      '2. Re-select the credential on both **ScrapingBee** nodes and all three',
      '   **Google Sheets** nodes — credential IDs do not survive an export.',
      '3. Create the sheet header rows (14 columns on `Leads`, 7 on `Errors`).',
      '   See the README for the exact tab-separated strings.',
      '4. Run `SCRAPINGBEE_API_KEY=... npm run probe` in the repo first — it',
      '   makes 2 real calls and reports which extraction rules need adjusting',
      '   against the live HTML.',
    ].join('\n'),
    [-820, -60], [560, 300], 4
  ),
  stickyNote(
    [
      '### Pass 1 — search, split into revenue bands',
      '',
      '**The site serves at most ~60 results per search, however deep you**',
      '**page.** A single search therefore CANNOT return the whole campaign',
      'list. So the crawl works a queue of revenue bands: it starts with the',
      'band already in `searchUrl` (`4,000,000 – 4,000,000,000`), and whenever',
      'a band comes back at the ceiling it is bisected and both halves are',
      'queued. Consecutive bands partition the range exactly, so the union is',
      'the same set the single search was asking for.',
      '',
      'Only `dsm[0].From` / `dsm[0].To` are ever rewritten. Every other',
      'parameter is passed through byte-for-byte, and every request still',
      'carries `From >= 4000000`.',
      '',
      '**End of a band:** zero `/kompanija/` links (primary), a Cyrillic "no',
      'results" phrase, or only companies already seen in THIS band. A',
      '403/429/challenge is a FAILURE, never end-of-results.',
      'Adjust in `src/parsers.js` → `PROFILE_HREF_RE` / `NO_RESULTS_PATTERNS`.',
      '',
      'Only the profile href is taken from these pages — nothing else.',
    ].join('\n'),
    [-160, 60], [1060, 210], 5
  ),
  stickyNote(
    [
      '### Pass 2 — profile pages',
      '',
      'One request per company, extracting all 12 data fields from the',
      '"Резиме" tab: name, ЕДБ, ЕМБС, date founded, all phones, all emails,',
      'all owners (with %), all managers, НКЗ code (numeric part only),',
      'plus Вкупен приход / Добивка/загуба / employees for the LATEST year',
      'from the ФИНАНСИСКО РЕЗИМЕ table.',
      '',
      '**No profit/loss filtering.** Loss-making companies are written to the',
      'sheet exactly like profitable ones.',
    ].join('\n'),
    [1580, 300], [900, 210], 5
  ),
  stickyNote(
    [
      '### Dedupe → write',
      '',
      'The lookup searches the sheet\'s **EMBS** column for this company,',
      'per company, before writing. A hit skips the company entirely (no',
      'duplicate row, no update). A miss appends one row.',
      '',
      '`alwaysOutputData` on the lookup is required — with no match the node',
      'would otherwise return zero items and stall the loop.',
      '',
      '**Build Sheet Row** emits exactly the 14 columns and nothing else, so no',
      'control key ever reaches auto-map. If the append still fails, the cause',
      'is the sheet itself: check the TAB NAME and that row 1 holds the 14',
      'headers, spelled exactly. Open `Run Summary` — it names the error.',
    ].join('\n'),
    [2700, 220], [880, 190], 3
  ),
  stickyNote(
    [
      '### Error handling — the "Errors" tab',
      '',
      'Failures never stop the run. Two kinds of row land here:',
      '',
      '- `Written To Main Sheet = no` — the profile failed to load, was',
      '  blocked, or had no ЕМБС (so it could not be de-duplicated).',
      '- `Written To Main Sheet = yes` — the lead WAS written, but some',
      '  fields came back blank; `Missing Fields` names them.',
      '',
      'The loop continues with the next company either way.',
    ].join('\n'),
    [3340, 980], [700, 220], 2
  ),
  stickyNote(
    [
      '### Rate limiting',
      '',
      `A ${WAIT_SECONDS}s Wait precedes **every** outbound request, and both`,
      'batch sizes are 1, so exactly one request is ever in flight.',
      '',
      'The sister CompanyWall workflows use 4s (the site asks for 3-5s).',
      'Raise both Wait nodes if this run trips rate limiting.',
    ].join('\n'),
    [60, 460], [420, 200], 6
  )
);

const connections = {
  'Manual Trigger': { main: [[{ node: 'Config', type: 'main', index: 0 }]] },
  Config: { main: [[{ node: 'Init Run', type: 'main', index: 0 }]] },
  'Init Run': { main: [[{ node: 'Build Search URL', type: 'main', index: 0 }]] },

  'Build Search URL': { main: [[{ node: 'Wait Before Search', type: 'main', index: 0 }]] },
  'Wait Before Search': { main: [[{ node: 'ScrapingBee: Search', type: 'main', index: 0 }]] },
  'ScrapingBee: Search': { main: [[{ node: 'Parse Search Results', type: 'main', index: 0 }]] },
  'Parse Search Results': { main: [[{ node: 'More Pages?', type: 'main', index: 0 }]] },

  // true -> next page (back through the URL builder); false -> start pass 2
  'More Pages?': {
    main: [
      [{ node: 'Build Search URL', type: 'main', index: 0 }],
      [{ node: 'Emit Profile URLs', type: 'main', index: 0 }],
    ],
  },

  'Emit Profile URLs': { main: [[{ node: 'Loop Companies', type: 'main', index: 0 }]] },

  // splitInBatches output 0 = "done", output 1 = "loop"
  'Loop Companies': {
    main: [
      [{ node: 'Run Summary', type: 'main', index: 0 }],
      [{ node: 'Has Company?', type: 'main', index: 0 }],
    ],
  },

  'Has Company?': {
    main: [
      [{ node: 'Build Profile Request', type: 'main', index: 0 }],
      // "search found nothing" marker: consume it and let the loop finish.
      [{ node: 'Loop Companies', type: 'main', index: 0 }],
    ],
  },

  'Build Profile Request': { main: [[{ node: 'Wait Before Profile', type: 'main', index: 0 }]] },
  'Wait Before Profile': { main: [[{ node: 'ScrapingBee: Profile', type: 'main', index: 0 }]] },
  'ScrapingBee: Profile': { main: [[{ node: 'Parse Profile', type: 'main', index: 0 }]] },
  'Parse Profile': { main: [[{ node: 'Profile OK?', type: 'main', index: 0 }]] },

  'Profile OK?': {
    main: [
      [{ node: 'Google Sheets: Lookup EMBS', type: 'main', index: 0 }],
      [{ node: 'Build Error Row', type: 'main', index: 0 }],
    ],
  },

  'Google Sheets: Lookup EMBS': { main: [[{ node: 'Check Duplicate', type: 'main', index: 0 }]] },
  'Check Duplicate': { main: [[{ node: 'Is New?', type: 'main', index: 0 }]] },

  'Is New?': {
    main: [
      [{ node: 'Build Sheet Row', type: 'main', index: 0 }],
      // Duplicate EMBS: skip the company entirely and take the next one.
      [{ node: 'Loop Companies', type: 'main', index: 0 }],
    ],
  },

  'Build Sheet Row': { main: [[{ node: 'Google Sheets: Append Row', type: 'main', index: 0 }]] },
  'Google Sheets: Append Row': { main: [[{ node: 'Log Missing Fields?', type: 'main', index: 0 }]] },
  'Log Missing Fields?': {
    main: [
      [{ node: 'Build Error Row', type: 'main', index: 0 }],
      [{ node: 'Loop Companies', type: 'main', index: 0 }],
    ],
  },

  'Build Error Row': { main: [[{ node: 'Google Sheets: Append Error Row', type: 'main', index: 0 }]] },
  'Google Sheets: Append Error Row': { main: [[{ node: 'Loop Companies', type: 'main', index: 0 }]] },

  'Run Summary': { main: [[{ node: 'Done', type: 'main', index: 0 }]] },
};

const workflow = {
  name: 'CompanyWall.mk — Grant Campaign Leads (revenue > 4M MKD) → Google Sheets',
  nodes,
  connections,
  active: false,
  pinData: {},
  settings: {
    executionOrder: 'v1',
    saveManualExecutions: true,
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'all',
  },
  tags: [],
  meta: { instanceId: '' },
};

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(workflow, null, 2) + '\n', 'utf8');

const codeNodeCount = nodes.filter((n) => n.type === 'n8n-nodes-base.code').length;
console.log(`Wrote ${path.relative(ROOT, OUT_FILE)}`);
console.log(`  nodes: ${nodes.length} (${codeNodeCount} Code nodes with parsers.js inlined)`);
console.log(`  parsers.js inlined: ${parsersSource.length} chars per Code node`);
console.log(`  sheet columns: ${SHEET_HEADERS.length} main, ${ERROR_SHEET_HEADERS.length} errors`);
