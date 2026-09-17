# FlowScrape

FlowScrape is a Manifest V3 Chrome extension that detects structured collections on the page you explicitly activate, extracts records locally, and keeps capturing newly rendered items while you scroll. Optional Groq-powered cleanup can dynamically remove noisy/duplicate fields after capture while preserving the original dataset. It uses strict TypeScript, React, Vite, IndexedDB, Vitest, and Playwright.

> **Project status:** FlowScrape 1.2.0 is source-available as a load-unpacked Chrome extension. The repository never contains a shared Groq credential. AI cleanup is optional and uses a key supplied by each user.

## Features

- Smart detection for tables, repeated rows, product/search cards, ads, feeds, directories, and semantic lists, using approximate template similarity rather than exact class matching.
- Multi-record consensus schemas that capture optional fields and classify labelled values, IDs, prices, dates, contacts, link text/roles, URLs, images, and video sources.
- Ordered fallback locators plus semantic pattern extraction for responsive and heterogeneous record variants.
- Optional dynamic AI schema planning: Groq may keep, drop, rename, split, merge, type, and select deduplication fields without a website-specific schema.
- Optional natural-language cleanup instructions, bounded quality correction, original/cleaned preview switching, and plan caching.
- Point-and-select collection discovery and page-element field picking through an isolated shadow-root overlay.
- Custom fields for text, number, price, date, URL, image, email, phone, attribute, and HTML values.
- Scoped `MutationObserver`, `IntersectionObserver`, and debounced scroll/resize capture after selection—no automatic scrolling.
- Fingerprint deduplication that also captures changed values from recycled virtual-list nodes.
- Bounded retries for asynchronously populated required fields.
- Open shadow-root and same-origin iframe selector traversal where browser security permits.
- IndexedDB record storage and `chrome.storage.local` recovery metadata, resilient to MV3 worker restarts.
- Virtualized table preview, search, row selection, column rename/reorder/hide/delete, pause/resume/stop/undo/clear, themes, and keyboard focus states.
- Full-dataset CSV, JSON, and JSON Lines export plus selected-row clipboard copy.
- UTF-8 CSV output, correct quoting, stable field order, and spreadsheet-formula neutralization.

## Architecture

```text
manifest.config.ts              MV3 manifest; minimal required permissions
src/background/service-worker  activation, typed routing, session coordination/recovery
src/content/bootstrap          isolated-world lifecycle and message endpoint
src/content/detector           bounded approximate-template clustering and scoring
src/content/schema             multi-record semantic schema and locator inference
src/content/extractor          normalization, URL resolution, record fingerprints
src/content/capture            scoped incremental observation and bounded batching
src/content/overlay            shadow-root point/field selection overlay
src/ai/cleanup                 bounded profiling, strict plan validation, local transformation and quality checks
src/ai/groq                    Groq structured-output client and safe provider errors
src/sidepanel                  React side-panel application and virtualized preview
src/db/repository              IndexedDB sessions and complete record datasets
src/export/exporters           CSV/JSON/JSONL serialization and downloads
src/shared                     data model, typed protocol, validation, utilities
src/privacy                    bundled privacy and threat-model page
fixtures                       local demo pages for supported and adverse patterns
tests                          Vitest unit and Playwright extension smoke tests
```

The side panel never talks directly to page JavaScript. It sends an explicit typed request to the service worker, which forwards a validated command to the isolated content script for the activated tab. Record batches return to the worker and are committed to IndexedDB before the UI is updated. The worker persists enough metadata to reconnect after suspension; no correctness depends on worker globals surviving.

Detection is deterministic and bounded: visible siblings are clustered using tag histograms, child sequences, text density, media/link counts, semantic markup, and approximate tree similarity. Structural profiles are cached and large collections are sampled to avoid quadratic page scans. Navigation, footer, cookie, and unrelated-control contexts are penalized. Schema inference samples multiple records, discovers a union of required and optional fields, and keeps several resilient locators for record variants. Field labels prefer table headers, explicit label/value pairs, ARIA, microdata, data labels, headings, meaningful classes, and recognized value types.

## Prerequisites

- Node.js 20 or later (verified with Node 24)
- npm 10 or later
- A current Chromium-based browser with Side Panel support

## Quick start from GitHub

```bash
git clone https://github.com/hrdkjain20/FlowScrape.git
cd FlowScrape
npm ci
npm run verify
```

Then load the generated `dist` directory from `chrome://extensions` as described below. `dist`, dependencies, coverage, browser profiles, test output, environment files, and credential files are deliberately excluded from version control; every public build should be generated from the committed source.

## Development and verification

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

`npm run verify` runs lint, type checking, unit tests, and the production build. The Playwright smoke test expects the production `dist` directory and a locally installed Playwright Chromium. Install that browser once with `npx playwright install chromium` if it is not already present.

## Load the unpacked extension

1. Run `npm install` and `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this repository's `dist` directory.
5. Open an HTTP(S) page you are authorized to collect.
6. Click the FlowScrape toolbar action (or press `Alt+Shift+F`). This explicit action grants temporary `activeTab` access, opens the persistent side panel, and begins analysis.
7. Select a detected collection or use **Point & select**, review the inferred columns, then choose **Start live capture**.
8. Scroll the webpage manually. Export or copy records from the side panel when ready.

### Configure optional AI cleanup

1. Create a Groq API key at `https://console.groq.com/keys`.
2. Open FlowScrape **Settings** → **AI cleanup · Groq**.
3. Paste the key into **Groq API key** and choose whether to keep it after the browser restarts. Session-only storage is the default.
4. Choose **Save & test**. Chrome requests access only to `https://api.groq.com/*`.
5. Capture records, optionally describe the desired dataset, then choose **Clean with AI**.
6. Review **Original** and **AI cleaned** views. Export buttons always state which view will be exported.

AI cleanup sends field names, field statistics, up to three shortened sample values per visible field, and optional user instructions to Groq. It does not send the full captured dataset in the prompt. Original IndexedDB records are never overwritten. Never bundle a shared production API key in an extension; for public distribution, use per-user keys or an authenticated backend gateway.

### API-key safety

- Paste the key only into **FlowScrape Settings → AI cleanup · Groq**. Do not add it to source files, `.env` files intended for commit, screenshots, issues, or exported datasets.
- Session-only storage is the default. Persistent storage is an explicit opt-in and can be cleared from the same settings screen.
- FlowScrape requests only the optional `https://api.groq.com/*` origin when AI cleanup is configured or used.
- Keys are excluded from AI prompts, cached cleanup plans, capture metadata, exports, application logs, and production bundles.
- If a key is accidentally published, revoke it immediately in the Groq console and create a replacement.

For demos, serve `fixtures` over HTTP—for example `npx vite fixtures --host 127.0.0.1`—and open the displayed local URL. Serving rather than opening `file://` avoids Chrome's separate “Allow access to file URLs” switch.

### Activation troubleshooting

Opening FlowScrape only from Chrome's generic side-panel picker does not grant `activeTab`. Activate it from the FlowScrape toolbar icon while the target webpage is selected. After rebuilding or reloading an unpacked extension, close any panel left open from the previous build, refresh the target webpage, and click the toolbar icon again. FlowScrape automatically replaces orphaned content-script contexts and reinjects after ordinary webpage reloads.

## Privacy and threat model

Extraction begins only after the user activates the extension. Captured data stays in extension-owned IndexedDB by default. FlowScrape has no analytics, remote JavaScript, cookie access, or page-localStorage writes. It does not read form-control values; extraction uses selected DOM text and explicitly selected public attributes. Optional Groq cleanup is a separate explicit action with an exact optional host permission and an in-product data disclosure.

The page is considered hostile input. Extension pages render extracted values through React escaping; raw HTML is stored/exported but never inserted into the side-panel DOM. Messages are type-checked, selectors are guarded, executable code is bundled, and the extension CSP disallows remote scripts and `eval`. CSV cells beginning with `=`, `+`, `-`, or `@` are neutralized. The bundled privacy page contains the complete risk/control table.

Required permissions are limited to `activeTab`, `scripting`, `storage`, `sidePanel`, and `downloads`. The only optional host permission is `https://api.groq.com/*`; it is requested from a user gesture when Groq is configured or used.

## Known platform limitations

- Chrome blocks content-script injection into browser-internal pages, the Chrome Web Store, and other protected surfaces.
- Cross-origin iframes cannot be read from the top page without separately authorized host access; FlowScrape reports the inaccessible frame count.
- Closed shadow roots expose no DOM to extensions. Canvas-only content exposes pixels rather than structured records. Browser PDF viewers are protected extension pages. These are reported instead of bypassed.
- Content that exists only after authentication is collected only when already visible to the user; FlowScrape never handles credentials or circumvents access controls.
- Very unusual table span layouts can produce fewer physical cells on later rows. Header labels account for `rowspan`/`colspan`; values are limited to cells actually exposed in each row's DOM.
- Client-side navigation can replace the selected container. Re-run Smart Detect after a route change if the application removes that container.
- A universal DOM scraper cannot guarantee every website: canvas pixels, closed shadow roots, protected/cross-origin frames, encrypted or signed API payloads, and server-side anti-automation challenges expose no authorized reusable DOM structure. For an unusual but accessible layout, Point & select and custom fields remain the deterministic fallback.
- Fingerprints are based on normalized field values and stable item attributes. Two genuinely distinct records with exactly the same selected values and stable attributes are treated as duplicates.
- The extension never scrolls automatically and never bypasses CAPTCHAs, paywalls, authentication, robots restrictions, rate limits, access controls, or anti-bot systems.

## Production verification checklist

- [x] Valid Manifest V3 production manifest; no required `<all_urls>` host permission
- [x] All executable code bundled locally; extension CSP forbids remote script/eval
- [x] Strict TypeScript and ESLint pass
- [x] Smart detect, point-select, custom field controls, and live incremental capture implemented
- [x] Deduplication, recycled-node changes, incomplete-field retry, and observer cleanup implemented
- [x] IndexedDB records and MV3 restart metadata recovery implemented
- [x] Full-dataset CSV/JSON/JSONL export and selected-row clipboard copy implemented
- [x] CSV injection, escaping, normalization, URL resolution, detection, shadow DOM, and 10,000-record tests implemented
- [x] Regular, infinite, virtualized, delayed, SPA, shadow, iframe, duplicate, malformed, large, CSV-injection, and strict-CSP fixtures included
- [x] Privacy page, sensitive-site warning, domain blocklist, accessibility focus states, and light/dark themes included
- [x] Production output generated in `dist`

## Contributing

Before opening a pull request, run:

```bash
npm ci
npm run verify
npm run test:e2e
```

Do not commit generated output or credentials. Keep extraction changes bounded and deterministic, preserve the original captured dataset, and include regression coverage for hostile page content and MV3 worker restarts. For a suspected security issue, avoid posting credentials or sensitive captured data in a public issue; share only a minimal redacted reproduction.

## Responsible use

Only collect data you are authorized to access and comply with the site's terms and applicable law. If a page presents a CAPTCHA, login requirement, access-denied notice, rate-limit warning, or collection restriction, stop. FlowScrape provides no mechanism to evade it.
