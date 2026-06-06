import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

export class MadaraParser extends BaseParser {
    constructor(context, source, domain, pageSize = 12) {
        super(context, source, domain, pageSize);
        this.withoutAjax = false;
        this.tagPrefix = "manga-genre/";
        this.datePattern = "MMMM d, yyyy";
        this.stylePage = "?style=list";
        this.postReq = false;

        this.ongoing = new Set([
            "مستمرة", "en curso", "ongoing", "on going", "OnGoing", "ativo", "en cours",
            "en cours \uD83D\uDFE2", "en cours de publication", "activo", "đang tiến hành",
            "em lançamento", "онгоінг", "publishing", "devam ediyor", "em andamento",
            "in corso", "güncel", "berjalan", "продолжается", "updating", "lançando",
            "in arrivo", "emision", "en emision", "مستمر", "curso", "en marcha",
            "publicandose", "publicando", "连载中"
        ]);

        this.finished = new Set([
            "completed", "complete", "completo", "complété", "fini", "achevé", "terminé",
            "terminé ⚫", "tamamlandı", "đã hoàn thành", "hoàn thành", "مكتملة",
            "завершено", "завершен", "finished", "finalizado", "completata", "one-shot",
            "bitti", "tamat", "completado", "concluído", "concluido", "已完结", "bitmiş",
            "end", "منتهية"
        ]);

        this.abandoned = new Set([
            "canceled", "cancelled", "cancelado", "cancellato", "cancelados", "dropped",
            "discontinued", "abandonné"
        ]);

        this.paused = new Set([
            "hiatus", "on hold", "pausado", "en espera", "en pause", "en attente"
        ]);

        this.upcoming = new Set([
            "upcoming", "لم تُنشَر بعد", "prochainement", "à venir"
        ]);
    }

    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Source variants sometimes need newer selector syntax. Fall
                // through to simpler selectors when the DOM rejects one.
            }
        }
        return [];
    }

    imageSrc(img) {
        const url = img ? (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "") : "";
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    isAsuraAstro() {
        return this.domain === "asurascans.com" || this.domain === "asuracomic.net";
    }

    asuraApiBase() {
        return "https://api.asurascans.com";
    }

    asuraCdnBase() {
        return "https://cdn.asurascans.com";
    }

    async httpGetStable(url, marker) {
        let html = await this.context.httpGet(url, this);
        for (let i = 0; this.isAsuraAstro() && marker && !html.includes(marker) && i < 4; i++) {
            const sep = url.includes("?") ? "&" : "?";
            html = await this.context.httpGet(`${url}${sep}nyoraTry=${Date.now()}-${i}`, this);
        }
        return html;
    }

    async getAsuraListPage(page, order, filter) {
        let url = `https://${this.domain}/browse?page=${page}`;
        if (filter.query) url += `&search=${encodeURIComponent(filter.query)}`;
        const html = await this.context.httpGet(url, this);
        const doc = this.context.parseHTML(html);
        const seen = new Set();
        const entries = [];
        for (const a of Array.from(doc.querySelectorAll('a[href*="/series/"], a[href*="/comics/"], a[href*="/manga/"]'))) {
            const href = a.getAttribute("href") || "";
            if (!href || href.includes("/chapter/")) continue;
            const relHref = this.toRelativeUrl(href).replace(/\/$/, "");
            if (seen.has(relHref)) continue;
            const img = a.querySelector("img");
            const title = (img && img.getAttribute("alt") || a.textContent || "").trim();
            if (!title || title.length > 120) continue;
            seen.add(relHref);
            entries.push(new Manga({
                id: relHref,
                url: relHref,
                publicUrl: this.toAbsoluteUrl(relHref),
                coverUrl: this.imageSrc(img),
                title,
                source: this.source,
                contentRating: ContentRating.SAFE
            }));
        }
        return entries;
    }

    asuraSeriesKey(url) {
        const rel = this.toRelativeUrl(url || "");
        const match = rel.match(/\/(series|comics|manga)\//);
        if (match) {
             const key = rel.substring(rel.indexOf(match[0]) + match[0].length).split(/[/?#]/)[0];
             return key || "";
        }
        return "";
    }

    async getJson(url) {
        const text = await this.context.httpGet(url);
        return JSON.parse(text);
    }

    async getAsuraDetails(manga) {
        let key = this.asuraSeriesKey(manga.url);
        if (!key) throw new Error("Missing Asura series key");
        
        const apiBase = this.asuraApiBase();
        const fetchSeries = async (k) => {
            if (!k) return null;
            try {
                const text = await this.context.httpGet(apiBase + "/api/series/" + k + "?nyoraTry=" + Date.now());
                const res = JSON.parse(text);
                const s = res.series || res.data?.series || res.data || res;
                return (s && s.title) ? s : null;
            } catch { return null; }
        };

        let series = await fetchSeries(key);
        
        if (!series && manga.title) {
             try {
                const searchTerm = manga.title.replace(/['’]/g, "").replace(/\s+/g, " ").trim();
                const searchUrl = "https://asurascans.com/browse?search=" + encodeURIComponent(searchTerm);
                const searchHtml = await this.context.httpGet(searchUrl, this);
                const searchDoc = this.context.parseHTML(searchHtml);
                
                const links = Array.from(searchDoc.querySelectorAll('a[href*="/series/"], a[href*="/comics/"]'));
                const normalize = (t) => (t || "").toLowerCase().replace(/[^a-z0-9]/g, "");
                const targetTitle = normalize(manga.title);
                
                const foundA = links.find(a => normalize(a.textContent) === targetTitle) || links[0];
                
                if (foundA) {
                    const newRel = this.toRelativeUrl(foundA.getAttribute("href")).replace(/\/$/, "");
                    const newKey = this.asuraSeriesKey(newRel);
                    if (newKey && newKey !== key) {
                        series = await fetchSeries(newKey);
                        if (series) key = newKey;
                    }
                }
             } catch (e) {}
        }

        if (!series) series = {};

        const parseDate = (d) => {
            if (!d) return null;
            try {
                const date = new Date(d);
                return isNaN(date.getTime()) ? null : date.toISOString();
            } catch { return null; }
        };

        let chapterRows = [];
        try {
            const text = await this.context.httpGet(apiBase + "/api/series/" + key + "/chapters?nyoraTry=" + Date.now());
            const chaptersRes = JSON.parse(text);
            chapterRows = Array.isArray(chaptersRes.data) ? chaptersRes.data : [];
        } catch {
            chapterRows = [];
        }
        
        const publicUrl = "https://asurascans.com/comics/" + key;
        const chapters = chapterRows.map((row) => new MangaChapter({
            id: publicUrl + "/chapter/" + row.number,
            url: publicUrl + "/chapter/" + row.number,
            title: row.title || ("Chapter " + row.number),
            number: Number(row.number) || 0,
            uploadDate: parseDate(row.published_at),
            source: this.source
        }));

        return new Manga({
            ...manga,
            title: series.title || manga.title,
            description: series.description || "",
            authors: [series.author, series.artist].filter(Boolean),
            tags: (series.genres || []).map((genre) => ({ title: genre.name, key: genre.slug || genre.name })),
            state: String(series.status || "").toLowerCase() === "dropped" ? MangaState.ABANDONED : MangaState.ONGOING,
            contentRating: ContentRating.SAFE,
            source: this.source,
            chapters
        });
    }

    async getAsuraPages(chapter) {
        const key = this.asuraSeriesKey(chapter.url);
        const rel = this.toRelativeUrl(chapter.url);
        const number = (rel.match(/\/chapter\/([^/?#]+)/) || [])[1];
        if (key && number) {
            try {
                const data = JSON.parse(await this.context.httpGet(`${this.asuraApiBase()}/api/series/${key}/chapters/${number}?nyoraTry=${Date.now()}`));
                const pages = data && data.data && data.data.chapter && Array.isArray(data.data.chapter.pages)
                    ? data.data.chapter.pages
                    : [];
                if (pages.length) {
                    return pages.map((page, i) => new MangaPage({
                        id: page.url || String(i),
                        url: page.url,
                        source: this.source
                    })).filter((page) => page.url);
                }
            } catch {
                // Fall through to chapter HTML extraction.
            }
        }
        return null;
    }

    getAsuraCdnPages(chapter, count = 30) {
        const rel = this.toRelativeUrl(chapter.url);
        const key = this.asuraSeriesKey(rel);
        const number = (rel.match(/\/chapter\/([^/?#]+)/) || [])[1];
        if (!key || !number) return [];
        const seriesSlug = key.replace(/-[a-f0-9]{8}$/i, "");
        return Array.from({ length: count }, (_, i) => {
            const page = String(i + 1).padStart(3, "0");
            const url = `${this.asuraCdnBase()}/asura-images/chapters/${seriesSlug}/${number}/${page}.webp`;
            return new MangaPage({
                id: url,
                url,
                source: this.source
            });
        });
    }

    parseAsuraChapters(doc, mangaUrl) {
        const seen = new Set();
        const chapters = [];
        for (const a of Array.from(doc.querySelectorAll('a[href*="/chapter/"]'))) {
            const href = a.getAttribute("href") || "";
            const relHref = this.toRelativeUrl(href).replace(/\/$/, "");
            if (!relHref.match(/\/(series|comics|manga)\//) || !relHref.includes("/chapter/") || seen.has(relHref)) continue;
            const text = a.textContent.replace(/\s+/g, " ").trim();
            const match = text.match(/Chapter\s+[\d.]+/i) || relHref.match(/chapter\/([^/?#]+)/i);
            const title = match ? String(match[0]).replace("chapter/", "Chapter ") : text || "Chapter";
            seen.add(relHref);
            chapters.push(new MangaChapter({
                id: relHref,
                url: relHref,
                title,
                number: Number((title.match(/[\d.]+/) || [chapters.length + 1])[0]) || chapters.length + 1,
                source: this.source
            }));
        }
        return chapters;
    }

    parseAsuraChaptersHtml(html) {
        const seen = new Set();
        const chapters = [];
        for (const match of html.matchAll(/href="([^"]*\/comics\/[^"]*\/chapter\/[^"#?]+)[^"]*"/g)) {
            const relHref = this.toRelativeUrl(match[1]).replace(/\/$/, "");
            if (seen.has(relHref)) continue;
            const num = (relHref.match(/\/chapter\/([^/?#]+)/) || [])[1] || String(chapters.length + 1);
            seen.add(relHref);
            chapters.push(new MangaChapter({
                id: relHref,
                url: relHref,
                title: `Chapter ${num}`,
                number: Number(num) || chapters.length + 1,
                source: this.source
            }));
        }
        return chapters;
    }

    parseChapterList(html) {
        const chapterDoc = this.context.parseHTML(html);
        const elements = this.queryAll(chapterDoc, [
            "li.wp-manga-chapter",
            "div.wp-manga-chapter",
            ".wp-manga-chapter",
            "ul.main.version-chap li",
            ".listing-chapters_wrap li",
            ".chapter-list li",
            ".chapters li",
        ]).reverse();

        return elements.map((el, i) => {
            const a = el.querySelector("a");
            if (!a) return null;
            const href = a.getAttribute("href");
            const relHref = this.toRelativeUrl(href);
            return new MangaChapter({
                id: relHref,
                url: relHref + this.stylePage,
                title: a.textContent.trim(),
                number: i + 1,
                source: this.source
            });
        }).filter((c) => c && c.url && !c.url.includes("#"));
    }

    async getListPage(page, order, filter) {
        if (this.isAsuraAstro()) {
            return this.getAsuraListPage(page, order, filter);
        }
        const domain = this.domain;
        if (this.withoutAjax) {
            const pages = page + 1;
            let url = `https://${domain}`;
            if (pages > 1) url += `/page/${pages}`;
            url += `/?s=${encodeURIComponent(filter.query || "")}&post_type=wp-manga`;

            let orderStr = "";
            switch (order) {
                case SortOrder.POPULARITY: orderStr = "views"; break;
                case SortOrder.UPDATED: orderStr = "latest"; break;
                case SortOrder.NEWEST: orderStr = "new-manga"; break;
                case SortOrder.ALPHABETICAL: orderStr = "alphabet"; break;
                case SortOrder.RATING: orderStr = "rating"; break;
            }
            if (orderStr) url += `&m_orderby=${orderStr}`;

            const html = await this.context.httpGet(url, this);
            return this.parseMangaList(html);
        } else {
            const url = `https://${domain}/wp-admin/admin-ajax.php`;
            const params = new URLSearchParams();
            params.append("action", "madara_load_more");
            params.append("page", page.toString());
            params.append("template", "madara-core/content/content-search");
            params.append("vars[s]", filter.query || "");
            params.append("vars[post_type]", "wp-manga");
            params.append("vars[post_status]", "publish");
            params.append("vars[manga_archives_item_layout]", "default");

            switch (order) {
                case SortOrder.POPULARITY:
                    params.append("vars[meta_key]", "_wp_manga_views");
                    params.append("vars[orderby]", "meta_value_num");
                    params.append("vars[order]", "desc");
                    break;
                case SortOrder.UPDATED:
                    params.append("vars[meta_key]", "_latest_update");
                    params.append("vars[orderby]", "meta_value_num");
                    params.append("vars[order]", "desc");
                    break;
            }

            const html = await this.context.httpPost(url, params.toString(), {
                'Content-Type': 'application/x-www-form-urlencoded'
            }, this);
            return this.parseMangaList(html);
        }
    }

    parseMangaList(html) {
        const doc = this.context.parseHTML(html);
        const elements = doc.querySelectorAll("div.row.c-tabs-item__content, div.page-item-detail");
        const mangaList = [];

        for (const el of elements) {
            const a = el.querySelector("a");
            if (!a) continue;
            const href = a.getAttribute("href");
            const relHref = this.toRelativeUrl(href);
            const titleEl = el.querySelector("h3, h4, .manga-name, .post-title");
            const img = el.querySelector("img");
            
            mangaList.push(new Manga({
                id: relHref,
                url: relHref,
                publicUrl: this.toAbsoluteUrl(relHref),
                coverUrl: this.imageSrc(img),
                title: titleEl ? titleEl.textContent.trim() : "",
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE
            }));
        }
        return mangaList;
    }

    async getDetails(manga) {
        if (this.isAsuraAstro()) {
            return this.getAsuraDetails(manga);
        }
        let html = await this.context.httpGet(this.toAbsoluteUrl(manga.url), this);
        if (this.isAsuraAstro() && !html.includes("/chapter/")) {
            html = await this.httpGetStable(this.toAbsoluteUrl(manga.url), "/chapter/");
        }
        const doc = this.context.parseHTML(html);

        if (this.isAsuraAstro()) {
            const title = doc.querySelector("h1")?.textContent?.trim() ||
                (html.match(/<title>(.*?)\s*\|\s*Asura Scans<\/title>/i) || [])[1] ||
                manga.title;
            const desc = doc.querySelector('meta[name="description"]')?.getAttribute("content") ||
                (html.match(/<meta name="description" content="([^"]*)"/i) || [])[1] ||
                "";
            const cover = this.imageSrc(Array.from(doc.querySelectorAll("img")).find((img) => img.getAttribute("alt") === title)) ||
                this.imageSrc(doc.querySelector("img[id*=cover], img[src*=covers]")) ||
                (doc.querySelector('meta[property="og:image"]')?.getAttribute("content") || "") ||
                (html.match(/<meta property="og:image" content="([^"]*)"/i) || [])[1] ||
                "";
            const chapters = this.parseAsuraChapters(doc, manga.url);
            return new Manga({
                ...manga,
                title,
                description: desc,
                coverUrl: cover || manga.coverUrl,
                largeCoverUrl: cover || manga.largeCoverUrl || manga.coverUrl,
                chapters: chapters.length ? chapters : this.parseAsuraChaptersHtml(html)
            });
        }

        const title = doc.querySelector("h1")?.textContent?.trim() || manga.title;
        const desc = doc.querySelector("div.description-summary div.summary__content, .post-content_item > h5 + div")?.innerHTML || "";
        const chapters = await this.loadChapters(manga.url, doc);

        return new Manga({
            ...manga,
            title,
            description: desc,
            chapters: chapters
        });
    }

    async loadChapters(mangaUrl, doc) {
        let chapterHtml;
        try {
            if (this.postReq) {
                const mangaId = doc.querySelector("div#manga-chapters-holder")?.getAttribute("data-id");
                if (mangaId) {
                    const url = `https://${this.domain}/wp-admin/admin-ajax.php`;
                    chapterHtml = await this.context.httpPost(url, `action=manga_get_chapters&manga=${mangaId}`, {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }, this);
                }
            } else {
                const url = this.toAbsoluteUrl(mangaUrl).replace(/\/$/, "") + "/ajax/chapters/";
                chapterHtml = await this.context.httpPost(url, "", {}, this);
            }
        } catch {
            chapterHtml = "";
        }

        let chapters = chapterHtml ? this.parseChapterList(chapterHtml) : [];
        if (!chapters.length) {
            chapters = this.parseChapterList(doc.documentElement.outerHTML);
        }
        return chapters;
    }

    async getPages(chapter) {
        let html;
        if (this.isAsuraAstro()) {
            const url = this.toAbsoluteUrl(chapter.url);
            const sep = url.includes("?") ? "&" : "?";
            html = "";
            for (let i = 0; !html.includes("asura-images/chapters/") && i < 5; i++) {
                html = await this.context.httpGet(`${url}${sep}nyoraTry=${Date.now()}-${i}`, this);
            }
        } else {
            html = await this.context.httpGet(this.toAbsoluteUrl(chapter.url), this);
        }
        const doc = this.context.parseHTML(html);

        if (this.isAsuraAstro()) {
            let imageUrls = Array.from(doc.querySelectorAll("img[data-page-index]")).map((img) => this.imageSrc(img));
            if (!imageUrls.length) {
                imageUrls = Array.from(html.matchAll(/https:\/\/cdn\.asurascans\.com\/asura-images\/chapters\/[^"'<>\s)]+/g))
                    .map((match) => match[0]);
            }
            const pages = imageUrls.map((imageUrl, i) => {
                return new MangaPage({
                    id: imageUrl || String(i),
                    url: imageUrl,
                    source: this.source
                });
            }).filter((p) => p.url);
            if (pages.length) return pages;
            const apiPages = await this.getAsuraPages(chapter);
            if (apiPages && apiPages.length) return apiPages;
            return this.getAsuraCdnPages(chapter);
        }
        
        const images = doc.querySelectorAll("div.reading-content img, .page-break img");
        return Array.from(images).map(img => {
            const imageUrl = this.imageSrc(img);
            return new MangaPage({
                id: imageUrl,
                url: imageUrl,
                source: this.source
            });
        });
    }
}
