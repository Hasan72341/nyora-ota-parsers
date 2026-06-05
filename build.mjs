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

// --- 3.5 Diagnostic Dashboard (index.html) to prevent Pages 404 ---
const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Nyora OTA Parsers Status</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #0d0f12;
            --card: #15181e;
            --accent: #ff007f;
            --accent-grad: linear-gradient(135deg, #ff007f 0%, #7f00ff 100%);
            --text: #e2e8f0;
            --muted: #64748b;
        }
        body {
            background-color: var(--bg);
            color: var(--text);
            font-family: 'Outfit', sans-serif;
            margin: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
        }
        .container {
            background-color: var(--card);
            padding: 2.5rem;
            border-radius: 1.25rem;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            max-width: 500px;
            width: 100%;
            text-align: center;
            border: 1px solid rgba(255, 255, 255, 0.05);
        }
        h1 {
            font-weight: 600;
            margin-top: 0;
            background: var(--accent-grad);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .status-badge {
            display: inline-block;
            padding: 0.4rem 1rem;
            border-radius: 2rem;
            background: rgba(0, 230, 118, 0.1);
            color: #00e676;
            font-weight: 600;
            font-size: 0.85rem;
            margin-bottom: 1.5rem;
        }
        .meta-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1rem;
            margin-bottom: 2rem;
            text-align: left;
        }
        .meta-item {
            background: rgba(255,255,255,0.02);
            padding: 0.75rem 1rem;
            border-radius: 0.5rem;
            border: 1px solid rgba(255,255,255,0.03);
        }
        .meta-label {
            font-size: 0.75rem;
            color: var(--muted);
            text-transform: uppercase;
        }
        .meta-val {
            font-size: 1.1rem;
            font-weight: 600;
            margin-top: 0.2rem;
        }
        .links {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
        }
        a.btn {
            display: block;
            padding: 0.85rem;
            border-radius: 0.5rem;
            text-decoration: none;
            color: var(--text);
            font-weight: 600;
            transition: all 0.2s ease;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.08);
        }
        a.btn:hover {
            transform: translateY(-2px);
            background: rgba(255,255,255,0.08);
            border-color: var(--accent);
        }
        a.btn.primary {
            background: var(--accent-grad);
            border: none;
        }
        a.btn.primary:hover {
            opacity: 0.9;
            box-shadow: 0 0 15px rgba(255,0,127,0.4);
        }
        footer {
            margin-top: 2rem;
            font-size: 0.8rem;
            color: var(--muted);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="status-badge">● Systems Operational</div>
        <h1>Nyora OTA Scrapers</h1>
        <p style="color: var(--muted); margin-bottom: 2rem;">Host and CDN for Nyora's Over-the-Air parser updates.</p>
        
        <div class="meta-grid">
            <div class="meta-item">
                <div class="meta-label">Active Version</div>
                <div class="meta-val">v${manifest.version}</div>
            </div>
            <div class="meta-item">
                <div class="meta-label">Bundle Size</div>
                <div class="meta-val">${(bundleBuf.length / 1024).toFixed(1)} KB</div>
            </div>
        </div>

        <div class="links">
            <a href="manifest.json" class="btn primary">View manifest.json</a>
            <a href="parsers.bundle.js" class="btn">Download parsers.bundle.js</a>
            <a href="sources.json" class="btn">View sources.json</a>
        </div>

        <footer>Built automatically via GitHub Actions</footer>
    </div>
</body>
</html>`;
writeFileSync(join(DIST, 'index.html'), dashboardHtml + '\n');
console.log('  generated index.html dashboard');


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

