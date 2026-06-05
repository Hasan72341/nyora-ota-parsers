// Batch test: run getListPage across many sources with direct fetch (iOS path),
// categorize: OK / EMPTY / CF (cloudflare) / DEAD / ERROR. Reports per-family stats.
import { JSDOM } from 'jsdom';
import { getParser } from './index.js';
import sources from './sources.json' with { type: 'json' };

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
let lastStatus = {};

function mkContext(tag) {
    return {
        async httpGet(url, parser) {
            const domain = (parser && parser.domain) ? parser.domain : '';
            const headers = { 'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };
            if (domain) headers['Referer'] = `https://${domain}/`;
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 18000);
            try {
                const r = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
                lastStatus[tag] = r.status;
                return await r.text();
            } finally { clearTimeout(t); }
        },
        async httpPost(url, body, extra, parser) {
            const domain = (parser && parser.domain) ? parser.domain : '';
            const headers = { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded', ...(extra||{}) };
            if (domain) { headers['Referer'] = `https://${domain}/`; headers['Origin'] = `https://${domain}`; }
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 18000);
            try {
                const r = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
                lastStatus[tag] = r.status;
                return await r.text();
            } finally { clearTimeout(t); }
        },
        parseHTML(html) { return new JSDOM(html).window.document; },
        decodeContent(s) { return s; }
    };
}

const idsArg = process.argv[2];
let testSources;
if (idsArg === 'ALL') testSources = sources;
else if (idsArg) testSources = sources.filter(s => idsArg.split(',').includes(s.id));
else {
    // sample: first 2 of each family
    const byFam = {};
    testSources = [];
    for (const s of sources) {
        byFam[s.family] = (byFam[s.family]||0);
        if (byFam[s.family] < 2) { testSources.push(s); byFam[s.family]++; }
    }
}

const CONC = 12;
let i = 0;
const results = [];
async function worker() {
    while (i < testSources.length) {
        const s = testSources[i++];
        const tag = s.id;
        lastStatus[tag] = 0;
        let cat, detail = '';
        try {
            const parser = getParser(s.id, mkContext(tag));
            const list = await parser.getListPage(1, 'POPULARITY', {});
            if (list.length > 0) { cat = 'OK'; detail = `${list.length}`; }
            else cat = 'EMPTY';
        } catch (e) {
            const m = (e.message||'').toLowerCase();
            if (m.includes('just a moment') || m.includes('cloudflare') || lastStatus[tag] === 403 || lastStatus[tag] === 503) cat = 'CF';
            else if (lastStatus[tag] === 404 || m.includes('enotfound') || m.includes('econnrefused') || m.includes('certificate') || m.includes('fetch failed') || m.includes('abort')) cat = 'DEAD';
            else { cat = 'ERROR'; detail = e.message.slice(0,60); }
        }
        results.push({ id: s.id, family: s.family, domain: s.domain, cat, detail, status: lastStatus[tag] });
        console.log(`${cat.padEnd(6)} ${s.id.padEnd(24)} ${s.family.padEnd(20)} ${s.domain.padEnd(28)} ${detail}`);
    }
}
await Promise.all(Array.from({length: CONC}, worker));

const counts = {};
for (const r of results) counts[r.cat] = (counts[r.cat]||0)+1;
console.log('\n=== SUMMARY ===');
console.log(JSON.stringify(counts, null, 2));
console.log(`Total: ${results.length}`);
