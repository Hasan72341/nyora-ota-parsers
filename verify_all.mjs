/**
 * Consolidated ground-truth verifier: for each ported family, try up to MAX_TRY of its
 * concrete sources (direct origin fetch) and record the best list->chapters->pages chain.
 * Prints a table + writes verify_all.json.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 18000;
const MAX_TRY = 8;

const FAMILIES = {
  zeistmanga: 'ZeistMangaParser', onemanga: 'OneMangaParser', hotcomics: 'HotComicsParser',
  wpcomics: 'WpComicsParser', pizzareader: 'PizzaReaderParser', keyoapp: 'KeyoappParser',
  foolslide: 'FoolSlideParser', liliana: 'LilianaParser', madtheme: 'MadthemeParser',
  scan: 'ScanParser', iken: 'IkenParser', mmrcms: 'MmrcmsParser', cupfox: 'CupFoxParser',
  fmreader: 'FmreaderParser', animebootstrap: 'AnimeBootstrapParser', guya: 'GuyaParser',
  mangaworld: 'MangaWorldParser', mangadventure: 'MangAdventureParser', initmanga: 'InitMangaParser',
  fuzzydoodle: 'FuzzyDoodleParser', uzaymanga: 'UzayMangaParser', comicaso: 'ComicasoParser',
  mangotheme: 'MangoThemeParser', zmanga: 'ZMangaParser', likemanga: 'LikeMangaParser', sinmh: 'SinmhParser',
};

function makeContext() {
  async function doFetch(url, init = {}, parser) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const headers = {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Referer': `https://${(parser && parser.domain) || (() => { try { return new URL(url).hostname; } catch { return ''; } })()}/`,
        ...(init.headers || {}),
      };
      const res = await fetch(url, { ...init, headers, redirect: 'follow', signal: ctrl.signal });
      if (parser && res.url) {
        try {
          const fd = new URL(res.url).hostname;
          if (fd && fd !== new URL(url).hostname) parser.domain = fd;
        } catch { /* ignore */ }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(t);
    }
  }
  return {
    httpGet: (url, parser) => doFetch(url, {}, parser),
    httpPost: (url, body, headers = {}, parser) => doFetch(url, { method: 'POST', headers, body }, parser),
    parseHTML: (html) => new JSDOM(html).window.document,
  };
}

async function testSource(ParserClass, source) {
  const out = { id: source.id, domain: source.domain, list: 0, chapters: 0, pages: 0, error: null };
  const parser = new ParserClass(makeContext(), source, source.domain);
  if (source.overrides) Object.assign(parser, source.overrides);
  try {
    let list = await parser.getListPage(1, 'POPULARITY', {});
    if (!list || !list.length) list = await parser.getListPage(1, 'UPDATED', {});
    out.list = (list && list.length) || 0;
    if (list && list.length) {
      out.sampleTitle = list[0].title;
      const details = await parser.getDetails(list[0]);
      const chapters = details.chapters || [];
      out.chapters = chapters.length;
      if (chapters.length) {
        const pages = await parser.getPages(chapters[0]);
        out.pages = (pages && pages.length) || 0;
      }
    }
  } catch (e) {
    out.error = String(e.message || e).split('\n')[0];
  }
  return out;
}

const results = {};
for (const [key, cls] of Object.entries(FAMILIES)) {
  const fragPath = path.join(__dirname, 'staging', `sources_${key}.json`);
  const frag = JSON.parse(fs.readFileSync(fragPath, 'utf8'));
  const mod = await import(pathToFileURL(path.join(__dirname, `${key}.js`)).href);
  const ParserClass = mod[cls];
  if (!ParserClass) { results[key] = { ok: false, best: null, note: `class ${cls} not exported`, tried: 0 }; continue; }
  let best = null;
  let tried = 0;
  for (const source of frag.slice(0, MAX_TRY)) {
    tried++;
    const r = await testSource(ParserClass, source);
    if (!best || r.list > best.list || (r.list === best.list && r.pages > best.pages)) best = r;
    if (r.list > 0 && r.chapters > 0 && r.pages > 0) break; // full chain found, stop early
  }
  const ok = !!(best && best.list > 0);
  results[key] = { ok, full: !!(best && best.list > 0 && best.chapters > 0 && best.pages > 0), best, tried, total: frag.length };
  const tag = results[key].full ? 'FULL' : ok ? 'LIST' : 'FAIL';
  console.log(`${tag.padEnd(4)} ${cls.padEnd(22)} tried ${tried}/${frag.length}  best=${JSON.stringify(best)}`);
}

fs.writeFileSync(path.join(__dirname, 'verify_all.json'), JSON.stringify(results, null, 2));
const full = Object.values(results).filter((r) => r.full).length;
const list = Object.values(results).filter((r) => r.ok && !r.full).length;
const fail = Object.values(results).filter((r) => !r.ok).length;
console.log(`\nSUMMARY: ${full} FULL chain, ${list} LIST-only, ${fail} FAIL (of ${Object.keys(FAMILIES).length} families)`);
