/* PSI Copy Feedback - MAIN-world bridge.
 *
 * Your console showed why detection failed: PSI hardcodes lang="en" in the
 * HTML shell regardless of the served UI language. The authoritative signal
 * is the Lighthouse result itself, which PSI exposes on the page window as
 * __LIGHTHOUSE_MOBILE_JSON__ / __LIGHTHOUSE_DESKTOP_JSON__ with
 * configSettings.locale = the locale the report was GENERATED in.
 *
 * Content scripts live in an isolated world and cannot read page globals,
 * so this tiny script runs in the MAIN world (Chrome 111+) and mirrors two
 * values onto <html> data attributes, which both worlds share. */
(() => {
  'use strict';

  function read() {
    try {
      const lhr = window.__LIGHTHOUSE_MOBILE_JSON__ || window.__LIGHTHOUSE_DESKTOP_JSON__;
      if (!lhr) return false;
      const loc = lhr.configSettings && lhr.configSettings.locale;
      if (loc) document.documentElement.setAttribute('data-psicf-lhr-locale', String(loc));
      const u = lhr.finalDisplayedUrl || lhr.finalUrl || lhr.requestedUrl;
      if (u) document.documentElement.setAttribute('data-psicf-lhr-url', String(u));
      return !!loc;
    } catch (e) {
      return false;
    }
  }

  if (read()) return;
  // The globals appear only once an analysis finishes; poll up to ~2 min.
  let n = 0;
  const iv = setInterval(() => {
    if (read() || ++n > 240) clearInterval(iv);
  }, 500);
})();
