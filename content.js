/* PSI Copy Feedback - content script (Manifest V3, vanilla JS, no dependencies)
 *
 * Runs ONLY on https://pagespeed.web.dev/* (see manifest.json matches).
 *
 * Design notes:
 * - No localized text matching anywhere. Element location relies on stable
 *   Lighthouse renderer classes (lh-*), ARIA roles, DOM structure, URL
 *   parameters, and Material icon-font ligatures ("link", "content_copy"),
 *   which are locale-independent tokens, not translated copy.
 * - Lazy by design: nothing heavy runs continuously. A debounced
 *   MutationObserver only re-checks whether injection is still in place;
 *   all report parsing happens on user click.
 * - Every injected node/class is prefixed "psicf-" to avoid any collision
 *   with PSI. Native event handlers are never touched.
 * - Clipboard writes happen only from user gestures (click handlers), via
 *   navigator.clipboard.writeText with a document.execCommand fallback and
 *   a manual-copy dialog as last resort.
 */
(() => {
  'use strict';

  const P = 'psicf';
  const AUDIT_MARK = 'data-psicf';

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
      if (el.classList && el.classList.contains(P + '-row-btn')) continue;

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
    const urlA = cell.querySelector('.lh-text__url a[href]');
    if (urlA) {
      try { if (urlA.href) return urlA.href; } catch (e) { /* fall through */ }
    }
    const snippet = cell.querySelector('.lh-node__snippet');
    if (snippet) return '`' + norm(snippet.textContent) + '`';
    const onlyLink = cell.querySelector('a[href]');
    if (onlyLink && norm(cell.textContent) === norm(onlyLink.textContent)) {
      try { if (onlyLink.href) return onlyLink.href; } catch (e) { /* fall through */ }
    }
    let txt = norm(inlineText(cell));
    if (txt.length > 300) txt = txt.slice(0, 297) + '...';
    return txt;
  }

  function tableToMarkdown(table) {
    let headers = table.tHead
      ? [...table.tHead.querySelectorAll('th, td')].map((c) => norm(inlineText(c)))
      : [];
    const bodyRows = [];
    for (const tbody of table.tBodies) {
      for (const tr of tbody.rows) {
        const cells = [...tr.cells].map(cellText);
        if (!cells.some((c) => c)) continue;
        if (tr.classList.contains('lh-sub-item-row') && cells.length) {
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
    },
  };

  const LANG_KEY = P + '-lang';
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
    if (c.contains('lh-audit--notapplicable')) return null;
    if (c.contains('lh-audit--fail') || c.contains('lh-audit--error')) return SEVERITIES.error;
    if (c.contains('lh-audit--average')) return SEVERITIES.warning;
    if (c.contains('lh-audit--pass')) return SEVERITIES.pass;
    if (c.contains('lh-audit--informative') || c.contains('lh-audit--manual')) return SEVERITIES.info;
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
      title = norm(inlineText(auditEl.querySelector('.lh-audit__title') || auditEl));
    } catch (e) { /* keep going */ }
    const head = ['### [' + sev.tag + '] ' + (title || t('untitled'))];
    try {
      const catEl = auditEl.closest('.lh-category');
      let catId = catEl ? catEl.id : '';
      if (!catId && catEl) {
        const wrap = catEl.closest('.lh-category-wrapper');
        if (wrap) catId = wrap.id;
      }
      if (catId) head.push(t('fCategory') + ': ' + catId);

      const disp = auditEl.querySelector('.lh-audit__display-text');
      const dispText = disp ? norm(inlineText(disp)) : '';
      if (dispText) head.push(t('fValue') + ': ' + dispText);

      const desc = auditEl.querySelector('.lh-audit__description');
      const descText = desc ? norm(inlineText(desc)) : '';
      if (descText) head.push(t('fDescription') + ': ' + descText);

      const blocks = [head.join('\n')];
      let parsedAny = false;

      auditEl.querySelectorAll('table.lh-table').forEach((tbl) => {
        try {
          const md = tableToMarkdown(tbl);
          if (md) { blocks.push(md); parsedAny = true; }
        } catch (e) { /* one bad table must not sink the audit */ }
      });

      auditEl.querySelectorAll('.lh-list, .lh-checklist').forEach((list) => {
        const items = [...list.children].map((c) => norm(inlineText(c))).filter(Boolean);
        if (items.length) {
          blocks.push(items.map((i) => '- ' + i).join('\n'));
          parsedAny = true;
        }
      });

      if (
        !parsedAny &&
        auditEl.querySelector('.lh-crc, .lh-crc-container, .lh-filmstrip, .lh-snippet, .lh-treemap, .lh-element-screenshot')
      ) {
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
    return (
      [...document.querySelectorAll('.lh-root')].find(isVisible) ||
      [...document.querySelectorAll('.lh-vars')].find(isVisible) ||
      null
    );
  }

  function getStrategy(root) {
    // 1) Explicit URL parameter, when PSI reflects the tab in the URL.
    try {
      const ff = new URL(location.href).searchParams.get('form_factor');
      if (ff) return ff.toLowerCase() === 'desktop' ? t('strategyDesktop') : t('strategyMobile');
    } catch (e) { /* ignore */ }

    // 2) ARIA: the selected tab whose controlled panel contains the visible
    //    report. PSI lists Mobile first, Desktop second (positional, not
    //    text-based, so it holds in every UI language).
    if (root) {
      for (const tab of document.querySelectorAll('[role="tab"][aria-selected="true"]')) {
        const panelId = tab.getAttribute('aria-controls');
        if (!panelId) continue;
        const panel = document.getElementById(panelId);
        if (!panel || !panel.contains(root)) continue;
        const tablist = tab.closest('[role="tablist"]');
        if (!tablist) continue;
        const tabs = [...tablist.querySelectorAll('[role="tab"]')];
        const i = tabs.indexOf(tab);
        if (tabs.length === 2 && i === 0) return t('strategyMobile');
        if (tabs.length === 2 && i === 1) return t('strategyDesktop');
      }
    }

    // 3) Any visible two-tab tablist (PSI's strategy switcher shape).
    for (const tl of document.querySelectorAll('[role="tablist"]')) {
      const tabs = [...tl.querySelectorAll('[role="tab"]')].filter(isVisible);
      if (tabs.length !== 2) continue;
      const i = tabs.findIndex((t2) => t2.getAttribute('aria-selected') === 'true');
      if (i === 0) return t('strategyMobile');
      if (i === 1) return t('strategyDesktop');
    }
    return t('unknown');
  }

  // Exact analyzed-URL sources only: the ?url= request param or the visible
  // header link. Returns '' when neither exists. Used by the locale rerun,
  // which must never act on the lossy path-slug reconstruction.
  // Defense in depth against SPA staleness: accept the bridged Lighthouse
  // URL only when its scheme+host slug prefixes the /analysis/<slug> the page
  // currently shows.
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

  function getAnalyzedUrlExact(root) {
    // Bridged from the Lighthouse JSON (finalDisplayedUrl): most exact.
    const bridged = document.documentElement.getAttribute('data-' + P + '-lhr-url') || '';
    if (/^https?:\/\//i.test(bridged) && bridgedMatchesPath(bridged)) return bridged;

    try {
      const q = new URL(location.href).searchParams.get('url');
      if (q) return q;
    } catch (e) { /* ignore */ }

    // First visible external link rendered BEFORE the report, which is PSI's
    // analyzed-URL link in the header. Google-owned hosts and doc links are
    // excluded; "Learn more" links all live inside the report root and are
    // filtered out by the document-order check.
    const EXCLUDE = /(^|\.)(pagespeed\.web\.dev|google\.com|googleapis\.com|gstatic\.com|web\.dev|chrome\.com|withgoogle\.com|googleblog\.com)$/i;
    for (const a of document.querySelectorAll('a[href^="http"]')) {
      if (!isVisible(a)) continue;
      if (root && !(a.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      let u;
      try { u = new URL(a.href); } catch (e) { continue; }
      if (EXCLUDE.test(u.hostname)) continue;
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
    const timeEl = [...document.querySelectorAll('time[datetime]')].find(isVisible);
    if (timeEl && timeEl.getAttribute('datetime')) return timeEl.getAttribute('datetime');
    return localIsoNow() + t('timeOfCopy');
  }

  function getScores(scope) {
    const map = new Map();
    scope
      .querySelectorAll('a.lh-gauge__wrapper[href^="#"], a.lh-fraction__wrapper[href^="#"]')
      .forEach((a) => {
        const id = (a.getAttribute('href') || '').slice(1);
        const val = a.querySelector('.lh-gauge__percentage, .lh-fraction__content');
        if (!id || !val) return;
        let v = norm(val.textContent);
        if (!/\d/.test(v)) v = 'n/a';
        if (!map.has(id)) map.set(id, v);
      });
    if (!map.size) {
      scope.querySelectorAll('.lh-category').forEach((cat) => {
        const val = cat.querySelector('.lh-gauge__percentage, .lh-fraction__content');
        if (!cat.id || !val) return;
        let v = norm(val.textContent);
        if (!/\d/.test(v)) v = 'n/a';
        if (!map.has(cat.id)) map.set(cat.id, v);
      });
    }
    return map;
  }

  /* ------------------------------------------------------------------ */
  /* Report compilation                                                  */
  /* ------------------------------------------------------------------ */

  function compileReport(groups) {
    const root = getVisibleRoot();
    const scope = root || document;

    const cats = [...scope.querySelectorAll('.lh-category')];
    const visibleCats = new Set(cats.filter(isVisible));

    const buckets = { errors: [], warnings: [], goodies: [] };
    let count = 0;
    scope.querySelectorAll('.lh-audit').forEach((el) => {
      const sev = classifyAudit(el);
      if (!sev || !groups[sev.group]) return;
      // Honor "visible categories": audits inside collapsed clumps still
      // count (their category is visible); audits in a hidden category do not.
      const cat = el.closest('.lh-category');
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
      const audit = btn.closest('.lh-audit');
      if (!audit) return;
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
  // globals), 2) explicit ?hl= param, 3) assume PSI followed Accept-Language.
  // <html lang> is deliberately NOT consulted: PSI hardcodes lang="en" in the
  // shell regardless of the served UI language.
  function pageLocaleMatches(want) {
    const lhr = (document.documentElement.getAttribute('data-' + P + '-lhr-locale') || '').toLowerCase();
    if (lhr) return lhr.startsWith(want);
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

  // Pending copy intent, stored per-tab so it survives the same-tab
  // navigation of a localized rerun. One-shot: takePending removes the key.
  const PENDING_KEY = P + '-pending';

  function savePending(groups, want, target, ff) {
    try {
      sessionStorage.setItem(
        PENDING_KEY,
        JSON.stringify({ v: 1, groups, want, target, ff, ts: Date.now() })
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
    copyBtn.addEventListener('click', async () => {
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
            const u = new URL(location.href);
            const ff = u.searchParams.get('form_factor') || '';
            const rerun = new URL('/analysis', u.origin);
            rerun.searchParams.set('url', target);
            if (ff) rerun.searchParams.set('form_factor', ff);
            rerun.searchParams.set('hl', want);
            const payload = { v: 1, groups: { ...selection }, want, ts: Date.now() };
            rerun.hash = P + '=' + encodeURIComponent(JSON.stringify(payload));
            closePopover();
            const w = window.open(rerun.href, '_blank');
            if (w) {
              showToast(t('toastRerunTab'));
              return;
            }
            savePending({ ...selection }, want, target, ff);
            showToast(t('toastRerun'));
            rerun.hash = '';
            location.assign(rerun.href);
            return;
          }
        }
      } catch (e) { /* fall through to a normal same-page copy */ }

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
      if (count === 0) showToast(t('toastNone'));
      else if (count === 1) showToast(t('toastOne'));
      else showToast(t('toastMany').replace('{n}', String(count)));
    });

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
  /* Injection lifecycle                                                 */
  /* ------------------------------------------------------------------ */

  // The native "Copy link" control cannot be found via localized text or
  // PSI's minified class names. Material icon fonts, however, render
  // locale-independent ligature tokens ("link", "content_copy") as the icon
  // element's text, which is a stable structural anchor.
  function findNativeAnchor(root) {
    const icons = document.querySelectorAll(
      'i[class*="material-icon" i], span[class*="material-icon" i], ' +
      '.google-material-icons, .material-symbols-outlined'
    );
    for (const icon of icons) {
      const lig = norm(icon.textContent);
      if (lig !== 'link' && lig !== 'content_copy' && lig !== 'share' && lig !== 'ios_share') continue;
      const btn = icon.closest('button, [role="button"], a');
      if (!btn || !isVisible(btn)) continue;
      if (btn.classList.contains(P + '-report-btn')) continue;
      // Only anchors above the report (the header toolbar), never links
      // inside audit content.
      if (root && !(btn.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      return btn;
    }
    return null;
  }

  function ensureReportButton() {
    const existing = [...document.querySelectorAll('.' + P + '-report-btn')];
    let keep = existing.find((b) => b.isConnected && isVisible(b)) || null;
    for (const b of existing) if (b !== keep) b.remove();
    document.querySelectorAll('.' + P + '-toolbar:empty').forEach((tb) => tb.remove());
    if (keep) return;

    const root = getVisibleRoot();
    if (!root) return; // No rendered report on screen yet.

    const btn = buildReportButton();

    const native = findNativeAnchor(root);
    if (native) {
      btn.classList.add(P + '-report-btn--inline');
      native.insertAdjacentElement('afterend', btn);
      if (isVisible(btn)) return;
      // Anchor context turned out to be non-rendering; fall back cleanly.
      btn.remove();
      btn.classList.remove(P + '-report-btn--inline');
    }

    const bar = document.createElement('div');
    bar.className = P + '-toolbar';
    root.parentNode.insertBefore(bar, root);
    bar.appendChild(btn);
  }

  function ensureRowButtons() {
    const audits = document.querySelectorAll('.lh-audit:not([' + AUDIT_MARK + '])');
    for (const audit of audits) {
      audit.setAttribute(AUDIT_MARK, '1');
      const header =
        audit.querySelector('.lh-audit__header') ||
        audit.querySelector('summary') ||
        audit;
      const chevron = header.querySelector('.lh-chevron-container');
      const btn = buildRowButton();
      if (chevron) header.insertBefore(btn, chevron);
      else header.appendChild(btn);
    }
  }

  let ensureTimer = 0;
  function scheduleEnsure() {
    if (ensureTimer) return;
    ensureTimer = setTimeout(() => {
      ensureTimer = 0;
      try {
        ensureReportButton();
        ensureRowButtons();
      } catch (e) {
        // Never let injection errors leak into the host page.
      }
    }, 250);
  }

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
  // compiles with the saved group selection and copies. The async clipboard
  // API needs a focused document, so an unfocused tab waits for focus (the
  // execCommand fallback inside copyText usually succeeds even unfocused
  // thanks to the clipboardWrite permission).
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

    const iv = setInterval(() => {
      if (Date.now() - started > 180000) {
        clearInterval(iv);
        showToast(t('toastWaitFail'), true);
        return;
      }
      const root = getVisibleRoot();
      if (!root) return;
      const count = root.querySelectorAll('.lh-audit').length;
      const hasScore = !!root.querySelector('.lh-gauge__percentage, .lh-fraction__content');
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
      if (stable < 6) return; // ~3 s of unchanged audit count = render settled.
      clearInterval(iv);

      let compiled;
      try {
        compiled = compileReport(p.groups);
      } catch (e) {
        showToast(t('toastFail'), true);
        return;
      }
      const finish = async () => {
        const ok = await copyText(compiled.text);
        if (!ok) {
          failCopy(compiled.text);
          return;
        }
        if (compiled.count === 0) showToast(t('toastNone'));
        else if (compiled.count === 1) showToast(t('toastOne'));
        else showToast(t('toastMany').replace('{n}', String(compiled.count)));
        try {
          new BroadcastChannel(P).postMessage({ type: 'copied', count: compiled.count });
        } catch (e) { /* cross-tab toast is optional */ }
        // Script-opened window: allowed to close itself. Small delay lets the
        // clipboard write settle before teardown.
        if (p.fromTab) setTimeout(() => window.close(), 400);
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

  function init() {
    try {
      console.info('[PSI Copy Feedback] v' + chrome.runtime.getManifest().version + ' active');
    } catch (e) { /* diagnostics only */ }
    scheduleEnsure();
    resumePending();
    // Success toast in THIS tab when the helper tab finishes its copy.
    try {
      const bc = new BroadcastChannel(P);
      bc.addEventListener('message', (e) => {
        const d = e && e.data;
        if (!d || d.type !== 'copied') return;
        if (d.count === 0) showToast(t('toastNone'));
        else if (d.count === 1) showToast(t('toastOne'));
        else showToast(t('toastMany').replace('{n}', String(d.count)));
      });
    } catch (e) { /* cross-tab toast is optional */ }
    // Narrow purpose: detect report (re)renders and tab visibility flips.
    // The callback only schedules a debounced, idempotent, cheap check.
    const mo = new MutationObserver(scheduleEnsure);
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'aria-selected', 'style', 'class'],
    });
    window.addEventListener('hashchange', scheduleEnsure);
    window.addEventListener('popstate', scheduleEnsure);
  }

  init();
})();
