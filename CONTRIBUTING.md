# Contributing to Nyora OTA Parsers

Thank you for your interest in contributing to Nyora's manga parsers! This repository manages all JavaScript-based scrapers that run across the iOS, Android, macOS, Linux, Windows, and Web clients.

Following these guidelines ensures that your contributions are clean, robust, and don't break downstream platforms.

---

## 1. Local Development Setup

To get started, clone the repository, navigate into the directory, and install the developer tools:

```bash
cd nyora-ota-parsers
npm install
```

---

## 2. Adding a New Manga Source

There are two ways to add a new source depending on whether the site uses an existing site engine (e.g., WordPress Madara) or a completely custom layout.

### Path A: The site uses a known family (e.g., Madara)
If the site belongs to a supported engine family (listed in `src/index.js`), you don't need to write new code!
1. Open **`src/sources.json`**.
2. Add a new entry to the array containing the metadata. For example:
   ```json
   {
     "id": "MY_NEW_SOURCE",
     "className": "MyNewSource",
     "title": "My New Source Manga",
     "lang": "en",
     "domain": "mynewsource.com",
     "family": "MadaraParser",
     "isNsfw": false
   }
   ```
3. Run a build: `npm run build`.

### Path B: The site uses a custom engine/layout
If the site is unique, you will need to write a custom scraper class:
1. Create a new file under `src/` (e.g., `src/customsite.js`).
2. Extend `BaseParser` and implement the mandatory lifecycle methods:
   ```javascript
   import { BaseParser, Manga, MangaChapter, MangaPage, SortOrder, ContentRating } from './base.js';

   export class CustomSiteParser extends BaseParser {
       constructor(context, source, domain, pageSize = 20) {
           super(context, source, domain, pageSize);
       }

       // Required: Lists popular/latest manga or searches by query
       async getListPage(page, order, filter) { ... }

       // Required: Extracts description, cover, and list of chapters (oldest-first)
       async getDetails(manga) { ... }

       // Required: Extracts image URLs for a specific chapter
       async getPages(chapter) { ... }
   }
   ```
3. Register your new class in **`src/index.js`**:
   * Import your parser class.
   * Add it to the `FAMILIES` lookup object.
4. Add the entry to **`src/sources.json`** specifying your new class name as the `"family"`.

---

## 3. Core Rules for Writing Parsers

To ensure your parser runs flawlessly on mobile, desktop, and web contexts:

* **Always use relative paths for URLs:** When returning a `Manga` or `MangaChapter` URL, use `this.toRelativeUrl(url)` (e.g. `/manga/title-slug`). The framework automatically stamps IDs and wraps endpoints locally.
* **Always use Absolute URLs for Media:** Cover images and pages should be converted to absolute links using `this.toAbsoluteUrl(mediaUrl)`.
* **CORS & HTTP Networking:** **Never** use the global browser `fetch()`. Always use `this.context.httpGet(url, this)` or `this.context.httpPost(url, body, headers, this)`.
* **DOM Querying:** **Never** use `document.querySelector`. Always use the documents parsed by the context:
  ```javascript
  const html = await this.context.httpGet(targetUrl, this);
  const doc = this.context.parseHTML(html);
  const title = doc.querySelector('.manga-title').textContent.trim();
  ```
* **Sniffing Attributes:** Many sites lazy-load images. Fall back gracefully when reading image sources:
  ```javascript
  const imgUrl = img.getAttribute("data-src") || img.getAttribute("src") || "";
  ```

---

## 4. Running Verification and Tests

We enforce strict validation to prevent shipping broken scrapers. Always verify your additions before opening a pull request.

### Smoke-test a single source:
Test a specific source from `sources.json` to verify listing page, details, and chapter page resolutions:
```bash
node smoke.mjs MANGANATO_GG
```

### Run full-suite tests:
Runs diagnostic checks across all registered sources (usually filters out Cloudflare-protected sites that fail headlessly):
```bash
npm test
```

---

## 5. Building & Shipping

Compile your changes into the platform-optimized bundles:
```bash
npm run build
```

This will run `esbuild` and update the `dist/` directory files (`parsers.bundle.js`, `sources.json`, `manifest.json`). When pushed, these files deploy directly to our OTA hosting CDN so Nyora apps receive the fixes instantly.
