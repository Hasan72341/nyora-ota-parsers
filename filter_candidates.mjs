/**
 * Parser-level filter for the bulk-extracted candidates.
 * For each candidate, actually run getListPage via a direct-fetch context and classify:
 *   PARSES  list>0                          -> keep (verified)
 *   CF      HTTP 401/403/429/503            -> keep (Cloudflare/auth; the proxy handles these)
 *   DEAD    404 / DNS / redirect-loop / 0   -> drop
 * Rebuild the catalog = original base (current minus all candidate ids) + kept, write both.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED = path.resolve(HERE, '../../../shared/src/jvmMain/resources/web/core/web-parsers');
const CATALOGS = [path.join(HERE, 'sources.json'), path.join(SHARED, 'sources.json')];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const CONC = 24, TIMEOUT = 15000;

const FILES = {
  MadaraParser: 'madara.js', MangaReaderParser: 'mangareader.js', ZeistMangaParser: 'zeistmanga.js',
  OneMangaParser: 'onemanga.js', HotComicsParser: 'hotcomics.js', WpComicsParser: 'wpcomics.js',
  PizzaReaderParser: 'pizzareader.js', KeyoappParser: 'keyoapp.js', FoolSlideParser: 'foolslide.js',
  LilianaParser: 'liliana.js', MadthemeParser: 'madtheme.js', ScanParser: 'scan.js', IkenParser: 'iken.js',
  MmrcmsParser: 'mmrcms.js', CupFoxParser: 'cupfox.js', FmreaderParser: 'fmreader.js',
  AnimeBootstrapParser: 'animebootstrap.js', GuyaParser: 'guya.js', MangaWorldParser: 'mangaworld.js',
  MangAdventureParser: 'mangadventure.js', InitMangaParser: 'initmanga.js', FuzzyDoodleParser: 'fuzzydoodle.js',
  UzayMangaParser: 'uzaymanga.js', ComicasoParser: 'comicaso.js', MangoThemeParser: 'mangotheme.js',
  ZMangaParser: 'zmanga.js', LikeMangaParser: 'likemanga.js', SinmhParser: 'sinmh.js',
};
const CLASSES = {};
for (const [cls, file] of Object.entries(FILES)) {
  const mod = await import(pathToFileURL(path.join(HERE, file)).href);
  CLASSES[cls] = mod[cls];
}

function ctx() {
  const f = async (url, init = {}, parser) => {
    const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
      'Accept-Encoding': 'identity', 'Referer': `https://${(parser && parser.domain) || (() => { try { return new URL(url).hostname; } catch { return ''; } })()}/`,
      ...(init.headers || {}) };
    const r = await fetch(url, { ...init, headers, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
    if (parser && r.url) { try { const d = new URL(r.url).hostname; if (d && d !== new URL(url).hostname) parser.domain = d; } catch {} }
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return r.text();
  };
  return { httpGet: (u, p) => f(u, {}, p), httpPost: (u, b, h = {}, p) => f(u, { method: 'POST', headers: h, body: b }, p), parseHTML: (h) => new JSDOM(h).window.document };
}

async function classify(src) {
  const Cls = CLASSES[src.family];
  if (!Cls) return { src, kind: 'DEAD', note: 'no class' };
  const p = new Cls(ctx(), src, src.domain);
  if (src.overrides) Object.assign(p, src.overrides);
  try {
    let list = await p.getListPage(1, 'POPULARITY', {});
    if (!list || !list.length) list = await p.getListPage(1, 'UPDATED', {});
    if (list && list.length) return { src, kind: 'PARSES', note: `${list.length}` };
    return { src, kind: 'DEAD', note: 'list=0' };
  } catch (e) {
    if ([401, 403, 429, 503].includes(e.status)) return { src, kind: 'CF', note: `HTTP ${e.status}` };
    return { src, kind: 'DEAD', note: String(e.message || e).slice(0, 24) };
  }
}

const candidates = JSON.parse(fs.readFileSync(path.join(HERE, 'candidates.json'), 'utf8'));
const candIds = new Set(candidates.map((s) => s.id));
const current = JSON.parse(fs.readFileSync(CATALOGS[0], 'utf8'));
const base = current.filter((s) => !candIds.has(s.id)); // original pre-bulk catalog

const results = [];
for (let i = 0; i < candidates.length; i += CONC) {
  const batch = candidates.slice(i, i + CONC);
  results.push(...await Promise.all(batch.map(classify)));
  process.stderr.write(`  ${Math.min(i + CONC, candidates.length)}/${candidates.length}\r`);
}

const parses = results.filter((r) => r.kind === 'PARSES');
const cf = results.filter((r) => r.kind === 'CF');
const dead = results.filter((r) => r.kind === 'DEAD');
const kept = [...parses, ...cf].map((r) => r.src);

const merged = [...base, ...kept].sort((a, b) => (a.family + a.title.toLowerCase()).localeCompare(b.family + b.title.toLowerCase()));
for (const c of CATALOGS) fs.writeFileSync(c, JSON.stringify(merged, null, 2));
fs.writeFileSync(path.join(HERE, 'dead_sources.json'), JSON.stringify(dead.map((r) => ({ ...r.src, _why: r.note })), null, 2));

console.log(`\ncandidates: ${candidates.length} | PARSES: ${parses.length} | CF(proxy-handleable): ${cf.length} | DEAD(dropped): ${dead.length}`);
console.log(`catalog: base ${base.length} + kept ${kept.length} = ${merged.length}`);
const byFam = {};
for (const s of merged) byFam[s.family] = (byFam[s.family] || 0) + 1;
for (const [f, n] of Object.entries(byFam).sort((a, b) => b[1] - a[1])) console.log(`   ${f.padEnd(22)} ${n}`);
