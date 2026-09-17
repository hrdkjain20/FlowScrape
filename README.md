# FlowScrape

FlowScrape is a Manifest V3 Chrome extension for capturing structured data from tables, cards, listings, feeds, directories, and other repeated page elements. Capture runs locally after explicit activation, and optional Groq-powered cleanup can remove noisy fields without changing the original data.

## Features

- Automatic detection of repeated records and their fields
- Point-and-select mode and custom fields for difficult layouts
- Live capture while you manually scroll dynamic or infinite pages
- Support for tables, responsive cards, open shadow roots, and same-origin frames
- Deduplication, virtual-list handling, and recovery after service-worker restarts
- Searchable preview with column editing and row selection
- CSV, JSON, JSONL, and clipboard export
- Optional AI cleanup with a dynamically generated schema

## Install from source

Requirements: Node.js 20+, npm 10+, and a current Chromium-based browser.

```bash
git clone https://github.com/hrdkjain20/FlowScrape.git
cd FlowScrape
npm ci
npm run build
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose the generated `dist` directory.
4. Open an HTTP(S) page and click the FlowScrape toolbar icon.
5. Select a detected collection or use **Point & select**.
6. Start capture, scroll the page manually, and export the results.

Opening FlowScrape from Chrome's generic side-panel picker does not grant page access. Activate it from the toolbar while the target tab is selected.

## Optional AI cleanup

1. Create a Groq API key at [console.groq.com/keys](https://console.groq.com/keys).
2. Open **Settings → AI cleanup · Groq**.
3. Paste the key and select **Save & test**.
4. Capture records, optionally describe the desired result, and choose **Clean with AI**.
5. Compare the **Original** and **AI cleaned** views before exporting.

FlowScrape sends field names, statistics, shortened sample values, and optional instructions to Groq—not the complete dataset. Original IndexedDB records are never overwritten. Keys are excluded from prompts, exports, cached plans, metadata, logs, and production bundles. Session-only key storage is the default; persistent storage is optional.

Never commit or distribute a shared API key. If a key is exposed, revoke it immediately in the Groq console.

## Development

```bash
npm ci
npm run dev
npm run verify
npm run test:e2e
```

`npm run verify` runs ESLint, TypeScript checks, 40 unit tests, and the production Manifest V3 build. Playwright covers extension activation, dynamic capture, SPA navigation, CSP pages, AI cleanup, and failure recovery.

## Privacy and permissions

Capture begins only after user activation. Data stays in extension-owned IndexedDB unless the user explicitly runs AI cleanup or exports it. FlowScrape includes no analytics, remote JavaScript, cookie access, or automatic scrolling.

Required permissions are limited to `activeTab`, `scripting`, `storage`, `sidePanel`, and `downloads`. The only optional host permission is `https://api.groq.com/*`.

## Limitations

Chrome blocks extensions from protected pages such as `chrome://` URLs and the Chrome Web Store. Cross-origin frames, closed shadow roots, canvas-only content, browser PDF viewers, CAPTCHAs, and anti-bot systems may not expose reusable DOM data. Point-and-select and custom fields are available when automatic detection is insufficient.

FlowScrape does not bypass authentication, paywalls, access controls, rate limits, CAPTCHAs, or site restrictions. Only collect data you are authorized to access and comply with applicable laws and site terms.

## Contributing

Run `npm run verify` and `npm run test:e2e` before opening a pull request. Do not commit generated output, browser profiles, captured datasets, or credentials.
