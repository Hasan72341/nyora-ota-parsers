// Full-chain test across ALL sources with direct fetch (exact iOS-path parity).
// Categorizes each: FULL (list+pages), LIST (list ok, pages failed), EMPTY, CF, DEAD, ERROR.
// Writes fullchain_report.json. Run: node fullchain_test.mjs [CONC]
import { JSDOM } from 'jsdom';
import { getParser } from './index.js';
import sources from './sources.json' with { type: 'json' };
import { writeFileSync } from 'fs';

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const TIMEOUT = 15000;

function mkContext(state) {
    async function doFetch(url, method, body, extra, parser) {
        const domain = (parser && parser.domain) ? parser.domain : '';
        const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', ...(extra||{}) };
        if (domain) headers['Referer'] = `https://${domain}/`;
        if (method === 'POST' && domain) headers['Origin'] = `https://${domain}`;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), TIMEOUT);
        try {
            const r = await fetch(url, { method, headers, body, redirect: 'follow', signal: ctrl.signal });
            state.lastStatus = r.status;
            return await r.text();
        } finally { clearTimeout(t); }
    }
    return {
        httpGet: (url, parser) => doFetch(url, 'GET', undefined, undefined, parser),
        httpPost: (url, body, extra, parser) => doFetch(url, 'POST', body, extra, parser),
        parseHTML: (html) => new JSDOM(html).window.document,
        decodeContent: (s) => s,
    };
}

const CONC = parseInt(process.argv[2] || '16', 10);
const results = [];
let idx = 0;
let done = 0;

async function worker() {
    while (idx < sources.length) {
        const s = sources[idx++];
        const state = { lastStatus: 0 };
        const rec = { id: s.id, family: s.family, domain: s.domain, cat: '', list: 0, pages: 0, status: 0, detail: '' };
        try {
            const p = getParser(s.id, mkContext(state));
            const list = await p.getListPage(1, 'POPULARITY', {});
            rec.list = list.length;
            rec.status = state.lastStatus;
            if (list.length === 0) { rec.cat = 'EMPTY'; }
            else {
                // try full chain
                try {
                    const det = await p.getDetails(list[0]);
                    const chs = det.chapters || [];
                    if (chs.length) {
                        const pages = await p.getPages(chs[chs.length - 1]); // oldest ch usually freely hosted
                        rec.pages = pages.length;
                        rec.cat = pages.length > 0 ? 'FULL' : 'LIST';
                    } else { rec.cat = 'LIST'; rec.detail = 'no chapters'; }
                } catch (e2) { rec.cat = 'LIST'; rec.detail = 'chain:' + (e2.message||'').slice(0,40); }
            }
        } catch (e) {
            const m = (e.message || '').toLowerCase();
            rec.status = state.lastStatus;
            if (state.lastStatus === 403 || state.lastStatus === 503 || m.includes('just a moment') || m.includes('cloudflare')) rec.cat = 'CF';
            else if (state.lastStatus === 404 || m.includes('enotfound') || m.includes('econnrefused') || m.includes('certificate') || m.includes('fetch failed') || m.includes('abort') || m.includes('terminated')) rec.cat = 'DEAD';
            else { rec.cat = 'ERROR'; rec.detail = (e.message||'').slice(0,50); }
        }
        results.push(rec);
        done++;
        if (done % 20 === 0) console.error(`... ${done}/${sources.length}`);
    }
}

await Promise.all(Array.from({ length: CONC }, worker));

results.sort((a, b) => a.id.localeCompare(b.id));
writeFileSync('fullchain_report.json', JSON.stringify(results, null, 1));

const counts = {};
for (const r of results) counts[r.cat] = (counts[r.cat] || 0) + 1;
console.log('\n=== SUMMARY ===');
console.log(JSON.stringify(counts, null, 2));
console.log('Total:', results.length);
console.log('FULL sources:', results.filter(r => r.cat === 'FULL').length);
console.log('FULL+LIST (usable):', results.filter(r => r.cat === 'FULL' || r.cat === 'LIST').length);
