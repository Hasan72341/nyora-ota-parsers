#!/usr/bin/env python3
"""
One-shot porting script for Nyora Web.

For EVERY non-@Broken @MangaSourceParser in the Kotlin tree whose parser family is
already implemented in JS (the 28 ported families), extract a source descriptor
{id, className, title, locale, domain, family, isNsfw, overrides}, resolving the
Kotlin superclass chain to a known JS family. Dedupe vs the current catalog,
liveness-filter the candidates, and merge the reachable ones into both sources.json.

Bespoke parsers (no shared template / family not ported) are skipped and reported.

Usage:
  python3 port_sources.py            # extract + liveness-filter + merge
  python3 port_sources.py --no-verify   # extract + merge ALL (skip liveness)
  python3 port_sources.py --dry          # extract + report only, no writes
"""
import os, re, json, sys, urllib.request, ssl
from concurrent.futures import ThreadPoolExecutor

KOTLIN = "/Users/hasanraza/.gemini/tmp/kotatsu/kotatsu-parsers-redo/src/main/kotlin/org/koitharu/kotatsu/parsers/site"
HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = os.path.normpath(os.path.join(HERE, "../../../shared/src/jvmMain/resources/web/core/web-parsers"))
CATALOGS = [os.path.join(HERE, "sources.json"), os.path.join(SHARED, "sources.json")]

# The 28 families implemented in JS (Kotlin template class name == JS class name).
KNOWN_FAMILIES = {
    "MadaraParser","MangaReaderParser","ZeistMangaParser","OneMangaParser","HotComicsParser",
    "WpComicsParser","PizzaReaderParser","KeyoappParser","FoolSlideParser","LilianaParser",
    "MadthemeParser","ScanParser","IkenParser","MmrcmsParser","CupFoxParser","FmreaderParser",
    "AnimeBootstrapParser","GuyaParser","MangaWorldParser","MangAdventureParser","InitMangaParser",
    "FuzzyDoodleParser","UzayMangaParser","ComicasoParser","MangoThemeParser","ZMangaParser",
    "LikeMangaParser","SinmhParser",
}
# Kotlin template -> JS family alias (structurally identical templates).
ALIASES = {
    "MangaThemesia": "MangaReaderParser",  # MangaThemesia == WPMangaStream/MangaReader
    "WeLoveMangaParser": "FmreaderParser",
}

OVERRIDE_STR = ["listUrl","datePattern","tagPrefix","stylePage","selectMangaList","selectMangaListImg",
                "selectMangaListTitle","selectChapter","selectPage","selectDesc","selectState","selectTags"]
OVERRIDE_BOOL = ["postReq","withoutAjax","encodedSrc","isNetShieldProtected","sourceLocale"]
OVERRIDE_INT = ["pageSize","searchPageSize"]

DOMAIN_RE = r'([a-z0-9][a-z0-9\-]*\.(?:[a-z0-9\-]+\.)*[a-z]{2,})'

def read(p):
    with open(p, "r", errors="ignore") as f:
        return f.read()

def build_super_index(files):
    """class X ... : YParser  ->  {X: Y}"""
    idx = {}
    for p in files:
        c = read(p)
        for m in re.finditer(r'class\s+([A-Za-z0-9_]+)\s*(?:\([^{]*?\))?\s*:\s*([A-Za-z0-9_]+)', c):
            idx.setdefault(m.group(1), m.group(2))
    return idx

def resolve_family(start_super, idx, depth=0):
    """Walk the superclass chain until we hit a known JS family."""
    cur = start_super
    seen = set()
    while cur and cur not in seen and depth < 8:
        seen.add(cur)
        if cur in KNOWN_FAMILIES:
            return cur
        if cur in ALIASES:
            return ALIASES[cur]
        cur = idx.get(cur)
        depth += 1
    return None

def parse_source(path, idx):
    c = read(path)
    if "@Broken" in c or "@MangaSourceParser" not in c:
        return None
    m = re.search(r'@MangaSourceParser\(\s*"([^"]+)"\s*,\s*"([^"]+)"(?:\s*,\s*"([^"]+)")?', c)
    if not m:
        return None
    sid, title, locale = m.group(1), m.group(2), (m.group(3) or "all")

    cm = re.search(r'class\s+([A-Za-z0-9_]+)', c)
    if not cm:
        return None
    class_name = cm.group(1)

    sm = re.search(r'class\s+[A-Za-z0-9_]+\s*(?:\([^{]*?\))?\s*:\s*([A-Za-z0-9_]+)', c)
    if not sm:
        return None
    family = resolve_family(sm.group(1), idx)
    if not family:
        return None  # bespoke / family not ported in JS

    # Domain: constructor 3rd-arg string -> configKeyDomain -> domain= -> ConfigKey.Domain(...)
    domain = None
    ctor = re.search(r':\s*[A-Za-z0-9_]+\s*\(([^{]*?)\)\s*\{', c, re.S)
    if ctor:
        d = re.search(r'"' + DOMAIN_RE + r'"', ctor.group(1))
        if d:
            domain = d.group(1)
    if not domain:
        d = re.search(r'configKeyDomain\s*=\s*ConfigKey\.Domain\(\s*"' + DOMAIN_RE + r'"', c) \
            or re.search(r'ConfigKey\.Domain\(\s*"' + DOMAIN_RE + r'"', c) \
            or re.search(r'(?:override\s+val\s+)?domain\s*=\s*"' + DOMAIN_RE + r'"', c)
        if d:
            domain = d.group(1)
    if not domain:
        return None  # can't target without a domain

    is_nsfw = bool(
        "ContentType.HENTAI" in c
        or re.search(r'override\s+val\s+isNsfw(Source)?\s*=\s*true', c)
        or "galleryadults" in path.replace("\\", "/")
    )

    overrides = {}
    for k in OVERRIDE_STR:
        mm = re.search(rf'override\s+val\s+{k}\s*=\s*"([^"]+)"', c)
        if mm: overrides[k] = mm.group(1)
    for k in OVERRIDE_BOOL:
        mm = re.search(rf'override\s+val\s+{k}\s*=\s*(true|false)', c)
        if mm: overrides[k] = (mm.group(1) == "true")
    for k in OVERRIDE_INT:
        mm = re.search(rf'override\s+val\s+{k}\s*=\s*([0-9]+)', c)
        if mm: overrides[k] = int(mm.group(1))

    return {"id": sid, "className": class_name, "title": title, "locale": locale,
            "domain": domain, "family": family, "isNsfw": is_nsfw, "overrides": overrides}

_CTX = ssl.create_default_context(); _CTX.check_hostname = False; _CTX.verify_mode = ssl.CERT_NONE
def alive(src):
    url = f"https://{src['domain'].split('/')[0]}/"
    req = urllib.request.Request(url, method="GET", headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
        "Accept": "text/html,*/*;q=0.8", "Accept-Encoding": "identity"})
    try:
        with urllib.request.urlopen(req, timeout=10, context=_CTX) as r:
            return (src, r.status, True)
    except urllib.error.HTTPError as e:
        # 403/503/429 = Cloudflare/rate-limit -> works via proxy, treat as alive
        return (src, e.code, e.code in (401, 403, 429, 503))
    except Exception as e:
        return (src, str(e)[:40], False)

def main():
    no_verify = "--no-verify" in sys.argv
    dry = "--dry" in sys.argv

    files = [os.path.join(r, f) for r, _, fs in os.walk(KOTLIN) for f in fs if f.endswith(".kt")]
    idx = build_super_index(files)

    extracted, skipped = [], 0
    for p in files:
        s = parse_source(p, idx)
        if s: extracted.append(s)
        else: skipped += 1

    # dedupe extracted by id (keep first)
    seen_ids, uniq = set(), []
    for s in extracted:
        if s["id"] in seen_ids: continue
        seen_ids.add(s["id"]); uniq.append(s)

    catalog = json.load(open(CATALOGS[0]))
    cat_ids = {s["id"] for s in catalog}
    cat_domains = {s["domain"] for s in catalog}
    candidates = [s for s in uniq if s["id"] not in cat_ids and s["domain"] not in cat_domains]

    from collections import Counter
    print(f"Kotlin .kt files: {len(files)} | extracted (family ported): {len(uniq)} | bespoke/skipped: {skipped}")
    print(f"Already in catalog: {len(catalog)} | NEW candidates (deduped): {len(candidates)}")
    print("New candidates by family:")
    for fam, n in Counter(s["family"] for s in candidates).most_common():
        print(f"   {fam:22} +{n}")

    if dry:
        json.dump(candidates, open(os.path.join(HERE, "candidates.json"), "w"), ensure_ascii=False, indent=2)
        print("\n--dry: wrote candidates.json, no catalog changes."); return

    if no_verify:
        keep, dead = candidates, []
    else:
        print(f"\nLiveness-checking {len(candidates)} domains (parallel)...")
        keep, dead = [], []
        with ThreadPoolExecutor(max_workers=32) as ex:
            for src, status, ok in ex.map(alive, candidates):
                (keep if ok else dead).append({**src, "_probe": status})
        for s in keep: s.pop("_probe", None)
        print(f"  alive: {len(keep)} | dead/unreachable: {len(dead)}")
        json.dump(dead, open(os.path.join(HERE, "dead_sources.json"), "w"), ensure_ascii=False, indent=2)

    merged = catalog + keep
    merged.sort(key=lambda x: (x["family"], x["title"].lower()))
    for path in CATALOGS:
        json.dump(merged, open(path, "w"), ensure_ascii=False, indent=2)
    print(f"\nMERGED catalog: {len(catalog)} -> {len(merged)} (+{len(keep)}). Written to both sources.json.")
    print("Final family breakdown:")
    for fam, n in Counter(s["family"] for s in merged).most_common():
        print(f"   {fam:22} {n}")

if __name__ == "__main__":
    main()
