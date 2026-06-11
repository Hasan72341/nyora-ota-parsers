import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * MangaCatalogParser — Franchise-specific sources (Read Kingdom, etc.)
 *
 * Ported from Nyora MangaCatalog.kt multisrc.
 * These sites usually host a specific franchise or a small set of related manga.
 * Instead of a dynamic "popular" list, they often provide a hardcoded list of
 * available manga in the source itself.
 */
export class MangaCatalogParser extends BaseParser {
    constructor(context, source, domain, pageSize) {
        super(context, source, domain, pageSize);

        // sourceList is provided via source.overrides as an array of [name, url] or {name, url}.
        // If missing, we default to the main domain as a single entry.
        this.sourceList = this.source.overrides?.sourceList || [
            { name: this.source.title, url: '/' }
        ];
    }

    get headers() {
        return {
            'Referer': `https://${this.domain}/`,
        };
    }

    // ---- List ----------------------------------------------------------

    async getListPage(page, order, filter) {
        // These sources don't usually have pagination for their "popular" list
        // as they are single-franchise or small-catalog sites.
        if (page > 1) return [];

        let list = this.sourceList.map(item => {
            const name = Array.isArray(item) ? item[0] : (item.name || this.source.title);
            const url = Array.isArray(item) ? item[1] : (item.url || '/');
            return { name, url: this.toRelativeUrl(url) };
        });

        if (filter?.query) {
            const q = filter.query.toLowerCase();
            list = list.filter(it => it.name.toLowerCase().includes(q));
        }

        return list.map(it => new Manga({
            id: it.url,
            url: it.url,
            publicUrl: this.toAbsoluteUrl(it.url),
            title: it.name,
            coverUrl: "", // List doesn't provide covers; getDetails will fill it
            source: this.source,
            contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
        }));
    }

    // ---- Details / Chapters --------------------------------------------

    async getDetails(manga) {
        const fullUrl = this.toAbsoluteUrl(manga.url);
        const html = await this.context.httpGet(fullUrl, this);
        const doc = this.context.parseHTML(html);

        const title = doc.querySelector("div.container > h1")?.textContent?.trim() || manga.title;
        const coverUrl = doc.querySelector("div.flex > img")?.getAttribute("src") || "";
        
        const infoEl = doc.querySelector("div.bg-bg-secondary > div.px-6 > div.flex-col");
        const infoText = infoEl?.textContent?.trim() || "";

        let description = infoText;
        if (infoText.includes("Description")) {
            // Equivalent to Kotlin's substringAfter
            description = infoText.split("Description").slice(1).join("Description").trim();
        }

        // Chapters: selector from Kotlin is "div.w-full > div.bg-bg-secondary > div.grid"
        const chapterElements = Array.from(doc.querySelectorAll("div.w-full > div.bg-bg-secondary > div.grid"));
        
        // These sites usually list newest-first in the DOM. 
        // We reverse to provide oldest-first for Nyora indices.
        const reversed = chapterElements.slice().reverse();
        const chapters = reversed.map((el, i) => {
            const link = el.querySelector(".col-span-4 > a");
            if (!link) return null;

            const url = this.toRelativeUrl(link.getAttribute("href") || "");
            const name1 = link.textContent?.trim() || "";
            const name2 = el.querySelector(".text-xs:not(a)")?.textContent?.trim() || "";
            
            const chapterTitle = name2 ? `${name1} - ${name2}` : name1;
            
            // Extract chapter number from text (e.g. "Chapter 123")
            const numMatch = name1.match(/Chapter\s*(\d+(\.\d+)?)/i);
            const number = numMatch ? parseFloat(numMatch[1]) : (i + 1);

            return new MangaChapter({
                id: url,
                url,
                title: chapterTitle,
                number,
                volume: 0,
                branch: null,
                scanlator: null,
                uploadDate: 0, // Not typically provided in the grid
                source: this.source,
                index: i,
            });
        }).filter(Boolean);

        return new Manga({
            ...manga,
            title,
            coverUrl: this.toAbsoluteUrl(coverUrl),
            largeCoverUrl: this.toAbsoluteUrl(coverUrl),
            description,
            state: MangaState.ONGOING, // Default as multisrc doesn't parse it
            chapters,
        });
    }

    // ---- Pages ---------------------------------------------------------

    async getPages(chapter) {
        const fullUrl = this.toAbsoluteUrl(chapter.url);
        const html = await this.context.httpGet(fullUrl, this);
        const doc = this.context.parseHTML(html);

        // Selector from Kotlin: img[data-src]
        const images = Array.from(doc.querySelectorAll("img[data-src]"));
        
        return images.map((img) => {
            const url = img.getAttribute("data-src") || img.getAttribute("src");
            const absUrl = this.toAbsoluteUrl(url);
            return new MangaPage({
                id: absUrl,
                url: absUrl,
                source: this.source,
            });
        });
    }
}
