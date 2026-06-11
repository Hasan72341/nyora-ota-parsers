import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * GigaViewerParser — Theme for Hatena's GigaViewer manga platform
 * (e.g., Comic Y-OURs, Shonen Jump+, Tonari no Young Jump, etc.).
 *
 * Ported from Keiyoushi's GigaViewer multisrc.
 * These sites use HTML scraping for listing and searching, and a JSON API
 * for chapter listing and page image metadata.
 */
export class GigaViewerParser extends BaseParser {
    constructor(context, source, domain, pageSize = 30) {
        super(context, source, domain, pageSize);

        // Selectors can be overridden by source.overrides
        const ov = source.overrides || {};
        this.popularMangaSelector = ov.popularMangaSelector || "ul.series-list li a";
        this.latestUpdatesSelector = ov.latestUpdatesSelector || null; // Computed per request
        this.searchMangaSelector = ov.searchMangaSelector || "ul.search-series-list li, ul.series-list li";
        this.searchPathSegment = ov.searchPathSegment || "search";
        this.mangaDetailsInfoSelector = ov.mangaDetailsInfoSelector || "section.series-information div.series-header";
        
        this.timeZone = "Asia/Tokyo";
    }

    get dayOfWeek() {
        return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: this.timeZone }).format(new Date()).toLowerCase();
    }

    getHeaders() {
        return {
            'Origin': `https://${this.domain}`,
            'Referer': `https://${this.domain}/`,
        };
    }

    // ---- List / Search -------------------------------------------------

    async getListPage(page, order, filter) {
        filter = filter || {};
        const isSearch = !!filter.query;
        let url;

        if (isSearch) {
            url = `https://${this.domain}/${this.searchPathSegment}?q=${encodeURIComponent(filter.query)}`;
            if (page > 1) url += `&page=${page}`;
        } else {
            // GigaViewer popular/latest are typically sections on the /series page.
            // Pagination is usually not supported for these static lists.
            if (page > 1) return [];
            url = `https://${this.domain}/series`;
        }

        let html;
        try {
            html = await this.context.httpGet(url, this);
        } catch (e) {
            // Search returns 404 when no results are found.
            if (isSearch && String(e).includes("404")) return [];
            throw e;
        }

        const doc = this.context.parseHTML(html);
        let selector = this.popularMangaSelector;

        if (isSearch) {
            selector = this.searchMangaSelector;
        } else if (order === SortOrder.UPDATED) {
            selector = `h2.series-list-date-week.${this.dayOfWeek} + ul.series-list li a`;
        }

        const elements = Array.from(doc.querySelectorAll(selector));
        return elements.map(el => this.parseMangaFromElement(el, isSearch)).filter(Boolean);
    }

    parseMangaFromElement(element, isSearch) {
        let title, coverUrl, url;

        if (isSearch) {
            // Search result items (usually li)
            const titleEl = element.querySelector("div.title-box p.series-title") || element.querySelector("p[class^=SearchResultItem_series_title_]");
            const thumbEl = element.querySelector("div.thmb-container a img") || element.querySelector("img");
            const linkEl = element.querySelector("div.thmb-container a") || element.querySelector("a");

            title = titleEl?.textContent?.trim();
            coverUrl = thumbEl?.getAttribute("src") || thumbEl?.getAttribute("data-src");
            url = linkEl?.getAttribute("href");
        } else {
            // Series list items (usually a or li containing a)
            const linkEl = element.tagName === 'A' ? element : element.querySelector("a");
            if (!linkEl) return null;

            title = linkEl.getAttribute("data-series-name") || linkEl.querySelector("h2.series-list-title")?.textContent?.trim();
            const thumbEl = linkEl.querySelector("div.series-list-thumb img") || linkEl.querySelector("img");
            coverUrl = thumbEl?.getAttribute("data-src") || thumbEl?.getAttribute("src");
            url = linkEl.getAttribute("href");
        }

        if (!title || !url) return null;

        return new Manga({
            id: this.toRelativeUrl(url),
            url: this.toRelativeUrl(url),
            publicUrl: this.toAbsoluteUrl(url),
            coverUrl: this.toAbsoluteUrl(coverUrl || ""),
            title,
            source: this.source,
            contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
        });
    }

    // ---- Details -------------------------------------------------------

    async getDetails(manga) {
        const fullUrl = this.toAbsoluteUrl(manga.url);
        const html = await this.context.httpGet(fullUrl, this);
        const doc = this.context.parseHTML(html);

        const info = doc.querySelector(this.mangaDetailsInfoSelector);
        const title = info?.querySelector("h1.series-header-title")?.textContent?.trim() || manga.title;
        const author = info?.querySelector("h2.series-header-author")?.textContent?.trim();
        const description = info?.querySelector("p.series-header-description")?.textContent?.trim();
        const coverUrl = info?.querySelector("div.series-header-image-wrapper img")?.getAttribute("data-src") || 
                         info?.querySelector("div.series-header-image-wrapper img")?.getAttribute("src");

        // Chapter fetching requires an "aggregateId" found in the page.
        const aggregateId = doc.querySelector("script.js-valve")?.getAttribute("data-giga_series") ||
                           doc.querySelector(".js-readable-products-pagination")?.getAttribute("data-aggregate-id");

        if (!aggregateId) throw new Error("Could not find series aggregate ID");

        const chapters = [];
        // GigaViewer has "episodes" (standard chapters) and "volumes".
        await this.fetchChapters(chapters, aggregateId, "episode");
        await this.fetchChapters(chapters, aggregateId, "volume");

        // Chapters come in newest-first from the API or mixed order; 
        // We sort them and assign indices.
        chapters.sort((a, b) => a.number - b.number || a.uploadDate - b.uploadDate);
        chapters.forEach((c, i) => c.index = i);

        return new Manga({
            ...manga,
            title,
            authors: author ? [author] : [],
            description: description || "",
            coverUrl: this.toAbsoluteUrl(coverUrl || manga.coverUrl),
            chapters
        });
    }

    async fetchChapters(chapters, aggregateId, type) {
        let offset = 0;
        const isVolume = type === "volume";

        while (true) {
            const apiUrl = `https://${this.domain}/api/viewer/pagination_readable_products?type=${type}&aggregate_id=${aggregateId}&sort_order=desc&offset=${offset}`;
            const jsonText = await this.context.httpGet(apiUrl, this);
            const data = JSON.parse(jsonText);

            if (!Array.isArray(data) || data.length === 0) break;

            for (const item of data) {
                const volPrefix = isVolume ? "(Volume) " : "";
                let statusPrefix = "";
                const label = item.status?.label;
                
                // Labels: is_free, is_rentable, is_purchasable, unpublished, is_rentable_and_subscribable
                if (label === "unpublished") statusPrefix = "🔒 ";
                else if (["is_rentable", "is_purchasable", "is_rentable_and_subscribable"].includes(label)) {
                    statusPrefix = "💴 ";
                }

                const url = isVolume ? `/volume/${item.readable_product_id}` : `/episode/${item.readable_product_id}`;
                const title = statusPrefix + volPrefix + item.title;
                
                // Heuristic for chapter number extraction
                const numMatch = item.title.match(/(\d+(\.\d+)?)/);
                const number = numMatch ? parseFloat(numMatch[1]) : 0;

                chapters.push(new MangaChapter({
                    id: url,
                    url,
                    title,
                    number,
                    uploadDate: item.display_open_at ? new Date(item.display_open_at).getTime() : 0,
                    source: this.source,
                }));
            }

            offset += data.length;
            // Stop if we received fewer than expected items (usually 30 per page)
            if (data.length < 10) break;
        }
    }

    // ---- Pages ---------------------------------------------------------

    async getPages(chapter) {
        const fullUrl = this.toAbsoluteUrl(chapter.url);
        const html = await this.context.httpGet(fullUrl, this);
        const doc = this.context.parseHTML(html);

        const script = doc.querySelector("script#episode-json");
        if (!script) throw new Error("Could not find chapter data script");

        const data = JSON.parse(script.getAttribute("data-value") || "{}");
        const pageStructure = data.readableProduct?.pageStructure;

        if (!pageStructure || !Array.isArray(pageStructure.pages)) {
            throw new Error("This chapter is either unavailable or must be purchased.");
        }

        // "baku" indicates scrambled images that need unscrambling logic.
        // We append a #scramble fragment as a hint to the consumer/interceptor.
        const isScrambled = pageStructure.choJuGiga === "baku";

        return pageStructure.pages
            .filter(p => p.type === "main" && p.src)
            .map((p, i) => {
                let imageUrl = p.src;
                if (isScrambled) {
                    imageUrl += (imageUrl.includes("?") ? "&" : "?") + "_scramble=1#scramble";
                }
                return new MangaPage({
                    id: imageUrl,
                    url: this.toAbsoluteUrl(imageUrl),
                    source: this.source,
                });
            });
    }
}
