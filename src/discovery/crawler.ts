// Owned by Wave 1 / Agent C (discovery).
// Bounded BFS same-origin crawl: visited Set, respects cfg.maxPages and cfg.depth.
// Categorizes each target by first path segment ('root' for top-level pages).
import type { BrowserContext, Page } from 'playwright';
import type { RunConfig, PageTarget } from '../types';

/** File extensions we never want to enqueue/screenshot. */
export const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|zip|gz|tar|pdf|mp4|webm|mp3|wav|woff2?|ttf|eot|map|txt|rss|atom)$/i;

/**
 * Tracking / view-source query params that don't change the page — stripping them
 * for dedup stops the SAME page from being captured N times (e.g. Notion's
 * `?pvs=28` / `?pvs=11`, or `utm_*` campaign tags) and wasting the page budget.
 */
const TRACKING_PARAMS = new Set([
  'pvs', 'ref', 'ref_', 'referrer', 'source', 'gclid', 'fbclid', 'msclkid',
  'yclid', 'mc_cid', 'mc_eid', 'igshid', '_ga', '_gl', '_hsenc', '_hsmi', 'spm',
]);

/** Remove tracking params (utm_* + the known set) from a query in place. */
function stripTrackingParams(params: URLSearchParams): void {
  for (const k of [...params.keys()]) {
    const lk = k.toLowerCase();
    if (lk.startsWith('utm_') || TRACKING_PARAMS.has(lk)) params.delete(k);
  }
}

/**
 * Normalize a URL for dedup purposes: strip trailing slash and collapse default
 * index documents so "/" and "/index.html" (etc.) resolve to the same page.
 * Query is preserved (kept consistent everywhere).
 *
 * Hash routes: a bare fragment (`#section`, `#`) is dropped, but a HASH-ROUTER
 * fragment (`#/route`, `#!/route`) is a DISTINCT SPA route and is preserved so
 * `/app#/users` and `/app#/settings` don't collapse to one page. Only the
 * router-style `#/…` / `#!/…` forms are kept; in-page anchors are still stripped.
 */
export function normalize(raw: string): string | null {
  try {
    const u = new URL(raw);
    // Preserve hash-router fragments (#/route, #!/route); strip plain anchors.
    const isRoute = /^#!?\//.test(u.hash);
    if (!isRoute) u.hash = '';
    // Collapse default index documents to their containing directory.
    u.pathname = u.pathname.replace(/\/index\.(?:html?|php|aspx?)$/i, '/');
    // Drop tracking/view-source params and sort the rest so query-only variants
    // of the same page (?pvs=28 vs ?pvs=11 vs none) collapse to one.
    stripTrackingParams(u.searchParams);
    u.searchParams.sort();
    let s = u.toString();
    if (isRoute) {
      // Strip a trailing slash on the PATH portion only, leaving the fragment.
      const hashIdx = s.indexOf('#');
      const head = s.slice(0, hashIdx);
      const tail = s.slice(hashIdx);
      const trimmedHead = head.endsWith('/') ? head.slice(0, -1) : head;
      return trimmedHead + tail;
    }
    // Strip a single trailing slash (but keep the root "https://host/" sane).
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

/**
 * Fetch a same-origin text resource (sitemap/robots) via a throwaway page's
 * request API — reuses the context's cookies/UA/auth and never throws. Returns
 * the body text or null. Bounded by a short timeout + a size guard.
 */
async function fetchText(
  context: BrowserContext,
  url: string,
  maxBytes = 5 * 1024 * 1024,
): Promise<string | null> {
  try {
    const res = await context.request.get(url, { timeout: 15000 });
    if (!res.ok()) return null;
    const lenHeader = res.headers()['content-length'];
    if (lenHeader) {
      const declared = Number(lenHeader);
      if (Number.isFinite(declared) && declared > maxBytes) return null;
    }
    const body = await res.text();
    if (body.length > maxBytes) return body.slice(0, maxBytes);
    return body;
  } catch {
    return null;
  }
}

/**
 * Extract same-origin page URLs from sitemap.xml + robots.txt for seeding.
 *
 * - sitemap.xml: pulls every <loc>…</loc>; follows nested <sitemapindex> entries
 *   ONE level deep (bounded by `maxSitemaps`) so sitemap-index sites still work.
 * - robots.txt: pulls `Sitemap:` directives (fetched + parsed like a sitemap)
 *   and `Allow:`/`Disallow:` paths (resolved against the origin) as weak hints.
 *
 * Returns absolute, same-origin, non-asset URLs (capped by `cap`). Best-effort:
 * any fetch/parse failure yields fewer (or zero) URLs, never throws.
 */
async function ingestSitemap(
  context: BrowserContext,
  baseUrl: string,
  origin: string,
  cap: number,
): Promise<string[]> {
  const out = new Set<string>();
  const maxSitemaps = 8;
  let sitemapsFetched = 0;

  const sameOriginNonAsset = (raw: string): string | null => {
    let parsed: URL;
    try {
      parsed = new URL(raw, baseUrl);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.hostname !== origin) return null;
    if (ASSET_EXT.test(parsed.pathname)) return null;
    return normalize(parsed.toString());
  };

  // Pull <loc> values from a sitemap body. Returns {pages, nested} where nested
  // are child sitemap URLs (from <sitemapindex>).
  const parseSitemapBody = (xml: string): { locs: string[]; nested: string[] } => {
    const locs: string[] = [];
    const nested: string[] = [];
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const loc = m[1].trim();
      if (isIndex) nested.push(loc);
      else locs.push(loc);
    }
    return { locs, nested };
  };

  const fetchSitemap = async (url: string, allowNested: boolean): Promise<void> => {
    if (sitemapsFetched >= maxSitemaps || out.size >= cap) return;
    sitemapsFetched++;
    const xml = await fetchText(context, url);
    if (!xml) return;
    const { locs, nested } = parseSitemapBody(xml);
    for (const loc of locs) {
      if (out.size >= cap) return;
      const n = sameOriginNonAsset(loc);
      if (n) out.add(n);
    }
    if (allowNested) {
      for (const child of nested) {
        if (sitemapsFetched >= maxSitemaps || out.size >= cap) return;
        // Only follow same-origin child sitemaps (no asset filter — it's XML).
        let childUrl: URL;
        try {
          childUrl = new URL(child, baseUrl);
        } catch {
          continue;
        }
        if (childUrl.hostname !== origin) continue;
        await fetchSitemap(childUrl.toString(), false); // one level deep only
      }
    }
  };

  let originRoot: string;
  try {
    originRoot = new URL(baseUrl).origin;
  } catch {
    return [];
  }

  // 1. robots.txt → Sitemap: directives + Allow/Disallow path hints.
  const robots = await fetchText(context, `${originRoot}/robots.txt`);
  const sitemapUrls = new Set<string>([`${originRoot}/sitemap.xml`]);
  if (robots) {
    for (const line of robots.split(/\r?\n/)) {
      const sm = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
      if (sm) {
        try {
          const u = new URL(sm[1], originRoot);
          if (u.hostname === origin) sitemapUrls.add(u.toString());
        } catch {
          /* ignore */
        }
        continue;
      }
      const rule = line.match(/^\s*(?:allow|disallow)\s*:\s*(\S+)/i);
      if (rule) {
        const pathPart = rule[1];
        // Skip wildcards/globs — they're patterns, not concrete pages.
        if (pathPart === '/' || pathPart.includes('*') || pathPart.includes('$')) continue;
        const n = sameOriginNonAsset(pathPart);
        if (n) out.add(n);
      }
    }
  }

  // 2. Fetch each discovered sitemap (root + robots-declared), one level deep.
  for (const sm of sitemapUrls) {
    if (out.size >= cap || sitemapsFetched >= maxSitemaps) break;
    await fetchSitemap(sm, true);
  }

  return Array.from(out).slice(0, cap);
}

/**
 * Mint pagination / "load more" capture targets from a set of base page URLs.
 *
 * For each base URL we synthesize a second-page variant by adding the first
 * matching paginator the site is likely to honor: an existing `?page=N` /
 * `?p=N` / `?offset=` param is bumped, otherwise we append `?page=2`. This lets
 * the capture exercise list pagination (table page 2, infinite-scroll "load
 * more" routes that proxy to `?page=`) without needing live click-through.
 *
 * Returns NEW normalized URLs only (never the inputs), capped by `cap`. Purely
 * synthetic + same-origin; the crawler/caller still de-dupes against real pages.
 */
function mintPaginationTargets(
  baseUrls: string[],
  origin: string,
  cap: number,
): string[] {
  const out = new Set<string>();
  const KNOWN = ['page', 'p', 'offset'];

  for (const raw of baseUrls) {
    if (out.size >= cap) break;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.hostname !== origin) continue;
    if (ASSET_EXT.test(u.pathname)) continue;

    const next = new URL(u.toString());
    let bumped = false;
    for (const key of KNOWN) {
      if (next.searchParams.has(key)) {
        const cur = Number(next.searchParams.get(key));
        if (key === 'offset') {
          next.searchParams.set(key, String(Number.isFinite(cur) ? cur + 20 : 20));
        } else {
          next.searchParams.set(key, String(Number.isFinite(cur) ? cur + 1 : 2));
        }
        bumped = true;
        break;
      }
    }
    if (!bumped) {
      // No existing paginator → assume `?page=2` (the most common convention).
      next.searchParams.set('page', '2');
    }
    const n = normalize(next.toString());
    if (n && n !== normalize(raw)) out.add(n);
  }

  return Array.from(out).slice(0, cap);
}

/**
 * Seed extra discovery URLs from sitemap/robots (when cfg.useSitemap) and mint
 * pagination targets (when cfg.paginate). Returns PageTargets ready to merge
 * with profile/crawl output; the caller de-dupes by URL. Best-effort + bounded
 * by cfg.maxPages. No-op (empty array) when both flags are off.
 *
 * `existing` lets the caller pass already-known targets so pagination can be
 * minted off real list pages (and so we don't re-mint duplicates).
 */
export async function seedFromSitemapAndPagination(
  context: BrowserContext,
  cfg: RunConfig,
  existing: PageTarget[] = [],
): Promise<PageTarget[]> {
  let origin: string;
  try {
    origin = new URL(cfg.url).hostname;
  } catch {
    return [];
  }

  const cap = Math.max(0, cfg.maxPages);
  const out: PageTarget[] = [];
  const seen = new Set<string>();
  for (const t of existing) {
    const n = normalize(t.url);
    if (n) seen.add(n);
  }

  const push = (url: string): void => {
    if (out.length + existing.length >= cap) return;
    const n = normalize(url);
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push({ url: n, label: slugFromUrl(n), category: categoryFromUrl(n) });
  };

  // 1. Sitemap / robots ingestion.
  if (cfg.useSitemap) {
    const urls = await ingestSitemap(context, cfg.url, origin, cap);
    for (const u of urls) push(u);
  }

  // 2. Pagination minting off the known + freshly-seeded list pages.
  if (cfg.paginate) {
    const bases = [
      ...existing.map((t) => t.url),
      ...out.map((t) => t.url),
    ];
    const minted = mintPaginationTargets(bases, origin, cap);
    for (const u of minted) push(u);
  }

  return out;
}

/** Readable slug from a URL path, e.g. /models/gpt2 -> "models-gpt2", / -> "home". */
function slugFromUrl(raw: string): string {
  let pathname = '/';
  try {
    pathname = new URL(raw).pathname;
  } catch {
    /* keep default */
  }
  const segs = pathname.split('/').filter(Boolean);
  if (segs.length === 0) return 'home';
  return segs
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'home';
}

/** First non-empty path segment as category, or 'root' for top-level pages. */
function categoryFromUrl(raw: string): string {
  try {
    const segs = new URL(raw).pathname.split('/').filter(Boolean);
    return segs.length > 0 ? segs[0] : 'root';
  } catch {
    return 'root';
  }
}

/**
 * Let a client-rendered SPA paint before we read its links. At `domcontentloaded`
 * a React/Next.js dashboard's <a href> nav doesn't exist yet — so without this the
 * crawler discovers only the entry page. Best-effort; never throws.
 */
async function settleForLinks(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
}

export async function crawl(
  context: BrowserContext,
  cfg: RunConfig,
): Promise<PageTarget[]> {
  const start = normalize(cfg.url);
  if (!start) return [];

  let origin: string;
  try {
    origin = new URL(cfg.url).hostname;
  } catch {
    return [];
  }

  const visited = new Set<string>();
  const queued = new Set<string>([start]);
  const queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];
  const targets: PageTarget[] = [];

  // Seed extra entry points from sitemap.xml / robots.txt (Phase 3). These join
  // the BFS frontier at depth 0 so the crawler still bounds + follows them.
  if (cfg.useSitemap) {
    const seeded = await seedFromSitemapAndPagination(context, cfg, [{ url: start, label: 'home' }]);
    for (const t of seeded) {
      const n = normalize(t.url);
      if (!n || queued.has(n)) continue;
      queued.add(n);
      queue.push({ url: n, depth: 0 });
    }
  }

  while (queue.length > 0 && targets.length < cfg.maxPages) {
    const { url, depth } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    let page: Page | undefined;
    let hrefs: string[] = [];
    try {
      page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // This page loaded successfully -> it's a real target.
      targets.push({
        url,
        label: slugFromUrl(url),
        category: categoryFromUrl(url),
      });

      // Only extract links if we'd still follow them (depth budget remains).
      if (depth < cfg.depth) {
        // Let client-rendered SPAs (Next.js/React dashboards) paint their nav
        // BEFORE reading links — at domcontentloaded the <a href>s don't exist yet,
        // which is why a SPA would otherwise discover only the entry page.
        await settleForLinks(page);
        hrefs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]')).map(
            (a) => (a as HTMLAnchorElement).href,
          ),
        );
      }
    } catch (err) {
      // Navigation/extraction failed: skip this page. Surface the START page's
      // failure (depth 0) loudly — otherwise a bot-walled / unreachable entry URL
      // silently becomes "No pages found", which looks like a tool bug. The error
      // (e.g. ERR_HTTP2_PROTOCOL_ERROR, timeout) tells the user it's the site.
      if (depth === 0) {
        const m = err instanceof Error ? err.message.split('\n')[0] : String(err);
        console.error(`  Could not load ${url}: ${m}`);
      }
    } finally {
      if (page) {
        try {
          await page.close();
        } catch {
          /* ignore close errors */
        }
      }
    }

    if (targets.length >= cfg.maxPages) break;
    if (depth >= cfg.depth) continue;

    for (const href of hrefs) {
      // Skip non-http(s) and obvious asset/file links.
      let parsed: URL;
      try {
        parsed = new URL(href);
      } catch {
        continue;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      if (parsed.hostname !== origin) continue;
      if (ASSET_EXT.test(parsed.pathname)) continue;

      const norm = normalize(href);
      if (!norm) continue;
      if (visited.has(norm) || queued.has(norm)) continue;

      queued.add(norm);
      queue.push({ url: norm, depth: depth + 1 });
    }
  }

  return targets.slice(0, cfg.maxPages);
}

/**
 * Navigate to `url` and return its `a[href]` list, or `null` if navigation
 * failed (so callers can distinguish "load failed" from "no links"). Always
 * closes the page.
 */
async function harvestLinks(
  context: BrowserContext,
  url: string,
): Promise<string[] | null> {
  let page: Page | undefined;
  try {
    page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await settleForLinks(page); // let SPA nav render before reading links
    return await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(
        (a) => (a as HTMLAnchorElement).href,
      ),
    );
  } catch {
    return null;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        /* ignore close errors */
      }
    }
  }
}

/**
 * `--sub-links`: expand a curated profile's seed pages by following the
 * same-origin links INSIDE them. Multi-source BFS starting from every seed
 * (seeds themselves are never re-captured); children inherit their parent's
 * `category` so they cluster under the right section. Returns ONLY the newly
 * discovered sub-page targets (the caller appends + de-dupes).
 *
 * Bounded by `cfg.maxPages` (global, counting the seeds), `cfg.depth` (link
 * hops from a seed), and `cfg.maxSubLinksPerPage` (fan-out per page). Same
 * origin + asset-extension filters keep it on-site; `visited`/`queued` kill
 * cycles. Failed navigations are skipped, never fatal.
 */
export async function expandSeeds(
  context: BrowserContext,
  seeds: PageTarget[],
  cfg: RunConfig,
): Promise<PageTarget[]> {
  if (!Array.isArray(seeds) || seeds.length === 0) return [];

  let origin: string;
  try {
    origin = new URL(cfg.url).hostname;
  } catch {
    return [];
  }

  const cap = Math.max(0, cfg.maxPages);
  const perPage = Math.max(1, cfg.maxSubLinksPerPage);

  const visited = new Set<string>();
  const queued = new Set<string>();
  // Seed the dedupe sets with every seed URL so seeds are never re-captured.
  for (const s of seeds) {
    const n = normalize(s.url);
    if (n) {
      visited.add(n);
      queued.add(n);
    }
  }

  const queue: { url: string; depth: number; category?: string }[] = [];
  const newTargets: PageTarget[] = [];

  // Bounded enqueue of same-origin, non-asset, http(s) children.
  const enqueueChildren = (
    hrefs: string[],
    depth: number,
    category: string | undefined,
  ): void => {
    let added = 0;
    for (const href of hrefs) {
      if (added >= perPage) break;
      let parsed: URL;
      try {
        parsed = new URL(href);
      } catch {
        continue;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      if (parsed.hostname !== origin) continue;
      if (ASSET_EXT.test(parsed.pathname)) continue;

      const norm = normalize(href);
      if (!norm || visited.has(norm) || queued.has(norm)) continue;

      queued.add(norm);
      queue.push({ url: norm, depth, category });
      added++;
    }
  };

  // Pass 1: harvest links from each seed (depth 0) → enqueue children at depth 1,
  // inheriting the seed's category. Seeds are NOT added as targets here.
  for (const s of seeds) {
    if (seeds.length + newTargets.length >= cap) break;
    const hrefs = await harvestLinks(context, s.url);
    if (hrefs) enqueueChildren(hrefs, 1, s.category);
  }

  // Pass 2: BFS over discovered sub-pages, each a real capture target.
  while (queue.length > 0 && seeds.length + newTargets.length < cap) {
    const { url, depth, category } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    const hrefs = await harvestLinks(context, url);
    if (hrefs === null) continue; // navigation failed — skip this page entirely

    newTargets.push({ url, label: slugFromUrl(url), category });

    if (seeds.length + newTargets.length >= cap) break;
    if (depth >= cfg.depth) continue;
    enqueueChildren(hrefs, depth + 1, category);
  }

  return newTargets;
}
