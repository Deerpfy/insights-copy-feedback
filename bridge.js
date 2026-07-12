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
 * the globals from a previous run linger. Therefore this script (a) re-syncs
 * continuously, (b) clears the attributes the moment the URL changes, and
 * (c) stamps ONLY when the global's target matches the /analysis/<slug> the
 * page currently shows, so a stale report can never leak into another
 * site's analysis. */
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

  function sync() {
    try {
      const lhr = window.__LIGHTHOUSE_MOBILE_JSON__ || window.__LIGHTHOUSE_DESKTOP_JSON__;
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

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      clear(); // Immediate: attributes must never outlive their analysis.
    }
    sync();
  }, 500);
  sync();
})();
