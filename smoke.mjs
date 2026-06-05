/**
 * Standardized live smoke-test for a single Nyora web parser family.
 *
 * Usage:
 *   node smoke.mjs --file ./onemanga.js --class OneMangaParser --id BLUELOCKSCAN [--domain bluelockscan.com]
 *
 * Resolves the source descriptor (isNsfw, overrides, domain) from staging/sources_<key>.json
 * if --id is given, else builds a minimal descriptor from --domain.
 * Runs the full chain getListPage -> getDetails -> getPages through the deployed CORS proxy
 * and prints a one-line JSON summary. Exit code 0 if list parsed >0, else 1.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Verification fetches the origin DIRECTLY (Node has no CORS) so we test parser
// selector logic, not the deployed proxy. Set NYORA_PROXY to route via the worker.
const PROXY = process.env.NYORA_PROXY || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 25000;

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const fileArg = arg('file');
const className = arg('class');
const wantId = arg('id');
let domain = arg('domain');

if (!fileArg || !className) {
  console.error('Need --file and --class');
  process.exit(2);
}

// Try to resolve a full source descriptor from the family fragment.
let source = null;
const key = path.basename(fileArg).replace(/\.js$/, '');
const fragPath = path.join(__dirname, 'staging', `sources_${key}.json`);
if (fs.existsSync(fragPath)) {
  const frag = JSON.parse(fs.readFileSync(fragPath, 'utf8'));
  source = wantId ? frag.find((s) => s.id === wantId) : frag[0];
}
if (!source) {
  source = { id: wantId || 'TEST', title: wantId || 'Test', domain, locale: 'en', isNsfw: false, overrides: {} };
}
domain = domain || source.domain;

async function doFetch(url, init = {}, parser) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const target = PROXY ? `${PROXY}/proxy?url=${encodeURIComponent(url)}` : url;
    const headers = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      // Force uncompressed: Node's undici won't auto-decompress reliably here.
      'Accept-Encoding': 'identity',
      ...(PROXY ? {} : { 'Referer': `https://${(parser && parser.domain) || new URL(url).hostname}/` }),
      ...(init.headers || {}),
    };
    const res = await fetch(target, { ...init, headers, redirect: 'follow', signal: ctrl.signal });
    // Track cross-host redirects so the parser keeps using the live domain.
    if (parser && res.url) {
      try {
        const fd = new URL(res.url).hostname;
        if (fd && fd !== new URL(url).hostname && !PROXY) parser.domain = fd;
      } catch { /* ignore */ }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

const context = {
  httpGet: (url, parser) => doFetch(url, {}, parser),
  httpPost: (url, body, headers = {}, parser) => doFetch(url, { method: 'POST', headers, body }, parser),
  parseHTML: (html) => new JSDOM(html).window.document,
};

const { [className]: ParserClass } = await import(pathToFileURL(path.resolve(fileArg)).href);
if (!ParserClass) {
  console.error(`Class ${className} not exported from ${fileArg}`);
  process.exit(2);
}

const parser = new ParserClass(context, source, domain);
if (source.overrides) Object.assign(parser, source.overrides);

const summary = { id: source.id, domain, list: 0, sampleTitle: null, chapters: 0, pages: 0, error: null };
try {
  let list = await parser.getListPage(1, 'POPULARITY', {});
  if (!list || !list.length) list = await parser.getListPage(1, 'UPDATED', {});
  summary.list = (list && list.length) || 0;
  if (list && list.length) {
    summary.sampleTitle = list[0].title;
    try {
      const details = await parser.getDetails(list[0]);
      const chapters = details.chapters || [];
      summary.chapters = chapters.length;
      if (chapters.length) {
        const pages = await parser.getPages(chapters[0]);
        summary.pages = (pages && pages.length) || 0;
      }
    } catch (e) {
      summary.error = `details/pages: ${String(e.message || e).split('\n')[0]}`;
    }
  }
} catch (e) {
  summary.error = `list: ${String(e.message || e).split('\n')[0]}`;
}

console.log(JSON.stringify(summary));
process.exit(summary.list > 0 ? 0 : 1);
