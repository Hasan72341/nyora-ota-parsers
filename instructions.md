# Nyora OTA Parser Instructions

Use this file as the source of truth when changing Nyora JavaScript parsers or parser OTA delivery.

## Repository Purpose

This repo builds the shared JavaScript parser bundle used by Nyora clients.

Primary source files live in `src/`.

Generated OTA files are written to `dist/`:

- `dist/manifest.json`
- `dist/parsers.bundle.js`
- `dist/sources.json`
- `dist/index.html`

`dist/` is intentionally ignored by git. GitHub Actions rebuilds it and deploys it to GitHub Pages.

Live OTA endpoint:

```text
https://hasan72341.github.io/nyora-ota-parsers/manifest.json
```

## Version Rules

Never depend on ignored `dist/manifest.json` for CI versioning.

The tracked `VERSION` file is the baseline version for bundled parser assets. GitHub Actions reads both:

- the live Pages manifest version
- the tracked `VERSION` file

Then deploys:

```text
max(live_manifest_version, VERSION) + 1
```

When the same generated bundle is manually copied into an app as bundled assets, update that app's bundled parser baseline to match `VERSION`. For Android this is:

```text
nyora-android/app/src/main/kotlin/com/nyora/hasan72341/js/NyoraJsOtaUpdater.kt
```

`BUNDLED_VERSION` must match the parser version bundled in app assets. This prevents stale OTA files from overriding newer bundled assets.

## Normal Parser Change Workflow

1. Edit parser code in `src/`.
2. If adding or changing source metadata, edit `src/sources.json`.
3. Run a focused smoke test when possible:

```bash
node smoke.mjs SOURCE_ID
```

4. Run the build/test:

```bash
npm test
```

5. Inspect `dist/manifest.json` only as generated output. Do not commit `dist/`.
6. Commit source changes and push to `main`; GitHub Actions deploys the OTA files.
7. Verify live manifest after deploy:

```bash
node -e "const r=await fetch('https://hasan72341.github.io/nyora-ota-parsers/manifest.json?ts='+Date.now()); console.log(await r.text())"
```

## Adding a New Source

If the site matches an existing family:

1. Add an entry to `src/sources.json`.
2. Use an existing `family` from `src/index.js`.
3. Keep URLs relative for manga/chapter URLs.
4. Keep images absolute.

If the site needs a new parser:

1. Add a new parser file in `src/`.
2. Extend `BaseParser`.
3. Implement:

```javascript
async getListPage(page, order, filter) {}
async getDetails(manga) {}
async getPages(chapter) {}
```

4. Register the parser family in `src/index.js`.
5. Add the source metadata in `src/sources.json`.

## Parser Coding Rules

- Do not use global `fetch()` in parser files.
- Use `this.context.httpGet(url, this)` or `this.context.httpPost(url, body, headers, this)`.
- Do not use global `document`.
- Parse HTML through `this.context.parseHTML(html)`.
- Return manga and chapter URLs with `this.toRelativeUrl(url)`.
- Return cover/page media URLs with `this.toAbsoluteUrl(url)`.
- Handle lazy image attributes such as `data-src`, `data-lazy-src`, `data-original`, and `src`.
- Preserve source IDs. Changing IDs breaks saved library/history references.
- Do not fake source stats, parser support, or verification status.

## Android OTA Notes

Android reads OTA data from the Pages manifest and stores downloaded parser files under app private storage.

Android expects:

- downloaded bundle saved as `parsers.bundle.js`
- downloaded source catalog saved as `parsers_sources.json`
- downloaded version saved as `version`

Android bundled assets live at:

```text
nyora-android/app/src/main/assets/parsers.bundle.js
nyora-android/app/src/main/assets/parsers_sources.json
```

The OTA updater must only activate downloaded files when:

- downloaded version is greater than `BUNDLED_VERSION`
- both downloaded parser files exist

About settings has a manual parser refresh option. Keep it wired to `NyoraJsOtaUpdater.updateOnce()`.

## Deploy Checks

After pushing parser changes:

```bash
gh run list --repo Hasan72341/nyora-ota-parsers --limit 5
gh run watch RUN_ID --repo Hasan72341/nyora-ota-parsers --exit-status
```

Then confirm the live manifest version and hashes:

```bash
curl -fsSL 'https://hasan72341.github.io/nyora-ota-parsers/manifest.json?ts='$(date +%s)
```

The live site must show the new version. If it still shows an old version, check the Pages deployment run before changing app code.
