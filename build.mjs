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
let totalSources = 0;
try {
  totalSources = JSON.parse(sourcesBuf.toString()).length;
} catch (e) {
  totalSources = 0;
}

const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Nyora Parser Portal</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #090b0e;
            --card: #11141a;
            --card-border: rgba(255, 255, 255, 0.04);
            --accent: #ff007f;
            --accent-grad: linear-gradient(135deg, #ff007f 0%, #7f00ff 100%);
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --text-muted: #64748b;
            --success: #10b981;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            background-color: var(--bg);
            color: var(--text-primary);
            font-family: 'Outfit', sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1.5rem;
            position: relative;
            overflow-x: hidden;
        }

        /* Ambient glowing backdrop */
        body::before {
            content: '';
            position: absolute;
            width: 300px;
            height: 300px;
            background: var(--accent-grad);
            filter: blur(120px);
            opacity: 0.15;
            top: 10%;
            left: 10%;
            z-index: 0;
            pointer-events: none;
        }

        body::after {
            content: '';
            position: absolute;
            width: 280px;
            height: 280px;
            background: var(--accent-grad);
            filter: blur(110px);
            opacity: 0.12;
            bottom: 10%;
            right: 10%;
            z-index: 0;
            pointer-events: none;
        }

        .portal-card {
            background: var(--card);
            border: 1px solid var(--card-border);
            border-radius: 1.5rem;
            width: 100%;
            max-width: 460px;
            padding: 2rem;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(8px);
            z-index: 1;
            position: relative;
        }

        /* Responsive padding scaling */
        @media (max-width: 480px) {
            .portal-card {
                padding: 1.5rem;
                border-radius: 1.25rem;
            }
        }

        .header {
            text-align: center;
            margin-bottom: 2rem;
        }

        .status-pill {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            background: rgba(16, 185, 129, 0.08);
            border: 1px solid rgba(16, 185, 129, 0.15);
            padding: 0.4rem 1rem;
            border-radius: 9999px;
            color: var(--success);
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin-bottom: 1rem;
        }

        .status-dot {
            width: 8px;
            height: 8px;
            background-color: var(--success);
            border-radius: 50%;
            box-shadow: 0 0 8px var(--success);
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0% { transform: scale(0.95); opacity: 0.7; }
            50% { transform: scale(1.1); opacity: 1; box-shadow: 0 0 12px var(--success); }
            100% { transform: scale(0.95); opacity: 0.7; }
        }

        .title {
            font-size: 1.75rem;
            font-weight: 700;
            background: var(--accent-grad);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 0.5rem;
            letter-spacing: -0.02em;
        }

        .subtitle {
            font-size: 0.875rem;
            color: var(--text-secondary);
            line-height: 1.4;
        }

        /* Stats Section */
        .stats-row {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 0.75rem;
            margin-bottom: 2rem;
        }

        .stat-card {
            background: rgba(255, 255, 255, 0.01);
            border: 1px solid rgba(255, 255, 255, 0.02);
            border-radius: 1rem;
            padding: 0.85rem 0.5rem;
            text-align: center;
            transition: border-color 0.2s ease;
        }

        .stat-card:hover {
            border-color: rgba(255, 255, 255, 0.06);
        }

        .stat-value {
            font-size: 1.25rem;
            font-weight: 700;
            color: var(--text-primary);
            margin-bottom: 0.2rem;
        }

        .stat-label {
            font-size: 0.65rem;
            color: var(--text-muted);
            text-transform: uppercase;
            font-weight: 600;
            letter-spacing: 0.05em;
        }

        /* Integration Helper */
        .copy-box {
            background: #080a0d;
            border: 1px solid rgba(255, 255, 255, 0.03);
            border-radius: 0.75rem;
            padding: 0.75rem;
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 2rem;
            font-size: 0.8rem;
        }

        .copy-text {
            color: var(--text-secondary);
            font-family: monospace;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            padding-right: 0.5rem;
        }

        .copy-btn {
            background: var(--accent-grad);
            border: none;
            color: var(--text-primary);
            padding: 0.4rem 0.8rem;
            border-radius: 0.5rem;
            font-size: 0.75rem;
            font-weight: 600;
            cursor: pointer;
            transition: opacity 0.2s;
            flex-shrink: 0;
        }

        .copy-btn:hover {
            opacity: 0.9;
        }

        /* File list styling */
        .file-list {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
            margin-bottom: 1.5rem;
        }

        .file-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: rgba(255, 255, 255, 0.01);
            border: 1px solid rgba(255, 255, 255, 0.02);
            border-radius: 0.75rem;
            padding: 0.85rem 1rem;
            text-decoration: none;
            color: var(--text-primary);
            transition: all 0.2s ease;
        }

        .file-row:hover {
            transform: translateY(-2px);
            background: rgba(255, 255, 255, 0.02);
            border-color: rgba(255, 0, 127, 0.2);
        }

        .file-info {
            display: flex;
            flex-direction: column;
            text-align: left;
            gap: 0.2rem;
        }

        .file-name {
            font-size: 0.9rem;
            font-weight: 500;
        }

        .file-meta {
            font-size: 0.75rem;
            color: var(--text-muted);
        }

        .arrow-icon {
            color: var(--text-secondary);
            font-size: 1.1rem;
            transition: transform 0.2s;
        }

        .file-row:hover .arrow-icon {
            transform: translateX(4px);
            color: var(--accent);
        }

        .footer {
            text-align: center;
            font-size: 0.75rem;
            color: var(--text-muted);
            margin-top: 2rem;
        }
    </style>
</head>
<body>
    <div class="portal-card">
        <div class="header">
            <div class="status-pill">
                <div class="status-dot"></div>
                Active Release
            </div>
            <div class="title">Nyora Parsers</div>
            <div class="subtitle">Cloud distribution and OTA delivery portal for Nyora's scraper engines.</div>
        </div>

        <div class="stats-row">
            <div class="stat-card">
                <div class="stat-value">v${manifest.version}</div>
                <div class="stat-label">Version</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${(bundleBuf.length / 1024).toFixed(0)}k</div>
                <div class="stat-label">Bundle</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${totalSources}</div>
                <div class="stat-label">Sources</div>
            </div>
        </div>

        <div class="copy-box">
            <div class="copy-text" id="urlText">https://hasan72341.github.io/nyora-ota-parsers/manifest.json</div>
            <button class="copy-btn" onclick="copyUrl()">Copy URL</button>
        </div>

        <div class="file-list">
            <a href="manifest.json" class="file-row">
                <div class="file-info">
                    <span class="file-name">manifest.json</span>
                    <span class="file-meta">Distribution release index</span>
                </div>
                <span class="arrow-icon">→</span>
            </a>
            <a href="parsers.bundle.js" class="file-row">
                <div class="file-info">
                    <span class="file-name">parsers.bundle.js</span>
                    <span class="file-meta">JavaScript scraper package</span>
                </div>
                <span class="arrow-icon">→</span>
            </a>
            <a href="sources.json" class="file-row">
                <div class="file-info">
                    <span class="file-name">sources.json</span>
                    <span class="file-meta">Metadata catalog definitions</span>
                </div>
                <span class="arrow-icon">→</span>
            </a>
        </div>

        <div class="footer">
            Build verified & compiled via GitHub Actions
        </div>
    </div>

    <script>
        function copyUrl() {
            const el = document.createElement('textarea');
            el.value = document.getElementById('urlText').innerText;
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
            
            const btn = document.querySelector('.copy-btn');
            const orig = btn.innerText;
            btn.innerText = 'Copied!';
            btn.style.background = '#10b981';
            setTimeout(() => {
                btn.innerText = orig;
                btn.style.background = '';
            }, 1500);
        }
    </script>
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

