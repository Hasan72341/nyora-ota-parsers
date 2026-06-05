# Nyora Web Parsers

This folder contains the fully verified, standalone JavaScript parsers for the **Nyora Web** client, along with a Cloudflare Worker that handles Cross-Origin Resource Sharing (CORS) bypassing and image proxying.

These parsers are completely uncoupled from the JVM/Kotlin stack and run entirely in JavaScript environments (Browsers, Node.js, Cloudflare Workers, React Native, etc.).

## 1. Deploy the Proxy

Since web browsers enforce CORS, client-side applications cannot fetch HTML directly from manga websites. We solve this by routing requests through a custom Cloudflare Worker proxy.

1.  Edit `.env` and provide your Cloudflare credentials:
    ```env
    CLOUDFLARE_API_TOKEN="your_api_token"
    CLOUDFLARE_ACCOUNT_ID="your_account_id"
    ```
2.  Install dependencies and deploy to Cloudflare's Edge Network:
    ```bash
    npm install
    export $(cat .env | xargs) # or use cross-env
    npm run deploy
    ```
3.  Note the deployed URL (e.g., `https://nyora-cors-proxy.your-username.workers.dev`).

## 2. Using the Parsers in Your Web App

Copy the following files into your web frontend's utilities or networking folder:
- `base.js`
- `madara.js`
- `mangareader.js`
- `index.js`
- `sources.json`

### Creating the Environment Context

The parsers require a `context` object that implements fetching and DOM parsing. You provide the implementation using your deployed proxy URL:

```javascript
import { getParser, getAllSources } from './index.js';
import { SortOrder } from './base.js';

const PROXY_URL = "https://nyora-cors-proxy.your-username.workers.dev";

const webContext = {
    async httpGet(url) {
        const res = await fetch(`${PROXY_URL}/proxy?url=${encodeURIComponent(url)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    },
    
    async httpPost(url, body, headers = {}) {
        const res = await fetch(`${PROXY_URL}/proxy?url=${encodeURIComponent(url)}`, {
            method: 'POST',
            headers: headers,
            body: body
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    },
    
    parseHTML(html) {
        // In the browser, you can use the native DOMParser
        const parser = new DOMParser();
        return parser.parseFromString(html, "text/html");
    }
};

// Example Usage:
async function loadLatestManga(sourceId) {
    // 1. Get the initialized parser for the selected source
    const parser = getParser(sourceId, webContext);
    
    // 2. Fetch the latest page (Page 1)
    const filter = {}; // Optional tags, queries, etc.
    const mangaList = await parser.getListPage(1, SortOrder.UPDATED, filter);
    
    console.log(mangaList);
    /* Returns Array of Manga Objects:
       [{
           id: "...",
           title: "Solo Leveling",
           coverUrl: "...",
           contentRating: "SAFE" // or "ADULT"
       }, ...]
    */
}
```

### Loading Images 

Because many manga CDNs employ hotlink protection, you must route image `src` URLs through the proxy as well. The proxy automatically strips browser CORS limits and spoofs the `Referer` headers required by the source domains.

In your UI components (React/Vue/Angular), do not bind directly to the `page.url` or `manga.coverUrl`. Instead:

```javascript
function getSafeImageUrl(originalUrl) {
    return `${PROXY_URL}/image?u=${encodeURIComponent(originalUrl)}`;
}

// React Example:
// <img src={getSafeImageUrl(manga.coverUrl)} alt={manga.title} />
```

## Supported Source Families

**28 families / 261 sources.** All run in pure JS (fetch + DOMParser); see `porting_status.csv`
for per-family live-verification status and a sample `list/chapters/pages` chain.

Verified FULL (live list → chapters → pages):
- **MadaraParser** (WordPress Madara) · **MangaReaderParser** (WPMangaStream/MangaThemesia)
- **ZeistMangaParser** (Blogger) · **OneMangaParser** (Elementor single-series) · **HotComicsParser** (TooMics/HotComics)
- **WpComicsParser** · **PizzaReaderParser** · **KeyoappParser** · **FoolSlideParser** · **LilianaParser**
- **MadthemeParser** · **IkenParser** · **MmrcmsParser** · **FmreaderParser** · **GuyaParser**
- **MangaWorldParser** · **MangAdventureParser** · **InitMangaParser** · **FuzzyDoodleParser**
- **UzayMangaParser** · **ZMangaParser** · **LikeMangaParser**

List+details verified, page images blocked at origin (work via the proxy with browser headers):
- **ComicasoParser** · **MangoThemeParser**

Ported (logic mirrors Kotlin) but candidate origins were dead/parked/Cloudflare-walled at port time,
so unverified from a datacenter IP — revisit via the proxy:
- **ScanParser** · **CupFoxParser** · **AnimeBootstrapParser** · **SinmhParser**

> The deployed proxy must be the latest `worker.js` (it strips the stale `Content-Encoding`
> header CF leaves on decompressed bodies). Redeploy with `npm run deploy` if sources return
> garbled HTML in the browser.
