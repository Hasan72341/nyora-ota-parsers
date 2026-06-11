import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

export class ComiciViewerParser extends BaseParser {
    constructor(context, source, domain, pageSize = 24) {
        super(context, source, domain, pageSize);
        this.apiUrl = source.overrides?.apiUrl || null;
        this.isAlt = source.overrides?.isAlt ?? (this.apiUrl !== null);
        if (!this.apiUrl && this.isAlt) {
            this.apiUrl = `https://${this.domain}/api`;
        }
    }

    get headers() {
        return {
            'Referer': `https://${this.domain}/`
        };
    }

    async getListPage(page, order, filter) {
        if (filter && filter.query) {
            if (this.isAlt) {
                const url = `${this.apiUrl}/search?q=${encodeURIComponent(filter.query)}&page=${page}&size=${this.pageSize}`;
                const json = JSON.parse(await this.context.httpGet(url, this));
                return this.parseSearchApi(json);
            } else {
                const url = `https://${this.domain}/search?keyword=${encodeURIComponent(filter.query)}&page=${page - 1}&filter=series`;
                const html = await this.context.httpGet(url, this);
                return this.parseSearchHtml(html);
            }
        }

        let url = "";
        if (order === SortOrder.UPDATED || order === SortOrder.NEWEST) {
            if (this.isAlt) {
                const d = new Date();
                let day = d.getDay();
                if (day === 0) day = 7;
                url = `https://${this.domain}/category/manga/day/${day}/${page}`;
            } else {
                url = `https://${this.domain}/category/manga`;
            }
        } else {
            url = `https://${this.domain}/ranking/manga`;
        }

        const html = await this.context.httpGet(url, this);
        if (this.isAlt) {
            return this.parseAltLatestHtml(html);
        } else {
            if (url.includes("/ranking/manga")) {
                return this.parseNormalRankingHtml(html);
            } else {
                return this.parseNormalLatestHtml(html);
            }
        }
    }

    parseSearchApi(json) {
        const series = json.searchResult?.series?.series || [];
        return series.map(s => {
            const url = `/series/${s.id}`;
            const images = s.images || [];
            const coverUrl = images.map(i => i.url).join(", ");
            return new Manga({
                id: url,
                url,
                title: s.name,
                coverUrl,
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE
            });
        });
    }

    parseSearchHtml(html) {
        const doc = this.context.parseHTML(html);
        const mangas = [];
        const elements = Array.from(doc.querySelectorAll("div.manga-store-item"));
        for (const el of elements) {
            const a = el.querySelector("a.c-ms-clk-article");
            if (!a) continue;
            const url = this.toRelativeUrl(a.getAttribute("href"));
            const titleEl = el.querySelector("h2.manga-title");
            const title = titleEl ? titleEl.textContent.trim() : "";
            const source = el.querySelector("source");
            const srcset = source ? source.getAttribute("data-srcset") : "";
            let coverUrl = "";
            if (srcset) {
                coverUrl = "https:" + srcset.split(" ")[0];
            }
            mangas.push(new Manga({ 
                id: url, 
                url, 
                title, 
                coverUrl, 
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE 
            }));
        }
        return mangas;
    }

    parseAltLatestHtml(html) {
        const doc = this.context.parseHTML(html);
        const mangas = [];
        const elements = Array.from(doc.querySelectorAll("div.series-list-item"));
        for (const el of elements) {
            const a = el.querySelector("a.series-list-item-link");
            if (!a) continue;
            const url = this.toRelativeUrl(a.getAttribute("href"));
            const titleEl = el.querySelector("div.series-list-item-h span");
            const title = titleEl ? titleEl.textContent.trim() : "";
            const img = el.querySelector("img.series-list-item-img");
            const coverUrl = img ? this.toAbsoluteUrl(img.getAttribute("src")) : "";
            mangas.push(new Manga({ 
                id: url, 
                url, 
                title, 
                coverUrl, 
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE 
            }));
        }
        return mangas;
    }

    parseNormalRankingHtml(html) {
        const doc = this.context.parseHTML(html);
        const mangas = [];
        const elements = Array.from(doc.querySelectorAll("div.ranking-box-vertical, div.ranking-box-vertical-top3"));
        for (const el of elements) {
            const a = el.querySelector("a");
            if (!a) continue;
            const url = this.toRelativeUrl(a.getAttribute("href"));
            const titleEl = el.querySelector(".title-text");
            const title = titleEl ? titleEl.textContent.trim() : "";
            const source = el.querySelector("source");
            const srcset = source ? source.getAttribute("data-srcset") : "";
            let coverUrl = "";
            if (srcset) {
                coverUrl = "https:" + srcset.split(" ")[0];
            }
            mangas.push(new Manga({ 
                id: url, 
                url, 
                title, 
                coverUrl, 
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE 
            }));
        }
        return mangas;
    }

    parseNormalLatestHtml(html) {
        const doc = this.context.parseHTML(html);
        const mangas = [];
        const elements = Array.from(doc.querySelectorAll("div.category-box-vertical"));
        for (const el of elements) {
            const a = el.querySelector("a");
            if (!a) continue;
            const url = this.toRelativeUrl(a.getAttribute("href"));
            const titleEl = el.querySelector(".title-text");
            const title = titleEl ? titleEl.textContent.trim() : "";
            const source = el.querySelector("source");
            const srcset = source ? source.getAttribute("data-srcset") : "";
            let coverUrl = "";
            if (srcset) {
                coverUrl = "https:" + srcset.split(" ")[0];
            }
            mangas.push(new Manga({ 
                id: url, 
                url, 
                title, 
                coverUrl, 
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE 
            }));
        }
        return mangas;
    }

    resolveText(child) {
        if (child.text != null) return child.text;
        if (child.children) {
            const inner = child.children.map(c => this.resolveText(c)).join("");
            return child.url ? `[${inner}](${child.url})` : inner;
        }
        return "";
    }

    async getDetails(manga) {
        if (this.isAlt) {
            const seriesHash = manga.url.split('/').pop();
            const url = `${this.apiUrl}/episodes?seriesHash=${seriesHash}&episodeFrom=1&episodeTo=9999`;
            const json = JSON.parse(await this.context.httpGet(url, this));
            
            const accessUrl = `${this.apiUrl}/series/access?seriesHash=${seriesHash}&episodeFrom=1&episodeTo=9999`;
            let accessMap = {};
            try {
                const accessJson = JSON.parse(await this.context.httpGet(accessUrl, this));
                const accesses = accessJson.seriesAccess?.episodeAccesses || [];
                for (const ep of accesses) {
                    accessMap[ep.episodeId] = ep;
                }
            } catch (e) {
                // Keep empty mapping on failure
            }

            const summary = json.series?.summary || {};
            const episodes = json.series?.episodes || [];
            
            const author = summary.author ? summary.author.map(a => a.name).join(", ") : "";
            let description = summary.description || "";
            if (description.startsWith("[") && description.includes("children")) {
                try {
                    const descNodes = JSON.parse(description);
                    if (Array.isArray(descNodes)) {
                        description = descNodes.map(n => n.children ? n.children.map(c => this.resolveText(c)).join("") : "").join("\n");
                    }
                } catch (e) {
                    // Fallback to original description
                }
            }
            
            const tags = summary.tag ? summary.tag.map(t => ({ title: t.name, key: t.name })) : [];
            const state = summary.isCompleted ? MangaState.FINISHED : MangaState.ONGOING;
            
            const chapters = [];
            let index = 0;
            const orderedEpisodes = episodes.slice().reverse();
            
            for (const ep of orderedEpisodes) {
                const access = accessMap[ep.id];
                const hasAccess = access ? access.hasAccess : false;
                const isCampaign = access ? access.isCampaign : false;
                const isLocked = !hasAccess;
                const isCampaignLocked = isLocked && isCampaign;
                
                let title = ep.title;
                let epUrl = `/episodes/${ep.id}`;
                if (isCampaignLocked) {
                    title = `➡️ ${title}`;
                    epUrl += "#LOGIN";
                } else if (isLocked) {
                    title = `🔒 ${title}`;
                }
                
                chapters.push(new MangaChapter({
                    id: epUrl,
                    url: epUrl,
                    title: title,
                    uploadDate: ep.datePublished ? ep.datePublished * 1000 : 0,
                    source: this.source,
                    index: index++
                }));
            }
            
            return new Manga({
                ...manga,
                title: summary.name || manga.title,
                description,
                authors: author ? [author] : [],
                tags,
                state,
                coverUrl: summary.images ? summary.images.map(i => i.url).join(', ') : manga.coverUrl,
                chapters
            });
            
        } else {
            const fullUrl = this.toAbsoluteUrl(manga.url);
            const html = await this.context.httpGet(fullUrl, this);
            const doc = this.context.parseHTML(html);
            
            const titleEl = Array.from(doc.querySelectorAll("h1.series-h-title span")).pop();
            const title = titleEl ? titleEl.textContent.trim() : manga.title;
            
            const authorEl = doc.querySelector("div.series-h-credit-user");
            const author = authorEl ? authorEl.textContent.trim() : "";
            
            const descEl = doc.querySelector("div.series-h-credit-info-text-text");
            const description = descEl ? descEl.textContent.trim() : "";
            
            const tags = Array.from(doc.querySelectorAll("a.series-h-tag-link")).map(a => {
                const t = a.textContent.trim().replace(/^#/, "");
                return { title: t, key: t };
            });
                
            const imgSource = doc.querySelector("div.series-h-img source");
            const srcset = imgSource ? imgSource.getAttribute("data-srcset") : "";
            const coverUrl = srcset ? "https:" + srcset.split(" ")[0] : manga.coverUrl;
            
            const listUrl = `https://${this.domain}${manga.url}/list?s=1`;
            const listHtml = await this.context.httpGet(listUrl, this);
            const listDoc = this.context.parseHTML(listHtml);
            
            const chapters = [];
            const epItems = Array.from(listDoc.querySelectorAll("div.series-ep-list-item"));
            let index = 0;
            
            epItems.reverse();
            
            for (const it of epItems) {
                const link = it.querySelector("a.g-episode-link-wrapper");
                if (!link) continue;
                
                const isTicketLocked = it.querySelector("img[data-src*='free_charge_ja.svg']") !== null;
                const isCoinLocked = it.querySelector("img[data-src*='coin.svg']") !== null;
                
                let dataHref = link.getAttribute("data-href") || "";
                let chapUrl = "";
                if (dataHref) {
                    chapUrl = this.toRelativeUrl(dataHref);
                } else {
                    let dataArticle = link.getAttribute("data-article") || "";
                    chapUrl = `${this.toRelativeUrl(listUrl)}#${dataArticle}NeedLogin`;
                }
                
                const nameEl = link.querySelector("span.series-ep-list-item-h-text");
                let name = nameEl ? nameEl.textContent.trim() : "";
                if (isTicketLocked) name = `🔒 ${name}`;
                else if (isCoinLocked) name = `🪙 ${name}`;
                
                let uploadDate = 0;
                const time = it.querySelector("time");
                if (time && time.getAttribute("datetime")) {
                    const dt = time.getAttribute("datetime").trim();
                    try {
                        const parsed = new Date(dt.replace(" ", "T") + "Z").getTime();
                        if (!Number.isNaN(parsed)) {
                            uploadDate = parsed;
                        }
                    } catch(e) {
                        // Keep as 0
                    }
                }
                
                chapters.push(new MangaChapter({
                    id: chapUrl,
                    url: chapUrl,
                    title: name,
                    uploadDate,
                    source: this.source,
                    index: index++
                }));
            }
            
            return new Manga({
                ...manga,
                title,
                description,
                authors: author ? [author] : [],
                tags,
                coverUrl,
                chapters
            });
        }
    }

    async getPages(chapter) {
        if (chapter.url.includes("NeedLogin") || chapter.url.includes("#LOGIN")) {
            throw new Error("Log in via WebView to read purchased chapters and refresh the entry.");
        }
        
        let comiciViewerId = "";
        let memberJwt = "";
        let baseUrl = `https://${this.domain}`;
        let bookApiUrl = `${baseUrl}/book/contentsInfo`;
        
        if (this.isAlt) {
            bookApiUrl = `${this.apiUrl}/book/contentsInfo`;
            let episodeId = chapter.url.split("/").pop();
            if (episodeId.includes("#")) {
                episodeId = episodeId.split("#")[0];
            }
            const epUrl = `${this.apiUrl}/episodes/${episodeId}`;
            const epJson = JSON.parse(await this.context.httpGet(epUrl, this));
            
            const contents = epJson.episode?.content || [];
            const viewerContent = contents.find(c => c.type === "viewer");
            if (!viewerContent) throw new Error("Viewer not found for this chapter");
            comiciViewerId = viewerContent.viewerId;
            
            try {
                const userJson = JSON.parse(await this.context.httpGet(`${this.apiUrl}/user/info`, this));
                memberJwt = userJson.user?.id || "";
            } catch(e) {
                // Ignore failure to fetch user info
            }
        } else {
            const fullUrl = this.toAbsoluteUrl(chapter.url);
            const html = await this.context.httpGet(fullUrl, this);
            const doc = this.context.parseHTML(html);
            const viewer = doc.querySelector("#comici-viewer");
            if (!viewer) throw new Error("You need to log in via WebView to read this chapter or purchase this chapter.");
            
            comiciViewerId = viewer.getAttribute("comici-viewer-id");
            memberJwt = viewer.getAttribute("data-member-jwt") || "";
        }
        
        const reqUrl = `${bookApiUrl}?comici-viewer-id=${encodeURIComponent(comiciViewerId)}&user-id=${encodeURIComponent(memberJwt)}&page-from=0`;
        const pageToReqUrl = `${reqUrl}&page-to=1`;
        
        let pageToParse = 1;
        try {
            const pageToJson = JSON.parse(await this.context.httpGet(pageToReqUrl, this));
            pageToParse = pageToJson.totalPages;
        } catch(e) {
            throw new Error("Log in via WebView and purchase this chapter to read.");
        }
        
        const getAllPages = `${reqUrl}&page-to=${pageToParse}`;
        const allPagesJson = JSON.parse(await this.context.httpGet(getAllPages, this));
        
        const result = allPagesJson.result || [];
        const pages = [];
        for (const p of result) {
            let url = p.imageUrl;
            if (p.scramble) {
                url += "#" + p.scramble;
            }
            pages.push(new MangaPage({
                id: url,
                url: url,
                source: this.source
            }));
        }
        return pages;
    }
}
