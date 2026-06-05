// Reads fullchain_report.json + sources.json, writes a curated sources.json.
// Keep: FULL/LIST (verified working) + ERROR (compressed JSON, works in-app via URLSession
// auto-decompress) + Cloudflare-gated (status 403/503/429/520 — the in-app CF solver/sheet
// can attempt them). Drop: EMPTY-200 (dead-redirect/selector-rot) + dead-status + DEAD.
// Order: FULL, then ERROR, then CF — each alphabetical. Backs up original to sources.full.json.
import { readFileSync, writeFileSync, existsSync } from 'fs';

const report = JSON.parse(readFileSync('fullchain_report.json', 'utf8'));
const sources = JSON.parse(readFileSync('sources.json', 'utf8'));
const dry = process.argv.includes('--dry');

const recById = new Map(report.map(r => [r.id, r]));
const CF_STATUS = new Set([403, 503, 429, 520]);

function tier(id) {
    const r = recById.get(id);
    if (!r) return null;
    if (r.cat === 'FULL' || r.cat === 'LIST') return 0;   // verified working
    if (r.cat === 'ERROR') return 1;                       // compressed JSON, works in-app
    if (r.cat === 'CF') return 2;                           // cloudflare
    if (r.cat === 'EMPTY' && CF_STATUS.has(r.status)) return 2; // cloudflare-blocked
    return null;                                            // drop
}

const kept = sources
    .map(s => ({ s, t: tier(s.id) }))
    .filter(x => x.t !== null)
    .sort((a, b) => a.t - b.t || a.s.title.localeCompare(b.s.title))
    .map(x => x.s);

const counts = {};
for (const r of report) counts[r.cat] = (counts[r.cat] || 0) + 1;
const keptTiers = { working: 0, error: 0, cf: 0 };
for (const s of kept) { const t = tier(s.id); keptTiers[t === 0 ? 'working' : t === 1 ? 'error' : 'cf']++; }

console.log('Report categories:', JSON.stringify(counts));
console.log(`sources.json: ${sources.length} → kept ${kept.length}`);
console.log(`  working(FULL/LIST): ${keptTiers.working}, recoverable(ERROR): ${keptTiers.error}, cloudflare: ${keptTiers.cf}`);
console.log('Dropped:', sources.length - kept.length, '(dead/parked/selector-rot)');

if (!dry) {
    if (!existsSync('sources.full.json')) writeFileSync('sources.full.json', JSON.stringify(sources, null, 1));
    writeFileSync('sources.json', JSON.stringify(kept, null, 1));
    console.log('Wrote curated sources.json (full backup at sources.full.json)');
}
