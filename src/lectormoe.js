import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * LectorMoeParser — Multi-source family for sites like Rakuen Translations.
 *
 * Ported from Keiyoushi's LectorMoe.kt. This parser interacts with a central
 * API at capibaratraductor.com while maintaining site-specific organization
 * headers and referers.
 */
export class LectorMoeParser extends BaseParser {
    constructor(context, source, domain, pageSize = 36) {
        super(context, source, domain, pageSize);

        this.apiBaseUrl = this.source.overrides?.apiBaseUrl || "https://capibaratraductor.com";
        // organizationDomain defaults to the last segment of the domain/path.
        this.organizationDomain = this.source.overrides?.organizationDomain || this.domain.split('/').pop();
    }

    headers() {
        return {
            'Referer': `https://${this.domain}/`,
            'x-organization': this.organizationDomain,
        };
    }

    async getJson(url) {
        // The x-organization header selects the tenant on the shared backend —
        // without it the API returns the wrong site's catalog. Passed as the 3rd
        // httpGet arg (the production context honors it; see fmreader.js).
        const text = await this.context.httpGet(url, this, this.headers());
        return JSON.parse(text);
    }

    mapState(status) {
        switch (String(status || "").toLowerCase()) {
            case "ongoing":
                return MangaState.ONGOING;
            case "finished":
                return MangaState.FINISHED;
            case "hiatus":
                return MangaState.PAUSED;
            default:
                return undefined;
        }
    }

    // ---- List ----------------------------------------------------------

    async getListPage(page, order, filter) {
        filter = filter || {};
        const url = new URL(`${this.apiBaseUrl}/api/manga-custom`);
        url.searchParams.set("page", String(page));
        url.searchParams.set("limit", String(this.pageSize));

        let orderPart = "popular";
        if (order === SortOrder.UPDATED) {
            orderPart = "latest";
        } else if (order === SortOrder.POPULARITY) {
            orderPart = "popular";
        }
        url.searchParams.set("order", orderPart);

        if (filter.query) {
            url.searchParams.set("title", filter.query);
        }

        const json = await this.getJson(url.toString());
        const items = (json && json.data && Array.isArray(json.data.items)) ? json.data.items : [];
        
        return items.map(it => {
            const slug = it.manga ? it.manga.slug : "";
            const mangaUrl = `/manga/${slug}`;
            return new Manga({
                id: slug,
                url: slug, // Internal identifier for details lookup
                publicUrl: this.toAbsoluteUrl(mangaUrl),
                coverUrl: it.imageUrl ? this.toAbsoluteUrl(it.imageUrl) : "",
                title: it.title || "",
                altTitles: [],
                description: it.description || "",
                rating: 0,
                tags: [],
                authors: Array.isArray(it.authors) ? it.authors.map(a => a.name) : [],
                state: this.mapState(it.status),
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            });
        });
    }

    // ---- Details / Chapters --------------------------------------------

    async getDetails(manga) {
        const url = `${this.apiBaseUrl}/api/manga-custom/${manga.url}`;
        const json = await this.getJson(url);
        const data = json && json.data;
        if (!data) throw new Error("Manga details not found");

        const seriesSlug = data.manga ? data.manga.slug : manga.url;
        const now = Date.now();
        const rawChapters = Array.isArray(data.chapters) ? data.chapters : [];
        
        // Filter out unreleased and future-dated chapters, then map.
        const chapters = rawChapters
            .filter(it => !it.isUnreleased)
            .map(it => {
                const uploadDate = it.releasedAt ? new Date(it.releasedAt).getTime() : 0;
                return { ...it, uploadDate };
            })
            .filter(it => it.uploadDate < now)
            .map((it, i) => {
                const chapterUrl = `${seriesSlug}/${it.number}`;
                const number = parseFloat(it.number) || 0;
                const displayNum = String(it.number).replace(/\.0$/, "");
                return new MangaChapter({
                    id: chapterUrl,
                    url: chapterUrl,
                    title: `Capítulo ${displayNum} - ${it.title || ""}`,
                    number: number,
                    volume: 0,
                    branch: null,
                    scanlator: null,
                    uploadDate: it.uploadDate,
                    source: this.source,
                    index: i,
                });
            });

        // Kotlin uses chapters descending, but Nyora expects oldest-first.
        // Usually the API returns newest-first, so we reverse it.
        chapters.reverse();
        chapters.forEach((c, i) => c.index = i);

        return new Manga({
            ...manga,
            title: data.title || manga.title,
            coverUrl: data.imageUrl ? this.toAbsoluteUrl(data.imageUrl) : manga.coverUrl,
            description: data.description || manga.description,
            authors: Array.isArray(data.authors) ? data.authors.map(a => a.name) : manga.authors,
            state: this.mapState(data.status) || manga.state,
            chapters: chapters,
        });
    }

    // ---- Pages ---------------------------------------------------------

    async getPages(chapter) {
        const urlParts = chapter.url.split("/");
        if (urlParts.length < 2) throw new Error("Invalid chapter URL");
        
        const seriesSlug = urlParts[0];
        const chapterSlug = urlParts[1];
        
        const url = `${this.apiBaseUrl}/api/manga-custom/${seriesSlug}/chapter/${chapterSlug}/pages`;
        const json = await this.getJson(url);
        const pages = (json && Array.isArray(json.data)) ? json.data : [];

        return pages.map((it, i) => {
            const imageUrl = this.toAbsoluteUrl(it.imageUrl);
            return new MangaPage({
                id: imageUrl,
                url: imageUrl,
                source: this.source,
            });
        });
    }
}
