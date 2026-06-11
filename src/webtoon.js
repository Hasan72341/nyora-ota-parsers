import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

export class WebtoonParser extends BaseParser {
    constructor(context, source, domain, pageSize = 24) {
        super(context, source, domain, pageSize);
        this.lang = (source && source.locale) ? String(source.locale).split('-')[0] : 'en';
        this.maxChapterPages = 300; // safety cap for very long series
    }

    base() { return `https://${this.domain}`; }
    
    reqHeaders() { 
        return { 
            'Cookie': `ageGatePass=true; needGDPR=false; locale=${this.lang}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
        }; 
    }
    
    imgHeaders() { return { 'Referer': `${this.base()}/` }; }

    text(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }

    imageSrc(img) {
        if (!img) return '';
        let u = img.getAttribute('data-url') || img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (!u || u.startsWith('data:') || /bg_transparency|placeholder/i.test(u)) {
            u = img.getAttribute('data-url') || img.getAttribute('src') || '';
        }
        if (u && u.includes('type=q90')) {
            u = u.replace(/([?&])type=q90(&|$)/, (match, p1, p2) => {
                if (p1 === '?' && p2 === '&') return '?';
                return p2 === '&' ? '&' : '';
            });
        }
        return u;
    }

    // ---- List / Search -------------------------------------------------

    async getListPage(page, order, filter) {
        filter = filter || {};
        const query = filter.query && String(filter.query).trim();
        // Both endpoints return a single full page; stop pagination after page 1.
        if (page > 1) return [];
        const url = query
            ? `${this.base()}/${this.lang}/search?keyword=${encodeURIComponent(query)}`
            : `${this.base()}/${this.lang}/originals`;
        const html = await this.context.httpGet(url, this, this.reqHeaders());
        const doc = this.context.parseHTML(html);
        return this.parseCards(doc);
    }

    parseCards(doc) {
        const anchors = Array.from(doc.querySelectorAll(
            'a.link._originals_title_a, a.link._card_item, .webtoon_list li a, a[href*="/list?title_no="]'
        ));
        const out = [];
        const seen = new Set();
        for (const a of anchors) {
            const href = a.getAttribute('href') || '';
            if (!/title_no=\d+/.test(href) && !/titleNo=\d+/.test(href)) continue;
            const url = this.toRelativeUrl(href.split('#')[0]);
            if (seen.has(url)) continue;
            seen.add(url);
            const title = this.text(a.querySelector('.title, .subj, h1.subj, h3.subj, strong.title')) ||
                (a.querySelector('img') && a.querySelector('img').getAttribute('alt')) || '';
            if (!title) continue;
            const genre = this.text(a.querySelector('.genre'));
            const cover = this.toAbsoluteUrl(this.imageSrc(a.querySelector('img')));
            out.push(new Manga({
                id: url,
                url,
                publicUrl: this.toAbsoluteUrl(url),
                coverUrl: cover,
                title,
                tags: genre ? [{ title: genre, key: genre.toLowerCase() }] : [],
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            }));
        }
        return out;
    }

    // ---- Details / Chapters --------------------------------------------

    async getDetails(manga) {
        const listUrl = this.toAbsoluteUrl(manga.url);
        const html = await this.context.httpGet(listUrl, this, this.reqHeaders());
        const doc = this.context.parseHTML(html);

        const ogImage = doc.querySelector('meta[property="og:image"]');
        const cover = (ogImage && ogImage.getAttribute('content')) || manga.coverUrl || '';
        const description = this.text(doc.querySelector('#_asideDetail .summary, .detail_body .summary, p.summary, .summary'));
        
        const authorEls = Array.from(doc.querySelectorAll('.detail_header .info .author, .author_area, .author'));
        const authorsText = authorEls.map(el => this.text(el)).join(', ');
        let authors = authorsText
            ? authorsText.replace(/author|illustrator|adapted by|original work/gi, '')
                .split(/[,/]/).map(s => s.trim()).filter(Boolean)
            : [];
        authors = [...new Set(authors)];

        const genre = this.text(doc.querySelector('.detail_header .genre, .detail_header .info .genre, .genre'));
        const status = this.text(doc.querySelector('.day_info, .detail_body .day_info, p.day_info')).toUpperCase();
        const state = /COMPLETED|FINISH|END|TERMINÉ/i.test(status) ? MangaState.FINISHED
            : (/HIATUS|REST/i.test(status) ? MangaState.PAUSED : MangaState.ONGOING);

        const chapters = await this.collectChapters(manga.url);

        return new Manga({
            ...manga,
            title: this.text(doc.querySelector('.detail_header .subj, h1.subj, h3.subj, .subj')) || manga.title,
            coverUrl: cover,
            largeCoverUrl: cover,
            description,
            authors,
            tags: genre ? [{ title: genre, key: genre.toLowerCase() }] : (manga.tags || []),
            state,
            chapters,
        });
    }

    async getChapters(manga) {
        return this.collectChapters(manga.url);
    }

    async collectChapters(mangaUrl) {
        const baseUrl = this.toAbsoluteUrl(mangaUrl);
        const titleNoMatch = baseUrl.match(/title_no=(\d+)/i) || baseUrl.match(/titleNo=(\d+)/i);
        
        if (titleNoMatch) {
            const titleNo = titleNoMatch[1];
            const isCanvas = baseUrl.includes('/canvas/') || baseUrl.includes('challenge');
            const type = isCanvas ? 'canvas' : 'webtoon';
            const apiUrl = `https://m.webtoons.com/api/v1/${type}/${titleNo}/episodes?pageSize=99999`;
            
            try {
                const apiHtml = await this.context.httpGet(apiUrl, this, {
                    'Referer': 'https://m.webtoons.com/',
                    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.162 Mobile Safari/537.36',
                    'Cookie': `ageGatePass=true; needGDPR=false; locale=${this.lang}`
                });
                const data = JSON.parse(apiHtml);
                if (data && data.result && data.result.episodeList) {
                    const episodes = data.result.episodeList;
                    const chapters = [];
                    for (let i = 0; i < episodes.length; i++) {
                        const ep = episodes[i];
                        const noMatch = ep.viewerLink.match(/episode_no=(\d+)/i);
                        const no = noMatch ? parseInt(noMatch[1], 10) : (episodes.length - i);
                        
                        chapters.push(new MangaChapter({
                            id: this.toRelativeUrl(ep.viewerLink),
                            url: this.toRelativeUrl(ep.viewerLink),
                            title: ep.episodeTitle,
                            number: no,
                            volume: 0,
                            uploadDate: ep.exposureDateMillis || 0,
                            source: this.source,
                            index: 0
                        }));
                    }
                    chapters.sort((a, b) => a.number - b.number);
                    chapters.forEach((c, i) => c.index = i);
                    return chapters;
                }
            } catch (e) {
                // Fallthrough to HTML scraping if API fails
            }
        }

        const byNo = new Map();
        for (let page = 1; page <= this.maxChapterPages; page++) {
            const sep = baseUrl.includes('?') ? '&' : '?';
            const pageUrl = page === 1 ? baseUrl : `${baseUrl}${sep}page=${page}`;
            let html;
            try { html = await this.context.httpGet(pageUrl, this, this.reqHeaders()); }
            catch { break; }
            const doc = this.context.parseHTML(html);
            const items = Array.from(doc.querySelectorAll('#_listUl li._episodeItem, ul#_listUl > li'));
            let added = 0;
            for (const li of items) {
                const a = li.querySelector('a[href*="viewer"]') || li.querySelector('a');
                if (!a) continue;
                const href = a.getAttribute('href') || '';
                if (!/viewer/.test(href)) continue;
                const no = parseInt(li.getAttribute('data-episode-no') ||
                    (href.match(/episode_no=(\d+)/i) || [])[1] || '0', 10);
                if (!no || byNo.has(no)) continue;
                const title = this.text(a.querySelector('.subj span, .subj')) || `Episode ${no}`;
                const dateTxt = this.text(a.querySelector('.date'));
                const ts = dateTxt ? (Date.parse(dateTxt) || 0) : 0;
                byNo.set(no, {
                    url: this.toRelativeUrl(href.split('#')[0]),
                    title,
                    number: no,
                    uploadDate: Number.isNaN(ts) ? 0 : ts,
                });
                added++;
            }
            if (added === 0) break;
        }
        const ordered = Array.from(byNo.values()).sort((a, b) => a.number - b.number);
        return ordered.map((c, i) => new MangaChapter({
            id: c.url,
            url: c.url,
            title: c.title,
            number: c.number,
            volume: 0,
            uploadDate: c.uploadDate,
            source: this.source,
            index: i,
        }));
    }

    // ---- Pages ---------------------------------------------------------

    async getPages(chapter) {
        const url = this.toAbsoluteUrl(chapter.url);
        const html = await this.context.httpGet(url, this, this.reqHeaders());
        const doc = this.context.parseHTML(html);
        const imgs = Array.from(doc.querySelectorAll('#_imageList img._images, #_imageList img, div.viewer_lst img'));
        const pages = [];
        const seen = new Set();
        
        for (const img of imgs) {
            const u = this.imageSrc(img);
            if (!u || u.startsWith('data:') || seen.has(u)) continue;
            seen.add(u);
            pages.push(new MangaPage({ id: u, url: u, source: this.source, headers: this.imgHeaders() }));
        }

        if (pages.length === 0) {
            const docUrlMatch = html.match(/documentURL\s*:\s*['"]([^'"]+)['"]/);
            const motionPathMatch = html.match(/jpg\s*:\s*['"](.*?)\{/);
            if (docUrlMatch && motionPathMatch) {
                const docUrl = docUrlMatch[1];
                const motionPath = motionPathMatch[1];
                try {
                    const motionHtml = await this.context.httpGet(docUrl, this, this.reqHeaders());
                    const motionData = JSON.parse(motionHtml);
                    if (motionData && motionData.assets && motionData.assets.images) {
                        const images = motionData.assets.images;
                        const sortedKeys = Object.keys(images).filter(k => k.includes('layer')).sort();
                        for (const key of sortedKeys) {
                            const u = motionPath + images[key];
                            if (!seen.has(u)) {
                                seen.add(u);
                                pages.push(new MangaPage({ id: u, url: u, source: this.source, headers: this.imgHeaders() }));
                            }
                        }
                    }
                } catch (e) {
                    // Ignore motion toon failures
                }
            }
        }
        
        return pages;
    }
}
