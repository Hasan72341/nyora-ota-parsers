#!/usr/bin/env node
/*
 * Single build for Nyora's JS parser engine.
 *
 *   node build.mjs
 *
 * Produces dist/{parsers.bundle.js, sources.json, manifest.json} and fans the
 * engine out to every platform's bundled-fallback location (identical paths to
 * the old hand-copies, so nothing downstream changes):
 *   - desktop  → nyora-mac/shared/src/commonMain/resources/{parsers.bundle.js, parsers_sources.json}
 *   - iOS      → nyora-ios/NyoraApp/NyoraApp/Resources/{parsers.bundle.js, parsers_sources.json}
 *   - web SPA  → nyora-web/shared/src/jvmMain/resources/web/core/web-parsers/  (family .js + base + sources.json; keeps its own fetch-based index.js)
 *   - cloudflare static → nyora-web/cloudflare/public/parsers/                  (full engine incl index/ios_entry/shim)
 *
 * dist/ is what you publish to GitHub-raw for OTA (see OTA_BASE).
 */
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

// Where the OTA artifacts are published. Point this at your GitHub-raw dist path.
// Apps fetch `${OTA_BASE}/manifest.json` and download bundle/sources from these URLs.
const OTA_BASE = process.env.NYORA_OTA_BASE
  || 'https://raw.githubusercontent.com/REPLACE_ME/nyora-ota-parser/main/dist';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
mkdirSync(DIST, { recursive: true });

// --- 1. Bundle (IIFE global NyoraParsers). The installed esbuild can't parse the
//        `with { type: 'json' }` import attribute, so strip it from a temp copy of
//        index.js for the build, then restore (src stays pristine even on crash). ---
const indexPath = join(SRC, 'index.js');
const indexOrig = readFileSync(indexPath, 'utf8');
const indexPatched = indexOrig.replace(/ with \{ type: ['"]json['"] \}/g, '');
try {
  if (indexPatched !== indexOrig) writeFileSync(indexPath, indexPatched);
  await esbuild.build({
    entryPoints: [join(SRC, 'ios_entry.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    globalName: 'NyoraParsers',
    alias: { 'node:crypto': join(SRC, 'node_crypto_shim.js') },
    outfile: join(DIST, 'parsers.bundle.js'),
    logLevel: 'warning',
  });
} finally {
  if (indexPatched !== indexOrig) writeFileSync(indexPath, indexOrig);
}

// --- 2. Catalog into dist (canonical catalog lives in src/, next to index.js) ---
copyFileSync(join(SRC, 'sources.json'), join(DIST, 'sources.json'));

// --- 3. Manifest (monotonic version + sha256 gate for OTA verification) ---
const bundleBuf = readFileSync(join(DIST, 'parsers.bundle.js'));
const sourcesBuf = readFileSync(join(DIST, 'sources.json'));
const manifestPath = join(DIST, 'manifest.json');
let prevVersion = 0;
if (existsSync(manifestPath)) {
  try { prevVersion = JSON.parse(readFileSync(manifestPath, 'utf8')).version || 0; } catch { /* ignore */ }
}
const manifest = {
  version: prevVersion + 1,
  bundle: { url: `${OTA_BASE}/parsers.bundle.js`, sha256: sha256(bundleBuf), bytes: bundleBuf.length },
  sources: { url: `${OTA_BASE}/sources.json`, sha256: sha256(sourcesBuf), bytes: sourcesBuf.length },
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// --- 4. Fan out to every platform's bundled-fallback location (if in monorepo) ---
const engineFiles = readdirSync(SRC).filter((f) => f.endsWith('.js'));
function copyEngine(dir, { index, entry }) {
  if (!existsSync(dir)) return;
  for (const f of engineFiles) {
    if (f === 'index.js' && !index) continue;
    if ((f === 'ios_entry.js' || f === 'node_crypto_shim.js') && !entry) continue;
    copyFileSync(join(SRC, f), join(dir, f));
  }
  copyFileSync(join(SRC, 'sources.json'), join(dir, 'sources.json'));
}

const macRes = join(REPO, 'nyora-mac/shared/src/commonMain/resources');
if (existsSync(macRes)) {
  copyFileSync(join(DIST, 'parsers.bundle.js'), join(macRes, 'parsers.bundle.js'));
  copyFileSync(join(DIST, 'sources.json'), join(macRes, 'parsers_sources.json'));
  console.log('  fanned out → macOS/Linux/Windows resources');
}

const iosRes = join(REPO, 'nyora-ios/NyoraApp/NyoraApp/Resources');
if (existsSync(iosRes)) {
  copyFileSync(join(DIST, 'parsers.bundle.js'), join(iosRes, 'parsers.bundle.js'));
  copyFileSync(join(DIST, 'sources.json'), join(iosRes, 'parsers_sources.json'));
  console.log('  fanned out → iOS resources');
}

// Android: the WebView engine loads the same IIFE bundle from assets/ (mirrors iOS).
const androidRes = join(REPO, 'nyora-android/app/src/main/assets');
if (existsSync(androidRes)) {
  copyFileSync(join(DIST, 'parsers.bundle.js'), join(androidRes, 'parsers.bundle.js'));
  copyFileSync(join(DIST, 'sources.json'), join(androidRes, 'parsers_sources.json'));
  console.log('  fanned out → Android assets');
}

// cloudflare static SPA: full engine (it imports index.js + ios_entry isn't used, but restore all)
const cfPath = join(REPO, 'nyora-web/cloudflare/public/parsers');
if (existsSync(cfPath)) {
  copyEngine(cfPath, { index: true, entry: true });
  console.log('  fanned out → Cloudflare static SPA');
}

// JVM web SPA: engine + base + sources.json; keep its own fetch-based index.js
const webSpaPath = join(REPO, 'nyora-web/shared/src/jvmMain/resources/web/core/web-parsers');
if (existsSync(webSpaPath)) {
  copyEngine(webSpaPath, { index: false, entry: false });
  console.log('  fanned out → JVM web SPA');
}

console.log(`Built parsers v${manifest.version}`);
console.log(`  bundle:  ${bundleBuf.length} bytes  sha256 ${manifest.bundle.sha256.slice(0, 12)}…`);
console.log(`  sources: ${sourcesBuf.length} bytes  sha256 ${manifest.sources.sha256.slice(0, 12)}…`);
console.log(`  OTA base: ${OTA_BASE}`);

