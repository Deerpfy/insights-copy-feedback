/* PSI Copy Feedback - MAIN-world bridge.
 *
 * PSI hardcodes lang="en" in the HTML shell regardless of the served UI
 * language, so the authoritative locale signal is the Lighthouse result
 * itself: window.__LIGHTHOUSE_MOBILE_JSON__ / __LIGHTHOUSE_DESKTOP_JSON__
 * carry configSettings.locale (generation locale) and finalDisplayedUrl
 * (exact analyzed URL). Content scripts live in an isolated world and cannot
 * read page globals, so this MAIN-world script (Chrome 111+) mirrors both
 * onto <html> data attributes, which the worlds share.
 *
 * PSI is an SPA: navigating between analyses does not reload the page, and
 * the globals from a previous run linger. Freshness invariant (task item 9):
 * this script (a) re-syncs continuously, (b) clears the attributes the moment
 * the URL changes, (c) re-reads the Lighthouse global and validates the
 * global's URL against the /analysis/<slug> the page currently shows, stamping
 * ONLY on a match, and (d) emits a same-origin `nav` postMessage on every slug
 * change so the isolated content script can re-check injection even when PSI
 * navigates via history.pushState (which fires no hashchange/popstate).
 *
 * It also answers two read-only requests from the content script over
 * window.postMessage: a diagnostic "slice" (globals readable, bridge URL,
 * bridge locale, slug match) for world-boundary aggregation, and a forwarded
 * __psicf_diag() call so the diagnostic is reachable from the page console.
 * None of these paths stamp or mutate anything. */
(() => {
  'use strict';

  const A_LOC = 'data-psicf-lhr-locale';
  const A_URL = 'data-psicf-lhr-url';

  function slugPrefix(u) {
    try {
      const p = new URL(u);
      return (p.protocol.replace(':', '') + '-' + p.hostname)
        .replace(/[^a-z0-9]+/gi, '-')
        .toLowerCase();
    } catch (e) {
      return '';
    }
  }

  function currentSlug() {
    const m = location.pathname.match(/\/analysis\/([^/]+)/);
    return m ? m[1].toLowerCase() : '';
  }

  function clear() {
    document.documentElement.removeAttribute(A_LOC);
    document.documentElement.removeAttribute(A_URL);
  }

  // Read the active Lighthouse global (read-only). Returns null if unreadable.
  function readLhr() {
    try {
      return window.__LIGHTHOUSE_MOBILE_JSON__ || window.__LIGHTHOUSE_DESKTOP_JSON__ || null;
    } catch (e) {
      return null;
    }
  }

  function sync() {
    try {
      const lhr = readLhr();
      const url = lhr && (lhr.finalDisplayedUrl || lhr.finalUrl || lhr.requestedUrl);
      const loc = lhr && lhr.configSettings && lhr.configSettings.locale;
      const slug = currentSlug();
      const pref = url ? slugPrefix(url) : '';
      if (url && slug && pref && slug.indexOf(pref) === 0) {
        document.documentElement.setAttribute(A_URL, String(url));
        if (loc) document.documentElement.setAttribute(A_LOC, String(loc));
      } else {
        clear();
      }
    } catch (e) { /* never break the page */ }
  }

  // Read-only diagnostic slice for the content script (task item 15).
  function buildSlice() {
    let globalsReadable = false, url = '', locale = '', matches = false;
    const lhr = readLhr();
    if (lhr) {
      globalsReadable = true;
      try { url = String(lhr.finalDisplayedUrl || lhr.finalUrl || lhr.requestedUrl || ''); } catch (e) { url = ''; }
      try { locale = String((lhr.configSettings && lhr.configSettings.locale) || ''); } catch (e) { locale = ''; }
    }
    const slug = currentSlug();
    const pref = url ? slugPrefix(url) : '';
    matches = !!(url && slug && pref && slug.indexOf(pref) === 0);
    return {
      globalsReadable,
      url,
      locale,
      slug,
      matches,
      stampedUrl: document.documentElement.getAttribute(A_URL) || '',
      stampedLocale: document.documentElement.getAttribute(A_LOC) || '',
    };
  }

  // Cross-world request/reply + diag forwarding, all same-origin.
  let diagSeq = 0;
  const diagWaiters = new Map();

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || typeof d.__psicf !== 'string') return;

    if (d.__psicf === 'bridge-req' && d.nonce) {
      // Content script wants a fresh slice (read-only).
      try { window.postMessage({ __psicf: 'bridge-res', nonce: d.nonce, slice: buildSlice() }, location.origin); } catch (_) { /* ignore */ }
    } else if (d.__psicf === 'diag-res' && d.nonce && diagWaiters.has(d.nonce)) {
      // Reply to a forwarded __psicf_diag() call.
      const w = diagWaiters.get(d.nonce);
      diagWaiters.delete(d.nonce);
      w(d.result);
    }
  });

  // Expose __psicf_diag() on the PAGE window so it is callable from the default
  // DevTools console context; it forwards to the content script, which owns the
  // read-only diagnostic, and resolves with the structured result.
  try {
    window.__psicf_diag = function () {
      return new Promise((resolve) => {
        const nonce = 'd' + (++diagSeq) + '-' + Date.now().toString(36);
        let done = false;
        const finish = (val) => { if (done) return; done = true; clearTimeout(timer); diagWaiters.delete(nonce); resolve(val); };
        const timer = setTimeout(() => finish({ error: 'content script not responding' }), 4000);
        diagWaiters.set(nonce, (result) => finish(result));
        try { window.postMessage({ __psicf: 'diag-req', nonce }, location.origin); } catch (e) { finish({ error: 'postMessage failed' }); }
      });
    };
  } catch (e) { /* never break the page */ }

  let lastHref = location.href;
  let lastSlug = currentSlug();
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      clear(); // Immediate: attributes must never outlive their analysis.
    }
    const slug = currentSlug();
    if (slug !== lastSlug) {
      lastSlug = slug;
      // SPA navigation signal for the isolated content script (pushState fires
      // no hashchange/popstate, so the content observer alone can miss it).
      try { window.postMessage({ __psicf: 'nav', slug }, location.origin); } catch (e) { /* optional */ }
    }
    sync();
  }, 500);
  sync();
})();
