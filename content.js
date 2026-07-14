/* PSI Copy Feedback - content script (Manifest V3, vanilla JS, no dependencies)
 *
 * Runs ONLY on https://pagespeed.web.dev/* (see manifest.json matches).
 *
 * Design notes:
 * - No localized text matching anywhere. Element location relies on stable
 *   Lighthouse renderer classes (lh-*), ARIA roles, DOM structure, URL
 *   parameters, and Material icon-font ligatures ("link", "content_copy"),
 *   which are locale-independent tokens, not translated copy. Every DOM
 *   selector lives in the SELECTORS registry (Phase 1) and is resolved through
 *   one tiered resolver, so drift is caught early and centrally.
 * - Lazy by design: nothing heavy runs continuously. A debounced
 *   MutationObserver only re-checks whether injection is still in place;
 *   all report parsing happens on user click (or an explicit __psicf_diag()).
 * - Every injected node/class is prefixed "psicf-" to avoid any collision
 *   with PSI. Native event handlers are never touched.
 * - Clipboard writes happen only from user gestures (click handlers), via
 *   navigator.clipboard.writeText with a document.execCommand fallback and
 *   a manual-copy dialog as last resort. The diagnostic and its dry-run are
 *   strictly read-only: no clipboard write, no navigation, no attribute stamp.
 */
(() => {
  'use strict';

  const P = 'psicf';
  const AUDIT_MARK = 'data-psicf';          // per-audit "row button placed" marker
  const INJECTED_MARK = 'data-psicf-injected'; // report-button anchor-container gate

  /* ================================================================== */
  /* Extension-context guard (invariant 11: context-invalidation)        */
  /*                                                                      */
  /* After an extension reload/update the old content script keeps        */
  /* running in an orphaned context; touching chrome.* then throws        */
  /* "Extension context invalidated". Every chrome.* access goes through   */
  /* this guard so a dead context stops work quietly instead of throwing.  */
  /* ================================================================== */

  function extContextValid() {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function extVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch (e) {
      return '?';
    }
  }

  /* ================================================================== */
  /* PHASE 1 - Selector abstraction layer                                */
  /*                                                                      */
  /* Verified against PSI as of 2026-07-14.                               */
  /*                                                                      */
  /* Single source of truth for every DOM selector in use. Each logical   */
  /* target maps to an ordered fallback chain (most stable first) plus a  */
  /* tier label:                                                          */
  /*   Tier 1  lh-* Lighthouse renderer classes                          */
  /*   Tier 2  ARIA roles + DOM structure / semantic elements            */
  /*   Tier 3  Material icon-font ligatures (native PSI chrome)           */
  /*   Tier 4  position relative to an already-resolved neighbor          */
  /* One resolver returns the first match and which tier fired, or null   */
  /* with a recorded miss. `driftWarn` targets console.warn once when a   */
  /* Tier-1 primary misses and a lower tier catches (drift early-warning).*/
  /* `crit` marks targets whose miss must abort injection cleanly.        */
  /* ================================================================== */

  const SELECTORS = {
    // --- Critical report structure (Tier 1: lh-* renderer classes) ---
    reportRoot:        { crit: true,  driftWarn: true,  chain: [{ tier: 1, css: '.lh-root' }, { tier: 1, css: '.lh-vars' }] },
    auditNode:         { crit: true,  driftWarn: true,  chain: [{ tier: 1, css: '.lh-audit' }] },
    category:          { crit: false, driftWarn: true,  chain: [{ tier: 1, css: '.lh-category' }] },
    categoryWrapper:   { crit: false, driftWarn: false, chain: [{ tier: 1, css: '.lh-category-wrapper' }] },

    // --- Audit content (Tier 1) ---
    auditTitle:        { crit: false, driftWarn: true,  chain: [{ tier: 1, css: '.lh-audit__title' }] },
    auditDisplayText:  { crit: false, driftWarn: false, chain: [{ tier: 1, css: '.lh-audit__display-text' }] },
    auditDescription:  { crit: false, driftWarn: false, chain: [{ tier: 1, css: '.lh-audit__description' }] },
    detailsTable:      { crit: false, driftWarn: false, chain: [{ tier: 1, css: 'table.lh-table' }] },
    headerCell:        { crit: false, driftWarn: false, chain: [{ tier: 2, css: 'th, td' }] },
    detailsList:       { crit: false, driftWarn: false, chain: [{ tier: 1, css: '.lh-list, .lh-checklist' }] },
    unsupportedDetail: { crit: false, driftWarn: false, chain: [{ tier: 1, css: '.lh-crc, .lh-crc-container, .lh-filmstrip, .lh-snippet, .lh-treemap, .lh-element-screenshot' }] },
    cellUrlAnchor:     { crit: false, driftWarn: false, chain: [{ tier: 1, css: '.lh-text__url a[href]' }] },
    cellSnippet:       { crit: false, driftWarn: false, chain: [{ tier: 1, css: '.lh-node__snippet' }] },
    cellAnyLink:       { crit: false, driftWarn: false, chain: [{ tier: 2, css: 'a[href]' }] },

    // --- Scores (Tier 1) ---
    scoreGaugeAnchor:  { crit: false, driftWarn: true,  chain: [{ tier: 1, css: 'a.lh-gauge__wrapper[href^="#"], a.lh-fraction__wrapper[href^="#"]' }] },
    scoreValue:        { crit: false, driftWarn: false, chain: [{ tier: 1, css: '.lh-gauge__percentage, .lh-fraction__content' }] },

    // --- Audit row header for per-audit icon (Tier 1 class -> Tier 2 structure) ---
    auditHeader:       { crit: false, driftWarn: false, chain: [{ tier: 1, css: '.lh-audit__header' }, { tier: 2, css: 'summary' }] },
    chevron:           { crit: false, driftWarn: false, chain: [{ tier: 1, css: '.lh-chevron-container' }] },

    // --- Strategy tabs (Tier 2: ARIA roles + structure) ---
    strategyTab:         { crit: false, driftWarn: false, chain: [{ tier: 2, css: '[role="tab"]' }] },
    strategyTabSelected: { crit: false, driftWarn: false, chain: [{ tier: 2, css: '[role="tab"][aria-selected="true"]' }] },
    strategyTablist:     { crit: false, driftWarn: false, chain: [{ tier: 2, css: '[role="tablist"]' }] },

    // --- Capture timestamp (Tier 2: semantic element) ---
    capturedTime:      { crit: false, driftWarn: false, chain: [{ tier: 2, css: 'time[datetime]' }] },

    // --- Native "Copy link" anchor (Tier 3: Material icon ligatures) ---
    nativeIcon:        { crit: false, driftWarn: false, chain: [{ tier: 3, css: 'i[class*="material-icon" i], span[class*="material-icon" i], .google-material-icons, .material-symbols-outlined' }] },
    nativeButton:      { crit: false, driftWarn: false, chain: [{ tier: 3, css: 'button, [role="button"], a' }] },

    // --- Analyzed-URL header link (Tier 4: position relative to resolved root) ---
    externalLink:      { crit: false, driftWarn: false, chain: [{ tier: 4, css: 'a[href^="http"]' }] },
  };

  // Class tokens for classList.contains checks and icon ligatures (centralized
  // so no severity/state class or ligature is hard-coded at a call site).
  const CLS = {
    auditNotApplicable: 'lh-audit--notapplicable',
    auditFail: 'lh-audit--fail',
    auditError: 'lh-audit--error',
    auditAverage: 'lh-audit--average',
    auditPass: 'lh-audit--pass',
    auditInformative: 'lh-audit--informative',
    auditManual: 'lh-audit--manual',
    subItemRow: 'lh-sub-item-row',
    nativeLigatures: ['link', 'content_copy', 'share', 'ios_share'],
    ownRowBtn: P + '-row-btn',
    ownReportBtn: P + '-report-btn',
  };

  // Google-owned hosts excluded when guessing the analyzed URL from a link.
  const EXCLUDE_HOST = /(^|\.)(pagespeed\.web\.dev|google\.com|googleapis\.com|gstatic\.com|web\.dev|chrome\.com|withgoogle\.com|googleblog\.com)$/i;

  // --- Selector health + drift warnings -----------------------------------
  const selHealth = {};             // key -> { status:'ok'|'fallback'|'miss', tier, index }
  const driftWarned = new Set();

  function recordResolve(key, index, tier, status) {
    selHealth[key] = { status, tier, index };
    const spec = SELECTORS[key];
    if (status === 'fallback' && spec && spec.driftWarn && !driftWarned.has(key)) {
      driftWarned.add(key);
      const primaryTier = spec.chain[0] ? spec.chain[0].tier : '?';
      try {
        console.warn(
          '[PSI Copy Feedback] selector drift: "' + key + '" fell back to tier ' + tier +
          ' (primary tier ' + primaryTier + ' missed). PSI markup may have changed.'
        );
      } catch (e) { /* diagnostics only */ }
    }
  }

  function _findFiltered(scope, css, filter) {
    const list = scope.querySelectorAll(css);
    for (const el of list) if (filter(el)) return el;
    return null;
  }

  // Resolve a single element for a logical target; records tier/miss.
  function resolveOne(scope, key, filter) {
    const chain = SELECTORS[key].chain;
    for (let i = 0; i < chain.length; i++) {
      const { tier, css } = chain[i];
      const el = filter ? _findFiltered(scope, css, filter) : scope.querySelector(css);
      if (el) {
        recordResolve(key, i, tier, i === 0 ? 'ok' : 'fallback');
        return { el, tier, index: i };
      }
    }
    recordResolve(key, -1, null, 'miss');
    return { el: null, tier: null, index: -1 };
  }

  // Resolve a collection for a logical target; first non-empty tier wins.
  function resolveAll(scope, key) {
    const chain = SELECTORS[key].chain;
    for (let i = 0; i < chain.length; i++) {
      const { tier, css } = chain[i];
      const els = [...scope.querySelectorAll(css)];
      if (els.length) {
        recordResolve(key, i, tier, i === 0 ? 'ok' : 'fallback');
        return { els, tier, index: i };
      }
    }
    recordResolve(key, -1, null, 'miss');
    return { els: [], tier: null, index: -1 };
  }

  // closest() variant that walks the chain (for ancestor resolution).
  function closestOf(el, key) {
    const chain = SELECTORS[key].chain;
    for (let i = 0; i < chain.length; i++) {
      const m = el.closest(chain[i].css);
      if (m) {
        recordResolve(key, i, chain[i].tier, i === 0 ? 'ok' : 'fallback');
        return m;
      }
    }
    recordResolve(key, -1, null, 'miss');
    return null;
  }

  // Convenience wrappers.
  const firstMatch = (scope, key, filter) => resolveOne(scope, key, filter).el;
  const allMatches = (scope, key) => resolveAll(scope, key).els;

  /* ------------------------------------------------------------------ */
  /* Generic helpers                                                     */
  /* ------------------------------------------------------------------ */

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (!el.getClientRects().length) return false;
    return getComputedStyle(el).visibility !== 'hidden';
  }

  // Output hygiene (constraint: plain text, no invisible or non-standard
  // characters, no emojis). Applied once to the final copied string.
  function sanitize(text) {
    return text
      .replace(/[\u200B-\u200F\u2028\u2029\uFEFF\u00AD]/g, '')
      .replace(/\u00A0/g, ' ')
      .replace(/[\u2013\u2014\u2212]/g, '-')
      .replace(/[\u2018\u2019\u201A]/g, "'")
      .replace(/[\u201C\u201D\u201E]/g, '"')
      .replace(/\u2026/g, '...')
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0E\uFE0F]/gu, '')
      .replace(/[ \t]+\n/g, '\n');
  }

  function localIsoNow() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const offMin = -d.getTimezoneOffset();
    const sign = offMin >= 0 ? '+' : '-';
    const abs = Math.abs(offMin);
    return (
      d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
      sign + p(Math.floor(abs / 60)) + ':' + p(abs % 60)
    );
  }

  /* ------------------------------------------------------------------ */
  /* Inline text extraction (markup stripped, raw URLs kept)             */
  /* ------------------------------------------------------------------ */

  const BLOCK_TAGS = new Set([
    'DIV', 'P', 'LI', 'UL', 'OL', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
    'TABLE', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE',
  ]);
  const SKIP_TAGS = new Set(['STYLE', 'SCRIPT', 'TEMPLATE', 'SVG', 'NOSCRIPT']);

  function inlineText(node) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        out += n.nodeValue;
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const el = n;
      const tag = el.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (el.hidden) continue;
      // Never serialize our own injected UI.
      if (el.classList && el.classList.contains(CLS.ownRowBtn)) continue;

      if (tag === 'A' && el.getAttribute('href')) {
        const label = norm(inlineText(el));
        let href = '';
        try { href = el.href || el.getAttribute('href'); } catch (e) { href = el.getAttribute('href') || ''; }
        if (!label) out += href;
        else if (!href || label === href) out += label;
        else out += label + ' (' + href + ')';
        out += ' ';
      } else if (tag === 'CODE') {
        const c = norm(inlineText(el));
        if (c) out += '`' + c + '` ';
      } else if (tag === 'BR') {
        out += ' ';
      } else {
        out += inlineText(el);
        if (BLOCK_TAGS.has(tag)) out += ' ';
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Details -> markdown                                                 */
  /* ------------------------------------------------------------------ */

  const mdEscape = (s) => s.replace(/\|/g, '\\|');

  function cellText(cell) {
    // Lighthouse URL cells: reconstruct the full URL from the anchor.
    const urlA = firstMatch(cell, 'cellUrlAnchor');
    if (urlA) {
      try { if (urlA.href) return urlA.href; } catch (e) { /* fall through */ }
    }
    const snippet = firstMatch(cell, 'cellSnippet');
    if (snippet) return '`' + norm(snippet.textContent) + '`';
    const onlyLink = firstMatch(cell, 'cellAnyLink');
    if (onlyLink && norm(cell.textContent) === norm(onlyLink.textContent)) {
      try { if (onlyLink.href) return onlyLink.href; } catch (e) { /* fall through */ }
    }
    let txt = norm(inlineText(cell));
    if (txt.length > 300) txt = txt.slice(0, 297) + '...';
    return txt;
  }

  function tableToMarkdown(table) {
    let headers = table.tHead
      ? allMatches(table.tHead, 'headerCell').map((c) => norm(inlineText(c)))
      : [];
    const bodyRows = [];
    for (const tbody of table.tBodies) {
      for (const tr of tbody.rows) {
        const cells = [...tr.cells].map(cellText);
        if (!cells.some((c) => c)) continue;
        if (tr.classList.contains(CLS.subItemRow) && cells.length) {
          cells[0] = cells[0] ? '- ' + cells[0] : '-';
        }
        bodyRows.push(cells);
      }
    }
    if (!bodyRows.length) return '';
    const width = Math.max(headers.length, ...bodyRows.map((r) => r.length));
    if (!headers.length) headers = Array.from({ length: width }, (_, i) => 'Col ' + (i + 1));
    const pad = (r) => {
      const c = r.slice(0, width);
      while (c.length < width) c.push('');
      return c;
    };
    const head = pad(headers).map((h) => mdEscape(h) || '-');
    const lines = [
      '| ' + head.join(' | ') + ' |',
      '| ' + head.map(() => '---').join(' | ') + ' |',
    ];
    for (const r of bodyRows) lines.push('| ' + pad(r).map(mdEscape).join(' | ') + ' |');
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /* Audit classification and serialization                              */
  /* ------------------------------------------------------------------ */

  const SEVERITIES = {
    error:   { group: 'errors',   tag: 'ERROR' },
    warning: { group: 'warnings', tag: 'WARNING' },
    pass:    { group: 'goodies',  tag: 'GOOD' },
    info:    { group: 'goodies',  tag: 'INFO' },
  };

  /* ------------------------------------------------------------------ */
  /* i18n (extension-generated strings only)                              */
  /*                                                                      */
  /* Localizes the injected UI and the scaffolding of the copied output.  */
  /* Audit titles/descriptions/tables are read from the page DOM and stay */
  /* in whatever locale PSI itself is rendered in (?hl=). Severity tags   */
  /* [ERROR]/[WARNING]/[GOOD]/[INFO] are fixed machine-readable tokens    */
  /* and are never translated.                                            */
  /* ------------------------------------------------------------------ */

  const I18N = {
    en: {
      reportBtn: 'Copy feedback',
      rowBtn: 'Copy this audit',
      popoverTitle: 'Include in copied feedback',
      popoverAria: 'Copy feedback options',
      groupErrors: 'Errors (failed audits)',
      groupWarnings: 'Warnings (needs improvement)',
      groupGoodies: 'Goodies (passed and informative)',
      langLabel: 'Output language',
      langBrowser: 'Browser default',
      cancel: 'Cancel',
      copy: 'Copy',
      docTitle: '# PageSpeed Insights feedback',
      fUrl: 'URL',
      fCaptured: 'Captured',
      fStrategy: 'Strategy',
      fScores: 'Scores',
      fCategory: 'Category',
      fValue: 'Value',
      fDescription: 'Description',
      secErrors: '## Errors (failed audits)',
      secWarnings: '## Warnings (needs improvement)',
      secGoodies: '## Goodies (passed and informative audits)',
      none: '(none)',
      untitled: '(untitled audit)',
      omittedUnsupported: '(details table omitted: unsupported detail format)',
      omittedUnparseable: '(details table omitted: could not parse this audit)',
      timeOfCopy: ' (time of copy)',
      unknown: 'Unknown',
      strategyMobile: 'Mobile',
      strategyDesktop: 'Desktop',
      toastAudit: 'Audit copied to clipboard',
      toastNone: 'Copied to clipboard (no matching audits)',
      toastOne: 'Copied 1 audit to clipboard',
      toastMany: 'Copied {n} audits to clipboard',
      toastFail: 'Automatic copy failed',
      manualAria: 'Manual copy',
      manualMsg: 'Clipboard access failed. Copy the text below manually (Ctrl+C / Cmd+C):',
      close: 'Close',
      noteLocale: 'Audit texts follow the PSI page language. Copy will automatically rerun the analysis in the selected language.',
      toastRerun: 'Switching language, rerunning analysis',
      toastWaiting: 'Analysis running, result will be copied automatically',
      toastFocus: 'Click this tab to finish the automatic copy',
      toastWaitFail: 'Automatic copy timed out, the report did not finish',
      toastRerunTab: 'Running the localized analysis in a new tab; it will copy and close itself',
      toastNoReport: 'No finished report to copy yet, wait for it to render',
      toastSwitchTimeout: 'Language switch timed out',
      toastSwitchBusy: 'A language switch is already running',
    },
    cs: {
      reportBtn: 'Kopírovat zpětnou vazbu',
      rowBtn: 'Kopírovat tento audit',
      popoverTitle: 'Zahrnout do kopírované zpětné vazby',
      popoverAria: 'Možnosti kopírování zpětné vazby',
      groupErrors: 'Chyby (neúspěšné audity)',
      groupWarnings: 'Varování (potřebuje zlepšení)',
      groupGoodies: 'Dobré (úspěšné a informativní)',
      langLabel: 'Jazyk výstupu',
      langBrowser: 'Podle prohlížeče',
      cancel: 'Zrušit',
      copy: 'Kopírovat',
      docTitle: '# Zpětná vazba PageSpeed Insights',
      fUrl: 'URL',
      fCaptured: 'Zachyceno',
      fStrategy: 'Strategie',
      fScores: 'Skóre',
      fCategory: 'Kategorie',
      fValue: 'Hodnota',
      fDescription: 'Popis',
      secErrors: '## Chyby (neúspěšné audity)',
      secWarnings: '## Varování (potřebuje zlepšení)',
      secGoodies: '## Dobré (úspěšné a informativní audity)',
      none: '(žádné)',
      untitled: '(audit bez názvu)',
      omittedUnsupported: '(tabulka detailů vynechána: nepodporovaný formát detailů)',
      omittedUnparseable: '(tabulka detailů vynechána: audit se nepodařilo zpracovat)',
      timeOfCopy: ' (čas kopírování)',
      unknown: 'Neznámé',
      strategyMobile: 'Mobil',
      strategyDesktop: 'Počítač',
      toastAudit: 'Audit zkopírován do schránky',
      toastNone: 'Zkopírováno do schránky (žádné odpovídající audity)',
      toastOne: 'Zkopírován 1 audit do schránky',
      // Fixed "count last" phrasing sidesteps Czech plural declension.
      toastMany: 'Do schránky zkopírováno auditů: {n}',
      toastFail: 'Automatické kopírování selhalo',
      manualAria: 'Ruční kopírování',
      manualMsg: 'Přístup ke schránce selhal. Zkopírujte text níže ručně (Ctrl+C / Cmd+C):',
      close: 'Zavřít',
      noteLocale: 'Texty auditů se řídí jazykem stránky PSI. Kopírovat automaticky spustí novou analýzu ve zvoleném jazyce.',
      toastRerun: 'Přepínám jazyk, spouštím novou analýzu',
      toastWaiting: 'Analýza běží, výsledek se automaticky zkopíruje',
      toastFocus: 'Klikněte do této karty pro dokončení automatického kopírování',
      toastWaitFail: 'Automatické kopírování vypršelo, analýza se nedokončila',
      toastRerunTab: 'Spouštím lokalizovanou analýzu v nové kartě, po dokončení se zkopíruje a karta se sama zavře',
      toastNoReport: 'Zatím není hotový report ke zkopírování, počkejte na jeho vykreslení',
      toastSwitchTimeout: 'Přepnutí jazyka vypršelo',
      toastSwitchBusy: 'Přepnutí jazyka už probíhá',
    },
  };

  const LANG_KEY = P + '-lang';
  const DEBUG_KEY = P + '-debug';
  let langPref = 'auto'; // 'auto' | 'en' | 'cs'
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'en' || saved === 'cs' || saved === 'auto') langPref = saved;
  } catch (e) { /* private mode: session-only preference */ }

  function resolveLang() {
    if (langPref !== 'auto') return langPref;
    return (navigator.language || 'en').toLowerCase().startsWith('cs') ? 'cs' : 'en';
  }

  function t(key) {
    const d = I18N[resolveLang()];
    return (d && d[key] !== undefined ? d[key] : I18N.en[key]) || '';
  }

  function setLangPref(v) {
    langPref = v;
    try { localStorage.setItem(LANG_KEY, v); } catch (e) { /* session-only */ }
    applyLanguage();
  }

  function classifyAudit(el) {
    const c = el.classList;
    if (c.contains(CLS.auditNotApplicable)) return null;
    if (c.contains(CLS.auditFail) || c.contains(CLS.auditError)) return SEVERITIES.error;
    if (c.contains(CLS.auditAverage)) return SEVERITIES.warning;
    if (c.contains(CLS.auditPass)) return SEVERITIES.pass;
    if (c.contains(CLS.auditInformative) || c.contains(CLS.auditManual)) return SEVERITIES.info;
    // Unknown future score-display variants: keep the data, tag as INFO.
    return SEVERITIES.info;
  }

  // Serializes one audit into the shared single-audit block format used by
  // both the report-level copy and the per-audit copy. Works on collapsed
  // audits too: the Lighthouse renderer builds the full DOM up front, so no
  // expansion is required to read titles, descriptions, or detail tables.
  function serializeAudit(auditEl) {
    const sev = classifyAudit(auditEl) || SEVERITIES.info;
    let title = '';
    try {
      title = norm(inlineText(firstMatch(auditEl, 'auditTitle') || auditEl));
    } catch (e) { /* keep going */ }
    const head = ['### [' + sev.tag + '] ' + (title || t('untitled'))];
    try {
      const catEl = closestOf(auditEl, 'category');
      let catId = catEl ? catEl.id : '';
      if (!catId && catEl) {
        const wrap = closestOf(catEl, 'categoryWrapper');
        if (wrap) catId = wrap.id;
      }
      if (catId) head.push(t('fCategory') + ': ' + catId);

      const disp = firstMatch(auditEl, 'auditDisplayText');
      const dispText = disp ? norm(inlineText(disp)) : '';
      if (dispText) head.push(t('fValue') + ': ' + dispText);

      const desc = firstMatch(auditEl, 'auditDescription');
      const descText = desc ? norm(inlineText(desc)) : '';
      if (descText) head.push(t('fDescription') + ': ' + descText);

      const blocks = [head.join('\n')];
      let parsedAny = false;

      allMatches(auditEl, 'detailsTable').forEach((tbl) => {
        try {
          const md = tableToMarkdown(tbl);
          if (md) { blocks.push(md); parsedAny = true; }
        } catch (e) { /* one bad table must not sink the audit */ }
      });

      allMatches(auditEl, 'detailsList').forEach((list) => {
        const items = [...list.children].map((c) => norm(inlineText(c))).filter(Boolean);
        if (items.length) {
          blocks.push(items.map((i) => '- ' + i).join('\n'));
          parsedAny = true;
        }
      });

      if (!parsedAny && firstMatch(auditEl, 'unsupportedDetail')) {
        blocks.push(t('omittedUnsupported'));
      }
      return blocks.join('\n\n');
    } catch (e) {
      // Graceful degradation on unparseable audit variants (constraint 7).
      head.push(t('omittedUnparseable'));
      return head.join('\n');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Report context (root, URL, strategy, timestamp, scores)             */
  /* ------------------------------------------------------------------ */

  function getVisibleRoot() {
    return firstMatch(document, 'reportRoot', isVisible);
  }

  function getStrategy(root) {
    // 1) Explicit URL parameter, when PSI reflects the tab in the URL.
    try {
      const ff = new URL(location.href).searchParams.get('form_factor');
      if (ff) return ff.toLowerCase() === 'desktop' ? t('strategyDesktop') : t('strategyMobile');
    } catch (e) { /* ignore */ }

    // 2) ARIA: the selected tab whose controlled panel contains the visible
    //    report. PSI lists Mobile first, Desktop second (positional, not
    //    text-based, so it holds in every UI language). This is the "visible
    //    strategy is the source of truth" invariant for copy (invariant 8).
    if (root) {
      for (const tab of allMatches(document, 'strategyTabSelected')) {
        const panelId = tab.getAttribute('aria-controls');
        if (!panelId) continue;
        const panel = document.getElementById(panelId);
        if (!panel || !panel.contains(root)) continue;
        const tablist = closestOf(tab, 'strategyTablist');
        if (!tablist) continue;
        const tabs = allMatches(tablist, 'strategyTab');
        const i = tabs.indexOf(tab);
        if (tabs.length === 2 && i === 0) return t('strategyMobile');
        if (tabs.length === 2 && i === 1) return t('strategyDesktop');
      }
    }

    // 3) Any visible two-tab tablist (PSI's strategy switcher shape).
    for (const tl of allMatches(document, 'strategyTablist')) {
      const tabs = allMatches(tl, 'strategyTab').filter(isVisible);
      if (tabs.length !== 2) continue;
      const i = tabs.findIndex((t2) => t2.getAttribute('aria-selected') === 'true');
      if (i === 0) return t('strategyMobile');
      if (i === 1) return t('strategyDesktop');
    }
    return t('unknown');
  }

  // --- Bridge freshness helpers (invariant 9) -----------------------------
  // The MAIN-world bridge stamps the Lighthouse locale + analyzed URL onto
  // <html> data attributes, and clears them the moment the analysis slug
  // changes. Before trusting either, assert the stamped URL still matches the
  // /analysis/<slug> the page currently shows; a stale bridge is treated as
  // not-ready (fall back to browser locale) rather than leaking last site's data.
  function bridgeLocaleAttr() {
    return document.documentElement.getAttribute('data-' + P + '-lhr-locale') || '';
  }
  function bridgeUrlAttr() {
    return document.documentElement.getAttribute('data-' + P + '-lhr-url') || '';
  }
  function currentSlug() {
    const m = location.pathname.match(/\/analysis\/([^/]+)/);
    return m ? m[1].toLowerCase() : '';
  }

  // Accept a bridged Lighthouse URL only when its scheme+host slug prefixes the
  // /analysis/<slug> the page currently shows (defense against SPA staleness).
  function bridgedMatchesPath(u) {
    const m = location.pathname.match(/\/analysis\/([^/]+)/);
    if (!m) return false;
    let p;
    try {
      p = new URL(u);
    } catch (e) {
      return false;
    }
    const prefix = (p.protocol.replace(':', '') + '-' + p.hostname)
      .replace(/[^a-z0-9]+/gi, '-')
      .toLowerCase();
    return !!prefix && m[1].toLowerCase().indexOf(prefix) === 0;
  }

  function bridgeUrlMatchesSlug() {
    const u = bridgeUrlAttr();
    return /^https?:\/\//i.test(u) && bridgedMatchesPath(u);
  }

  function getAnalyzedUrlExact(root) {
    // Bridged from the Lighthouse JSON (finalDisplayedUrl): most exact, but
    // only when it still matches the current slug (freshness assertion).
    const bridged = bridgeUrlAttr();
    if (/^https?:\/\//i.test(bridged) && bridgedMatchesPath(bridged)) return bridged;

    try {
      const q = new URL(location.href).searchParams.get('url');
      if (q) return q;
    } catch (e) { /* ignore */ }

    // First visible external link rendered BEFORE the report, which is PSI's
    // analyzed-URL link in the header. Google-owned hosts and doc links are
    // excluded; "Learn more" links all live inside the report root and are
    // filtered out by the document-order check.
    for (const a of allMatches(document, 'externalLink')) {
      if (!isVisible(a)) continue;
      if (root && !(a.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      let u;
      try { u = new URL(a.href); } catch (e) { continue; }
      if (EXCLUDE_HOST.test(u.hostname)) continue;
      return u.href;
    }
    return '';
  }

  function getAnalyzedUrl(root) {
    const exact = getAnalyzedUrlExact(root);
    if (exact) return exact;

    // Last resort: after an analysis PSI encodes the target in the path slug
    // (/analysis/https-betterguard-net/<id>). Dots and slashes both become
    // dashes, so reconstruction is approximate for hyphenated domains.
    const m = location.pathname.match(/\/analysis\/(https?)-([^/]+)/);
    if (m) return m[1] + '://' + m[2].split('-').join('.');

    return t('unknown');
  }

  function getCaptured() {
    // Prefer a machine-readable timestamp if PSI exposes one; otherwise use
    // the copy time and say so (localized timestamp text is not parsed).
    const timeEl = firstMatch(document, 'capturedTime', isVisible);
    if (timeEl && timeEl.getAttribute('datetime')) return timeEl.getAttribute('datetime');
    return localIsoNow() + t('timeOfCopy');
  }

  function getScores(scope) {
    const map = new Map();
    allMatches(scope, 'scoreGaugeAnchor').forEach((a) => {
      const id = (a.getAttribute('href') || '').slice(1);
      const val = firstMatch(a, 'scoreValue');
      if (!id || !val) return;
      let v = norm(val.textContent);
      if (!/\d/.test(v)) v = 'n/a';
      if (!map.has(id)) map.set(id, v);
    });
    if (!map.size) {
      allMatches(scope, 'category').forEach((cat) => {
        const val = firstMatch(cat, 'scoreValue');
        if (!cat.id || !val) return;
        let v = norm(val.textContent);
        if (!/\d/.test(v)) v = 'n/a';
        if (!map.has(cat.id)) map.set(cat.id, v);
      });
    }
    return map;
  }

  /* ------------------------------------------------------------------ */
  /* Report compilation (no-write: pure parse + format, invariant 14)    */
  /* ------------------------------------------------------------------ */

  function compileReport(groups) {
    const root = getVisibleRoot();
    const scope = root || document;

    const cats = allMatches(scope, 'category');
    const visibleCats = new Set(cats.filter(isVisible));

    const buckets = { errors: [], warnings: [], goodies: [] };
    let count = 0;
    allMatches(scope, 'auditNode').forEach((el) => {
      const sev = classifyAudit(el);
      if (!sev || !groups[sev.group]) return;
      // Honor "visible categories": audits inside collapsed clumps still
      // count (their category is visible); audits in a hidden category do not.
      const cat = closestOf(el, 'category');
      if (cat && visibleCats.size && !visibleCats.has(cat)) return;
      buckets[sev.group].push(serializeAudit(el));
      count++;
    });

    const lines = [t('docTitle'), ''];
    lines.push(t('fUrl') + ': ' + getAnalyzedUrl(root));
    lines.push(t('fCaptured') + ': ' + getCaptured());
    lines.push(t('fStrategy') + ': ' + getStrategy(root));
    const scores = getScores(scope);
    if (scores.size) {
      lines.push(t('fScores') + ':');
      for (const [id, v] of scores) lines.push('- ' + id + ': ' + v);
    }

    const SECTION = {
      errors: t('secErrors'),
      warnings: t('secWarnings'),
      goodies: t('secGoodies'),
    };
    for (const key of ['errors', 'warnings', 'goodies']) {
      if (!groups[key]) continue;
      lines.push('', SECTION[key], '');
      lines.push(buckets[key].length ? buckets[key].join('\n\n') : t('none'));
    }

    return { text: sanitize(lines.join('\n')).trim() + '\n', count };
  }

  // Strictly read-only dry run of the real parse+format path. No clipboard
  // write, no navigation, no attribute stamp. Used only by the diagnostic.
  function dryRunSerialize() {
    return compileReport({ errors: true, warnings: true, goodies: true }).text;
  }

  /* ------------------------------------------------------------------ */
  /* Clipboard                                                           */
  /* ------------------------------------------------------------------ */

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) { /* fall through to legacy path */ }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.readOnly = true;
      ta.style.cssText = 'position:fixed;top:-2000px;left:0;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Toast + manual-copy fallback dialog                                 */
  /* ------------------------------------------------------------------ */

  let toast = null;
  let toastTimer = 0;

  function showToast(msg, isError) {
    if (!toast) {
      toast = document.createElement('div');
      toast.className = P + '-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.toggle(P + '-toast--error', !!isError);
    // Restart the transition even for back-to-back toasts.
    toast.classList.remove(P + '-toast--show');
    void toast.offsetWidth;
    toast.classList.add(P + '-toast--show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove(P + '-toast--show'), 2400);
  }

  // Shared success toast for report-level and cross-tab copies.
  function countToast(count) {
    if (count === 0) showToast(t('toastNone'));
    else if (count === 1) showToast(t('toastOne'));
    else showToast(t('toastMany').replace('{n}', String(count)));
  }

  function failCopy(text) {
    showToast(t('toastFail'), true);
    const old = document.querySelector('.' + P + '-manual');
    if (old) old.remove();

    const dlg = document.createElement('div');
    dlg.className = P + '-manual';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-label', t('manualAria'));
    dlg.tabIndex = -1;

    const msg = document.createElement('div');
    msg.className = P + '-manual__msg';
    msg.textContent = t('manualMsg');

    const ta = document.createElement('textarea');
    ta.className = P + '-manual__text';
    ta.value = text;
    ta.readOnly = true;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = P + '-filled-btn';
    close.textContent = t('close');
    close.addEventListener('click', () => dlg.remove());
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); dlg.remove(); }
    });

    dlg.append(msg, ta, close);
    document.body.appendChild(dlg);
    ta.focus();
    ta.select();
  }

  /* ------------------------------------------------------------------ */
  /* Icons and buttons                                                   */
  /* ------------------------------------------------------------------ */

  const COPY_PATH =
    'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 ' +
    '1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z';

  function copyIcon(size) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', COPY_PATH);
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  }

  function buildReportButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = P + '-report-btn';
    btn.appendChild(copyIcon(18));
    const label = document.createElement('span');
    label.textContent = t('reportBtn');
    btn._label = label;
    btn.appendChild(label);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePopover(btn);
    });
    return btn;
  }

  function buildRowButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = P + '-row-btn';
    btn.title = t('rowBtn');
    btn.setAttribute('aria-label', t('rowBtn'));
    btn.appendChild(copyIcon(16));
    // Keep the surrounding <summary> from toggling the audit open/closed.
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
    });
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const audit = closestOf(btn, 'auditNode');
      if (!audit) { showToast(t('toastNoReport'), true); return; }
      const text = sanitize(serializeAudit(audit)).trim() + '\n';
      const ok = await copyText(text);
      if (ok) showToast(t('toastAudit'));
      else failCopy(text);
    });
    return btn;
  }

  /* ------------------------------------------------------------------ */
  /* Popover (group selection)                                           */
  /* ------------------------------------------------------------------ */

  let popover = null;
  let popoverAnchor = null;
  // Errors + Warnings preselected; remembered for the rest of the session.
  const selection = { errors: true, warnings: true, goodies: false };
  const GROUP_KEYS = ['errors', 'warnings', 'goodies'];
  const GROUP_LABEL_KEY = {
    errors: 'groupErrors',
    warnings: 'groupWarnings',
    goodies: 'groupGoodies',
  };

  // Re-labels every injected element after a language change. Popover parts
  // are updated via refs; buttons are found by class since they live inside
  // PSI's DOM.
  function applyLanguage() {
    document.querySelectorAll('.' + P + '-report-btn').forEach((b) => {
      if (b._label) b._label.textContent = t('reportBtn');
    });
    document.querySelectorAll('.' + P + '-row-btn').forEach((b) => {
      b.title = t('rowBtn');
      b.setAttribute('aria-label', t('rowBtn'));
    });
    if (!popover) return;
    popover.setAttribute('aria-label', t('popoverAria'));
    popover._title.textContent = t('popoverTitle');
    for (const key of GROUP_KEYS) popover._groupSpans[key].textContent = t(GROUP_LABEL_KEY[key]);
    popover._langLabel.textContent = t('langLabel');
    popover._langAutoOpt.textContent = t('langBrowser');
    popover._cancelBtn.textContent = t('cancel');
    popover._copyBtn.textContent = t('copy');
    updateLocaleNote();
  }

  // Locale match check. Priority: 1) the Lighthouse result's own generation
  // locale (configSettings.locale from window.__LIGHTHOUSE_*_JSON__, mirrored
  // to a DOM attribute by bridge.js since content scripts cannot read page
  // globals) - trusted only when the bridge URL still matches the current slug
  // (freshness assertion, invariant 9); 2) explicit ?hl= param; 3) assume PSI
  // followed Accept-Language. <html lang> is deliberately NOT consulted: PSI
  // hardcodes lang="en" in the shell regardless of the served UI language.
  function pageLocaleMatches(want) {
    const lhr = bridgeLocaleAttr().toLowerCase();
    if (lhr && bridgeUrlMatchesSlug()) return lhr.startsWith(want);
    let hl = '';
    try {
      hl = (new URL(location.href).searchParams.get('hl') || '').toLowerCase();
    } catch (e) { /* ignore */ }
    if (hl) return hl.startsWith(want);
    return (navigator.language || '').toLowerCase().startsWith(want);
  }

  // The extension cannot translate Lighthouse audit content; when the chosen
  // output language differs from the PSI page language, point at ?hl=.
  function updateLocaleNote() {
    if (!popover || !popover._note) return;
    const mismatch = !pageLocaleMatches(resolveLang());
    popover._note.hidden = !mismatch;
    popover._note.textContent = mismatch ? t('noteLocale') : '';
  }

  /* ------------------------------------------------------------------ */
  /* Localized-rerun automation (invariant 10)                           */
  /*                                                                      */
  /* Each rerun request carries a correlation id (cid). The spawned tab   */
  /* echoes it on the BroadcastChannel so the origin tab ignores stale or */
  /* foreign copies. Only one rerun may be in flight at a time            */
  /* (single-flight); a second request is rejected, never run concurrently*/
  /* An origin-side timeout surfaces "language switch timed out"; the      */
  /* spawned tab self-closes on completion or timeout so no orphan tabs    */
  /* accumulate.                                                          */
  /* ------------------------------------------------------------------ */

  let cidSeq = 0;
  function newCid() { return 'c' + Date.now().toString(36) + '-' + (++cidSeq); }

  // Origin-tab single-flight state: { cid, timer } while a rerun is pending.
  let switchState = null;
  const SWITCH_TIMEOUT_MS = 200000;

  function clearSwitch() {
    if (switchState && switchState.timer) clearTimeout(switchState.timer);
    switchState = null;
  }

  // Pending copy intent, stored per-tab so it survives the same-tab
  // navigation of a localized rerun. One-shot: takePending removes the key.
  const PENDING_KEY = P + '-pending';

  function savePending(groups, want, target, ff, cid) {
    try {
      sessionStorage.setItem(
        PENDING_KEY,
        JSON.stringify({ v: 1, groups, want, target, ff, cid, ts: Date.now() })
      );
    } catch (e) { /* storage blocked: flow degrades to manual copy */ }
  }

  function takePending() {
    let raw = null;
    try {
      raw = sessionStorage.getItem(PENDING_KEY);
      if (raw !== null) sessionStorage.removeItem(PENDING_KEY);
    } catch (e) {
      return null;
    }
    if (!raw) return null;
    try {
      const p = JSON.parse(raw);
      if (!p || p.v !== 1 || !p.groups || Date.now() - p.ts > 10 * 60 * 1000) return null;
      return p;
    } catch (e) {
      return null;
    }
  }

  function buildPopover() {
    popover = document.createElement('div');
    popover.className = P + '-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', t('popoverAria'));
    popover.tabIndex = -1;
    popover.hidden = true;

    const title = document.createElement('div');
    title.className = P + '-popover__title';
    title.textContent = t('popoverTitle');
    popover.appendChild(title);

    const inputs = {};
    const groupSpans = {};
    for (const key of GROUP_KEYS) {
      const lab = document.createElement('label');
      lab.className = P + '-popover__row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selection[key];
      cb.addEventListener('change', () => {
        selection[key] = cb.checked;
        copyBtn.disabled = !(selection.errors || selection.warnings || selection.goodies);
      });
      inputs[key] = cb;
      const span = document.createElement('span');
      span.textContent = t(GROUP_LABEL_KEY[key]);
      groupSpans[key] = span;
      lab.append(cb, span);
      popover.appendChild(lab);
    }

    // Output language row. "auto" follows navigator.language; the explicit
    // choices are shown as endonyms and never translated.
    const langRow = document.createElement('div');
    langRow.className = P + '-popover__lang';
    const langLabel = document.createElement('label');
    langLabel.className = P + '-popover__lang-label';
    langLabel.textContent = t('langLabel');
    langLabel.htmlFor = P + '-lang-select';
    const langSelect = document.createElement('select');
    langSelect.className = P + '-select';
    langSelect.id = P + '-lang-select';
    const optAuto = document.createElement('option');
    optAuto.value = 'auto';
    optAuto.textContent = t('langBrowser');
    const optEn = document.createElement('option');
    optEn.value = 'en';
    optEn.textContent = 'English';
    const optCs = document.createElement('option');
    optCs.value = 'cs';
    optCs.textContent = 'Čeština';
    langSelect.append(optAuto, optEn, optCs);
    langSelect.value = langPref;
    langSelect.addEventListener('change', () => setLangPref(langSelect.value));
    langRow.append(langLabel, langSelect);
    popover.appendChild(langRow);

    const note = document.createElement('div');
    note.className = P + '-popover__note';
    note.hidden = true;
    popover.appendChild(note);

    const actions = document.createElement('div');
    actions.className = P + '-popover__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = P + '-text-btn';
    cancelBtn.textContent = t('cancel');
    cancelBtn.addEventListener('click', closePopover);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = P + '-filled-btn';
    copyBtn.textContent = t('copy');
    copyBtn.addEventListener('click', onCopyClick);

    actions.append(cancelBtn, copyBtn);
    popover.appendChild(actions);
    popover._inputs = inputs;
    popover._copyBtn = copyBtn;
    popover._title = title;
    popover._groupSpans = groupSpans;
    popover._langLabel = langLabel;
    popover._langSelect = langSelect;
    popover._langAutoOpt = optAuto;
    popover._cancelBtn = cancelBtn;
    popover._note = note;
    document.body.appendChild(popover);

    document.addEventListener(
      'pointerdown',
      (e) => {
        if (popover.hidden) return;
        if (popover.contains(e.target)) return;
        if (popoverAnchor && popoverAnchor.contains(e.target)) return;
        closePopover();
      },
      true
    );
    document.addEventListener(
      'keydown',
      (e) => {
        if (!popover.hidden && e.key === 'Escape') {
          closePopover();
          if (popoverAnchor && popoverAnchor.isConnected) popoverAnchor.focus();
        }
      },
      true
    );
    window.addEventListener('resize', closeIfOpen);
    window.addEventListener('scroll', closeIfOpen, true);
  }

  async function onCopyClick() {
    // Locale mismatch: a stored analysis keeps the locale it was generated
    // with, so copy the RIGHT content by rerunning localized in a NEW tab.
    // The intent travels in the URL hash (sessionStorage is per-tab); the
    // new tab copies after render and closes itself (script-opened windows
    // may self-close). Popup blocked -> same-tab fallback via sessionStorage.
    try {
      const want = resolveLang();
      if (!pageLocaleMatches(want)) {
        const root = getVisibleRoot();
        const target = root ? getAnalyzedUrlExact(root) : '';
        if (root && /^https?:\/\//i.test(target)) {
          // Single-flight: never run two reruns concurrently (invariant 10).
          if (switchState) {
            closePopover();
            showToast(t('toastSwitchBusy'), true);
            return;
          }
          const cid = newCid();
          const u = new URL(location.href);
          const ff = u.searchParams.get('form_factor') || '';
          const rerun = new URL('/analysis', u.origin);
          rerun.searchParams.set('url', target);
          if (ff) rerun.searchParams.set('form_factor', ff);
          rerun.searchParams.set('hl', want);
          const payload = { v: 1, groups: { ...selection }, want, cid, ts: Date.now() };
          rerun.hash = P + '=' + encodeURIComponent(JSON.stringify(payload));
          closePopover();
          const w = window.open(rerun.href, '_blank');
          if (w) {
            switchState = {
              cid,
              timer: setTimeout(() => {
                if (switchState && switchState.cid === cid) {
                  clearSwitch();
                  showToast(t('toastSwitchTimeout'), true);
                }
              }, SWITCH_TIMEOUT_MS),
            };
            showToast(t('toastRerunTab'));
            return;
          }
          // Popup blocked: same-tab fallback. This navigation replaces the
          // page, so single-flight state is moot (the intent lives in storage).
          savePending({ ...selection }, want, target, ff, cid);
          showToast(t('toastRerun'));
          rerun.hash = '';
          location.assign(rerun.href);
          return;
        }
      }
    } catch (e) { /* fall through to a normal same-page copy */ }

    // Same-page copy. Unhappy path: report not rendered -> specific toast
    // instead of copying garbage (invariant 17).
    const root = getVisibleRoot();
    if (!root || !firstMatch(root, 'auditNode')) {
      closePopover();
      showToast(t('toastNoReport'), true);
      return;
    }

    let compiled;
    try {
      compiled = compileReport({ ...selection });
    } catch (e) {
      closePopover();
      showToast(t('toastFail'), true);
      return;
    }
    const { text, count } = compiled;
    closePopover();
    const ok = await copyText(text);
    if (!ok) { failCopy(text); return; }
    countToast(count);
  }

  function closeIfOpen() {
    if (popover && !popover.hidden) closePopover();
  }

  function closePopover() {
    if (popover) popover.hidden = true;
  }

  function togglePopover(anchor) {
    if (!popover) buildPopover();
    if (!popover.hidden && popoverAnchor === anchor) {
      closePopover();
      return;
    }
    popoverAnchor = anchor;
    for (const k in popover._inputs) popover._inputs[k].checked = selection[k];
    popover._copyBtn.disabled = !(selection.errors || selection.warnings || selection.goodies);
    popover._langSelect.value = langPref;
    updateLocaleNote();

    popover.style.visibility = 'hidden';
    popover.hidden = false;
    const r = anchor.getBoundingClientRect();
    const pw = popover.offsetWidth;
    const ph = popover.offsetHeight;
    let left = Math.min(Math.max(8, r.right - pw), window.innerWidth - pw - 8);
    let top = r.bottom + 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
    popover.style.left = Math.round(left) + 'px';
    popover.style.top = Math.round(top) + 'px';
    popover.style.visibility = '';
    popover.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------------ */
  /* Injection lifecycle (invariants 4, 5, 6, 8)                         */
  /* ------------------------------------------------------------------ */

  let lastInjectState = 'init'; // for diagnostics: init|no-report|no-audits|ok-native|ok-toolbar|no-anchor

  // The native "Copy link" control cannot be found via localized text or
  // PSI's minified class names. Material icon fonts, however, render
  // locale-independent ligature tokens ("link", "content_copy") as the icon
  // element's text, which is a stable structural anchor (Tier 3).
  function findNativeAnchor(root) {
    for (const icon of allMatches(document, 'nativeIcon')) {
      const lig = norm(icon.textContent);
      if (CLS.nativeLigatures.indexOf(lig) === -1) continue;
      const btn = closestOf(icon, 'nativeButton');
      if (!btn || !isVisible(btn)) continue;
      if (btn.classList.contains(CLS.ownReportBtn)) continue;
      // Only anchors above the report (the header toolbar), never links
      // inside audit content.
      if (root && !(btn.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      return btn;
    }
    return null;
  }

  // Idempotent, exactly-one-button injector (invariant 5). Gate: the anchor
  // container carries data-psicf-injected AND holds a visible connected button.
  // Extras (from PSI cloning a subtree) are removed; a second call is a no-op.
  function ensureReportButton() {
    const existing = [...document.querySelectorAll('.' + P + '-report-btn')];
    let keep = existing.find((b) => b.isConnected && isVisible(b)) || null;
    for (const b of existing) if (b !== keep) b.remove();
    document.querySelectorAll('.' + P + '-toolbar:empty').forEach((tb) => tb.remove());
    // Clear stale gate markers whose button no longer lives inside them.
    document.querySelectorAll('[' + INJECTED_MARK + ']').forEach((c) => {
      if (!c.querySelector('.' + P + '-report-btn')) c.removeAttribute(INJECTED_MARK);
    });
    if (keep) { lastInjectState = keep.classList.contains(P + '-report-btn--inline') ? 'ok-native' : 'ok-toolbar'; return; }

    // Critical anchor: no visible report on screen -> abort cleanly (invariant 4).
    const root = getVisibleRoot();
    if (!root) { lastInjectState = 'no-report'; return; }

    // Inject-after-render: never inject into an empty shell (invariant 6).
    if (!firstMatch(root, 'auditNode')) { lastInjectState = 'no-audits'; return; }

    const btn = buildReportButton();

    const native = findNativeAnchor(root);
    if (native) {
      btn.classList.add(P + '-report-btn--inline');
      native.insertAdjacentElement('afterend', btn);
      if (isVisible(btn)) {
        if (native.parentNode && native.parentNode.setAttribute) native.parentNode.setAttribute(INJECTED_MARK, '1');
        lastInjectState = 'ok-native';
        return;
      }
      // Anchor context turned out to be non-rendering; fall back cleanly.
      btn.remove();
      btn.classList.remove(P + '-report-btn--inline');
    }

    // Toolbar fallback directly above the visible report.
    if (!root.parentNode) { lastInjectState = 'no-anchor'; return; }
    const bar = document.createElement('div');
    bar.className = P + '-toolbar';
    root.parentNode.insertBefore(bar, root);
    bar.appendChild(btn);
    if (root.parentNode.setAttribute) root.parentNode.setAttribute(INJECTED_MARK, '1');
    lastInjectState = 'ok-toolbar';
  }

  function ensureRowButtons() {
    // Non-critical (invariant 4): per-audit icons degrade independently; the
    // report-level button keeps working even if this finds nothing.
    const audits = allMatches(document, 'auditNode').filter((a) => !a.hasAttribute(AUDIT_MARK));
    for (const audit of audits) {
      audit.setAttribute(AUDIT_MARK, '1');
      const header = firstMatch(audit, 'auditHeader') || audit;
      const chevron = firstMatch(header, 'chevron');
      const btn = buildRowButton();
      if (chevron) header.insertBefore(btn, chevron);
      else header.appendChild(btn);
    }
  }

  let ensureTimer = 0;
  function scheduleEnsure() {
    if (!extContextValid()) { stopObserver(); return; }
    if (ensureTimer) return;
    ensureTimer = setTimeout(() => {
      ensureTimer = 0;
      if (!extContextValid()) { stopObserver(); return; }
      try {
        ensureReportButton();
        ensureRowButtons();
      } catch (e) {
        // Never let injection errors leak into the host page.
      }
    }, 250);
  }

  /* ------------------------------------------------------------------ */
  /* Observer (invariant 7): one debounced observer, injection-only,     */
  /* never parses, no continuous polling. See docs/decisions.md for why  */
  /* a top-level mount observer is required on PSI's pushState SPA (a     */
  /* strictly root-scoped observer goes deaf when PSI replaces the report */
  /* subtree, breaking exactly-one-button / inject-after-render).        */
  /* ------------------------------------------------------------------ */

  let observer = null;

  function stopObserver() {
    if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } observer = null; }
  }

  function startObserver() {
    if (observer || !extContextValid()) return;
    // The callback only schedules a debounced, idempotent, cheap injection
    // check - it never parses the report.
    observer = new MutationObserver(() => {
      if (!extContextValid()) { stopObserver(); return; }
      scheduleEnsure();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'aria-selected', 'style', 'class'],
    });
  }

  /* ------------------------------------------------------------------ */
  /* Localized-rerun resume (helper tab / same-tab fallback)             */
  /* ------------------------------------------------------------------ */

  // Pending intent carried in the URL hash by the new-tab flow. Stripped from
  // the address bar immediately so PSI and the user never see it.
  function takeHashPending() {
    const key = '#' + P + '=';
    const h = location.hash || '';
    if (!h.startsWith(key)) return null;
    let p = null;
    try {
      p = JSON.parse(decodeURIComponent(h.slice(key.length)));
    } catch (e) {
      return null;
    }
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) { /* cosmetic only */ }
    if (!p || p.v !== 1 || !p.groups || Date.now() - p.ts > 10 * 60 * 1000) return null;
    p.fromTab = true;
    return p;
  }

  // Finishes a Copy that triggered a localized rerun. Waits until the report
  // DOM is present AND stable (PSI renders categories progressively), then
  // compiles with the saved group selection and copies. The stable-render gate
  // (invariant 10) requires a nonzero, steady lh-audit count plus a rendered
  // score before copying - no fixed pre-copy timeout. The async clipboard API
  // needs a focused document, so an unfocused tab waits for focus (the
  // execCommand fallback inside copyText usually succeeds even unfocused
  // thanks to the clipboardWrite permission).
  const STABLE_TICKS = 6;      // ~3 s of unchanged audit count = render settled
  const RESUME_TIMEOUT_MS = 180000;

  function resumePending() {
    const p = takeHashPending() || takePending();
    if (!p) return;
    let hl = '';
    try {
      hl = (new URL(location.href).searchParams.get('hl') || '').toLowerCase();
    } catch (e) { /* ignore */ }
    if (!hl.startsWith(p.want)) return; // Not the page this intent navigated to.

    showToast(t('toastWaiting'));
    const started = Date.now();
    let lastCount = -1;
    let stable = 0;

    const broadcast = (msg) => {
      try { new BroadcastChannel(P).postMessage(msg); } catch (e) { /* cross-tab toast is optional */ }
    };
    const selfCloseIfHelper = () => {
      // Script-opened window: allowed to close itself. Small delay lets any
      // clipboard write settle before teardown, and prevents orphan tabs.
      if (p.fromTab) setTimeout(() => { try { window.close(); } catch (e) { /* ignore */ } }, 400);
    };

    const iv = setInterval(() => {
      if (Date.now() - started > RESUME_TIMEOUT_MS) {
        clearInterval(iv);
        showToast(t('toastWaitFail'), true);
        broadcast({ type: 'switch-timeout', cid: p.cid || null });
        selfCloseIfHelper();
        return;
      }
      const root = getVisibleRoot();
      if (!root) return;
      const count = allMatches(root, 'auditNode').length;
      const hasScore = !!firstMatch(root, 'scoreValue');
      if (!count || !hasScore) {
        lastCount = count;
        stable = 0;
        return;
      }
      if (count === lastCount) stable++;
      else {
        lastCount = count;
        stable = 0;
      }
      if (stable < STABLE_TICKS) return;
      clearInterval(iv);

      let compiled;
      try {
        compiled = compileReport(p.groups);
      } catch (e) {
        showToast(t('toastFail'), true);
        broadcast({ type: 'switch-timeout', cid: p.cid || null });
        selfCloseIfHelper();
        return;
      }
      const finish = async () => {
        const ok = await copyText(compiled.text);
        if (!ok) {
          failCopy(compiled.text);
          return;
        }
        countToast(compiled.count);
        broadcast({ type: 'copied', count: compiled.count, cid: p.cid || null });
        selfCloseIfHelper();
      };
      if (document.hasFocus()) {
        finish();
      } else {
        showToast(t('toastFocus'));
        const onFocus = () => {
          window.removeEventListener('focus', onFocus);
          finish();
        };
        window.addEventListener('focus', onFocus);
      }
    }, 500);
  }

  /* ================================================================== */
  /* World-boundary aggregation (invariant 15) + diagnostic messaging    */
  /*                                                                      */
  /* content.js (isolated world) asks bridge.js (MAIN world) for its      */
  /* slice - Lighthouse globals readable, bridge URL/locale, slug match - */
  /* via window.postMessage. A bridge that does not answer within a       */
  /* bounded timeout is reported as FAIL "bridge not responding".         */
  /* ================================================================== */

  let bridgeReqSeq = 0;
  const bridgeWaiters = new Map();

  function requestBridgeSlice(timeoutMs) {
    return new Promise((resolve) => {
      const nonce = 'b' + (++bridgeReqSeq) + '-' + Date.now().toString(36);
      let done = false;
      const finish = (val) => { if (done) return; done = true; clearTimeout(timer); bridgeWaiters.delete(nonce); resolve(val); };
      const timer = setTimeout(() => finish({ responded: false }), timeoutMs || 800);
      bridgeWaiters.set(nonce, (slice) => finish(Object.assign({ responded: true }, slice)));
      try {
        window.postMessage({ __psicf: 'bridge-req', nonce }, location.origin);
      } catch (e) {
        finish({ responded: false });
      }
    });
  }

  function onWindowMessage(e) {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || typeof d.__psicf !== 'string') return;
    if (d.__psicf === 'bridge-res' && d.nonce && bridgeWaiters.has(d.nonce)) {
      bridgeWaiters.get(d.nonce)(d.slice || {});
    } else if (d.__psicf === 'diag-req' && d.nonce) {
      // MAIN-world __psicf_diag() forwarder asked us to run a diagnostic.
      runDiag().then((res) => {
        try { window.postMessage({ __psicf: 'diag-res', nonce: d.nonce, result: res }, location.origin); } catch (_) { /* ignore */ }
      });
    } else if (d.__psicf === 'nav') {
      // Bridge detected an SPA slug change (MAIN world sees pushState nav that
      // may not fire hashchange/popstate). Re-check injection.
      scheduleEnsure();
    }
  }

  /* ================================================================== */
  /* PHASE 3 - Self-diagnostic mode: window.__psicf_diag()               */
  /*                                                                      */
  /* Read-only: no clipboard write, no navigation, no attribute stamp.    */
  /* Returns a structured object and pretty-prints grouped OK/WARN/FAIL.  */
  /* OK = nominal; WARN = degraded but functional; FAIL = a depended-on   */
  /* subsystem is broken.                                                 */
  /* ================================================================== */

  function looksLikeLocale(s) {
    return /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(s || '');
  }

  function containsHtml(text) {
    return /<\/?(div|span|a|p|table|tr|td|th|ul|ol|li|svg|button|code|br|img|h[1-6])\b/i.test(text || '');
  }

  async function runDiag() {
    const groups = {};
    const add = (g, label, status, detail) => {
      (groups[g] || (groups[g] = [])).push({ label, status, detail: detail == null ? '' : String(detail) });
    };

    /* --- Environment --- */
    const hostOk = location.hostname === 'pagespeed.web.dev';
    add('environment', 'host is pagespeed.web.dev', hostOk ? 'OK' : 'FAIL', location.hostname);
    add('environment', 'extension context valid', extContextValid() ? 'OK' : 'FAIL', extContextValid() ? 'v' + extVersion() : 'invalidated');
    add('environment', 'content script loaded', 'OK', 'this script is running');

    const slice = await requestBridgeSlice(1000);
    if (!slice.responded) {
      add('environment', 'bridge script loaded', 'FAIL', 'bridge not responding');
    } else {
      add('environment', 'bridge script loaded', 'OK', 'responded');
    }

    /* --- DOM anchors --- */
    const root = getVisibleRoot();
    add('dom', 'report container present', root ? 'OK' : 'FAIL', root ? '' : 'no visible .lh-root/.lh-vars');
    const auditEls = root ? allMatches(root, 'auditNode') : [];
    add('dom', 'lh-audit count > 0', auditEls.length ? 'OK' : (root ? 'FAIL' : 'WARN'), 'count=' + auditEls.length);

    let classified = 0;
    for (const a of auditEls) if (classifyAudit(a)) classified++;
    add('dom', 'severity buckets resolvable', auditEls.length ? (classified ? 'OK' : 'FAIL') : 'WARN', classified + '/' + auditEls.length + ' classified');

    const nativeAnchor = root ? findNativeAnchor(root) : null;
    add('dom', 'injection anchor found', root ? (nativeAnchor ? 'OK' : 'WARN') : 'FAIL',
      root ? (nativeAnchor ? 'native Copy-link anchor' : 'toolbar fallback (no native anchor)') : 'no report');

    const btns = [...document.querySelectorAll('.' + P + '-report-btn')].filter((b) => b.isConnected && isVisible(b));
    add('dom', 'exactly one psicf button', btns.length === 1 ? 'OK' : (btns.length === 0 ? 'WARN' : 'FAIL'), 'count=' + btns.length + ' (inject state: ' + lastInjectState + ')');

    const rowBtns = root ? root.querySelectorAll('.' + CLS.ownRowBtn).length : 0;
    add('dom', 'per-audit icon count matches audits', auditEls.length ? (rowBtns === auditEls.length ? 'OK' : 'WARN') : 'WARN', rowBtns + '/' + auditEls.length + ' icons');

    /* --- Locale / URL --- */
    if (!slice.responded) {
      add('locale', 'bridge JSON readable', 'FAIL', 'bridge not responding');
      add('locale', 'bridge URL equals current slug', 'WARN', 'bridge unavailable, will fall back to browser locale');
      add('locale', 'bridge locale sane', 'WARN', 'bridge unavailable');
    } else {
      add('locale', 'bridge JSON readable for active strategy', slice.globalsReadable ? 'OK' : 'WARN', slice.globalsReadable ? '' : 'no __LIGHTHOUSE_*_JSON__ yet');
      const urlMatches = bridgeUrlMatchesSlug();
      add('locale', 'bridge URL equals current slug', urlMatches ? 'OK' : 'WARN', urlMatches ? bridgeUrlAttr() : 'stale/absent, falling back to browser locale (slug=' + currentSlug() + ')');
      const loc = bridgeLocaleAttr();
      add('locale', 'bridge locale sane vs report locale', loc ? (looksLikeLocale(loc) ? 'OK' : 'WARN') : 'WARN', loc || 'unstamped');
    }
    const strategy = getStrategy(root);
    add('locale', 'active strategy matches visible tab', strategy && strategy !== t('unknown') ? 'OK' : 'WARN', strategy);

    /* --- Clipboard output (dry-run serialize, invariant 14) --- */
    let dry = '', dryErr = null;
    try { dry = dryRunSerialize(); } catch (e) { dryErr = e && (e.message || e); }
    if (dryErr) {
      add('clipboard-output', 'dry-run serialize', 'FAIL', 'threw: ' + dryErr);
    } else {
      const nonEmpty = !!(dry && dry.trim());
      const hasHeader = dry.trimStart().startsWith(t('docTitle'));
      const clean = !containsHtml(dry);
      const okAll = nonEmpty && hasHeader && clean;
      add('clipboard-output', 'dry-run serialize', okAll ? 'OK' : 'FAIL',
        'len=' + dry.length + (nonEmpty ? '' : ' EMPTY') + (hasHeader ? '' : ' NO-HEADER') + (clean ? '' : ' HTML-DETECTED'));
    }
    const clipAvail = !!(navigator.clipboard && navigator.clipboard.writeText);
    let permState = 'unknown';
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const st = await navigator.permissions.query({ name: 'clipboard-write' });
        permState = st.state;
      }
    } catch (e) { permState = 'unsupported'; }
    const clipStatus = !clipAvail ? 'WARN' : (permState === 'denied' ? 'FAIL' : (permState === 'prompt' ? 'WARN' : 'OK'));
    add('clipboard-output', 'clipboard API + permission', clipStatus, (clipAvail ? 'writeText available' : 'execCommand fallback only') + ', permission=' + permState);

    /* --- Selector health (after the dry run exercised the parse path) --- */
    const criticalKeys = ['reportRoot', 'auditNode'];
    for (const key of Object.keys(SELECTORS)) {
      const h = selHealth[key];
      if (!h) { add('selectors', key, 'WARN', 'not exercised this run'); continue; }
      const crit = SELECTORS[key].crit || criticalKeys.indexOf(key) !== -1;
      if (h.status === 'ok') add('selectors', key, 'OK', 'primary tier ' + h.tier);
      else if (h.status === 'fallback') add('selectors', key, 'WARN', 'fell back to tier ' + h.tier + ' (index ' + h.index + ')');
      else add('selectors', key, crit ? 'FAIL' : 'WARN', 'miss');
    }

    /* --- Lifecycle --- */
    let bcOk = false;
    try { const bc = new BroadcastChannel(P); bc.close(); bcOk = true; } catch (e) { bcOk = false; }
    add('lifecycle', 'BroadcastChannel constructable', bcOk ? 'OK' : 'FAIL', '');
    add('lifecycle', 'observer attached', observer ? 'OK' : 'FAIL', '');
    let lsOk = false;
    try { localStorage.getItem(LANG_KEY); lsOk = true; } catch (e) { lsOk = false; }
    add('lifecycle', 'localStorage readable', lsOk ? 'OK' : 'WARN', lsOk ? '' : 'blocked (private mode)');

    /* --- Summary --- */
    const flat = Object.keys(groups).reduce((acc, g) => acc.concat(groups[g]), []);
    const summary = {
      ok: flat.filter((x) => x.status === 'OK').length,
      warn: flat.filter((x) => x.status === 'WARN').length,
      fail: flat.filter((x) => x.status === 'FAIL').length,
    };
    const result = {
      host: location.hostname,
      version: extVersion(),
      ok: summary.fail === 0,
      summary,
      groups,
    };
    prettyPrintDiag(result);
    return result;
  }

  function prettyPrintDiag(res) {
    try {
      const badge = { OK: 'color:#188038;font-weight:bold', WARN: 'color:#b06000;font-weight:bold', FAIL: 'color:#c5221f;font-weight:bold' };
      console.groupCollapsed(
        '%c[PSI Copy Feedback] diagnostics %c' + (res.ok ? 'OK' : 'ISSUES') +
        ' (OK ' + res.summary.ok + ' / WARN ' + res.summary.warn + ' / FAIL ' + res.summary.fail + ')',
        'color:#1a73e8;font-weight:bold', res.ok ? 'color:#188038;font-weight:bold' : 'color:#c5221f;font-weight:bold'
      );
      for (const g of Object.keys(res.groups)) {
        console.group(g);
        for (const item of res.groups[g]) {
          console.log('%c' + item.status + '%c ' + item.label + (item.detail ? ' - ' + item.detail : ''), badge[item.status] || '', 'color:inherit');
        }
        console.groupEnd();
      }
      console.groupEnd();
    } catch (e) { /* pretty-print is best-effort */ }
  }

  // Optional startup subset behind a localStorage debug flag (invariant 16).
  // Normal users see nothing; zero cost unless the flag is set.
  function maybeStartupDiag() {
    let dbg = false;
    try { dbg = !!localStorage.getItem(DEBUG_KEY); } catch (e) { /* ignore */ }
    if (!dbg) return;
    const started = Date.now();
    const tick = () => {
      if (!extContextValid()) return;
      if (!getVisibleRoot()) {
        if (Date.now() - started < 20000) setTimeout(tick, 1000);
        return;
      }
      runDiag().then((res) => {
        if (res.summary.fail > 0 || res.summary.warn > 0) {
          try { console.warn('[PSI Copy Feedback] startup diagnostics found issues; run __psicf_diag() for detail.'); } catch (e) { /* ignore */ }
        }
      });
    };
    setTimeout(tick, 1500);
  }

  /* ------------------------------------------------------------------ */
  /* Init                                                                */
  /* ------------------------------------------------------------------ */

  function init() {
    try {
      console.info('[PSI Copy Feedback] v' + extVersion() + ' active');
    } catch (e) { /* diagnostics only */ }

    window.addEventListener('message', onWindowMessage);

    scheduleEnsure();
    resumePending();

    // Cross-tab success/timeout signalling for the localized-rerun flow. Only
    // messages whose correlation id matches this tab's in-flight switch are
    // acted on; stale or foreign messages are ignored (invariant 10).
    try {
      const bc = new BroadcastChannel(P);
      bc.addEventListener('message', (e) => {
        const d = e && e.data;
        if (!d) return;
        if (d.type === 'copied') {
          if (switchState && d.cid && d.cid === switchState.cid) {
            clearSwitch();
            countToast(d.count);
          }
        } else if (d.type === 'switch-timeout') {
          if (switchState && d.cid && d.cid === switchState.cid) {
            clearSwitch();
            showToast(t('toastSwitchTimeout'), true);
          }
        }
      });
    } catch (e) { /* cross-tab toast is optional */ }

    startObserver();
    window.addEventListener('hashchange', scheduleEnsure);
    window.addEventListener('popstate', scheduleEnsure);

    // Read-only diagnostic entry point (Phase 3). Exposed on the isolated
    // world's window (callable from the content-script console context); the
    // MAIN-world bridge exposes a forwarder for the page console.
    try { window.__psicf_diag = function () { return runDiag(); }; } catch (e) { /* ignore */ }

    maybeStartupDiag();
  }

  init();
})();
