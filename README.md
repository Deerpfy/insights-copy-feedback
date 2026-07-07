# PSI Copy Feedback

Chromium (Manifest V3) extension for [PageSpeed Insights](https://pagespeed.web.dev/). It adds one-click copying of Lighthouse report findings in an AI-friendly plain-text/markdown format, so you can feed results to AI tools without expanding and copy-pasting audits by hand.

Works identically in Google Chrome and Brave. Vanilla JS/CSS, no build step, no dependencies, no background service worker.

## Features

### Report-level "Copy feedback" button

An outlined pill button styled to match PSI's native "Copy link" button. Clicking it opens a small popover where you pick which groups to include:

- Errors (failed audits, red triangle) and Warnings (needs-improvement audits, orange square) are preselected
- Goodies (passed and informative audits) is opt-in

Copy compiles the selected groups from the currently visible report (active Mobile/Desktop tab, visible categories) into one structured document and puts it on the clipboard.

### Output language selector

The popover has an "Output language" select: Browser default, English, Čeština. Default follows the browser language (`navigator.language`, cs -> Czech, anything else -> English); the choice persists in the site's localStorage. It switches all extension-generated strings: the injected UI (button labels, popover, toasts) and the scaffolding of the copied output (document title, header field labels, section headings, notes).

Selecting a language only stores the preference. The automation lives in the Copy button: if the selected language differs from the PSI page locale when you click Copy, the extension opens a new tab at `/analysis?url=<target>&hl=<lang>` (preserving `form_factor`) with your group selection encoded in the URL hash, waits there for the fresh report to finish rendering, copies automatically, notifies the original tab (success toast via BroadcastChannel), and closes the helper tab by itself. A stored analysis keeps the locale it was generated with, which is why a fresh run is required instead of a reload. If the popup is blocked, it falls back to the same flow in the current tab via sessionStorage. Locale mismatch detection reads the report's own generation locale (`configSettings.locale` inside `window.__LIGHTHOUSE_MOBILE_JSON__` / `__LIGHTHOUSE_DESKTOP_JSON__`, mirrored to a DOM attribute by a tiny MAIN-world bridge script, since content scripts cannot read page globals), then the `?hl=` parameter, then the browser language. PSI's `<html lang>` is ignored: it is hardcoded to `en` regardless of the served UI language. The bridge also supplies the exact analyzed URL (`finalDisplayedUrl`) for the rerun. The MAIN-world content script requires Chrome/Brave 111+. Pending intents are one-shot, expire after 10 minutes, and fire only with an exact target URL. Reruns take the usual analysis time and metrics can shift slightly between runs.

One thing is never translated: severity tags `[ERROR]` `[WARNING]` `[GOOD]` `[INFO]` are fixed machine-readable tokens.

### Per-audit copy buttons

Every audit row header gets a small copy icon. Clicking it copies that single audit's complete block, including its details table, even when the audit is collapsed. No expanding needed: the Lighthouse renderer builds the full DOM up front, and the extension reads it directly.

## Install (load unpacked)

### Chrome

1. Open `chrome://extensions`.
2. Enable "Developer mode" (toggle, top right).
3. Click "Load unpacked" and select the `psi-copy-feedback` folder (the one containing `manifest.json`).
4. Open https://pagespeed.web.dev/, run an analysis, and the buttons appear once the report renders.

### Brave

1. Open `brave://extensions`.
2. Enable "Developer mode" (toggle, top right).
3. Click "Load unpacked" and select the `psi-copy-feedback` folder.
4. Same behavior as Chrome; no configuration needed.

Icons (16/32/48/128 px, transparent PNG) are bundled in `icons/` and registered in the manifest.

## Copied output format

```
# PageSpeed Insights feedback

URL: https://example.com/
Captured: 2026-07-03T14:05:11+02:00 (time of copy)
Strategy: Mobile
Scores:
- performance: 72
- accessibility: 95
- best-practices: 100
- seo: 100

## Errors (failed audits)

### [ERROR] Eliminate render-blocking resources
Category: performance
Value: Potential savings of 300 ms
Description: Resources are blocking the first paint of your page. Learn more (https://developer.chrome.com/docs/...)

| URL | Transfer Size | Duration |
| --- | --- | --- |
| https://example.com/styles/main.css | 12.3 KiB | 150 ms |

## Warnings (needs improvement)
...
```

Per-audit copies emit the identical single-audit block (the `### [TAG] ...` part onward). Severity tags: `[ERROR]` failed, `[WARNING]` needs improvement, `[GOOD]` passed, `[INFO]` informative/manual. Output is sanitized to plain text: no HTML, no invisible characters, no emojis, no typographic dashes.

## How elements are located (and known limitations)

PSI's own markup uses minified, unstable class names and fully localized text, so the extension never anchors on either. Instead it uses:

- Stable Lighthouse renderer classes (`lh-audit`, `lh-audit--fail`, `lh-audit__title`, `lh-table`, ...) for all report parsing.
- Material icon-font ligatures (`link`, `content_copy`) to find the native "Copy link" button. Ligature tokens are locale-independent. If that anchor cannot be found, the button falls back to a right-aligned toolbar injected directly above the report.
- ARIA tab structure and the `form_factor` URL parameter for Mobile/Desktop detection (PSI lists Mobile first; positional, not textual). If neither is resolvable, Strategy is reported as `Unknown`.
- The `?url=` query parameter, or the first visible external link above the report, for the analyzed URL. If neither exists, `Unknown`.
- A visible `time[datetime]` element for the capture timestamp when PSI exposes one; otherwise the copy time is used and labeled `(time of copy)`.

Detail types with no sensible plain-text form (request chains, filmstrips, screenshots, source snippets) degrade to a `(details table omitted: ...)` note instead of failing the copy. Table copies include all rows, including rows PSI hides behind filters, since complete data is more useful to an AI consumer.

## Privacy and footprint

- Injects only on `https://pagespeed.web.dev/*`. On every other site: nothing is injected, nothing runs.
- Single permission: `clipboardWrite` (no host, tab, or storage access). Required so the automatic copy after a localized rerun can write the clipboard without a fresh user gesture.
- No background service worker, no telemetry, no network requests of any kind.
- Clipboard writes happen only on your click, via `navigator.clipboard.writeText` with an `execCommand` fallback and a manual-copy dialog if both fail.
- A single debounced MutationObserver keeps the buttons alive across PSI's re-renders and Mobile/Desktop switches; all report parsing runs only when you click a copy button.
