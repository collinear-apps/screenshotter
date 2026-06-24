// Owned by Wave 1 / Agent I (real assets off the wire).
// createAssetCollector attaches a context 'response' listener that saves matching
// asset bodies (fonts/images/svg/css[/js]) to <outDir>/<mode>/assets/<category>/,
// deduped by URL, capped by maxAssetBytes, and records a manifest.
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { BrowserContext, Page, Response } from 'playwright';
import type {
  RunConfig,
  AssetManifestEntry,
  AssetTypes,
} from '../types';

export interface AssetCollector {
  /** Number of distinct assets saved so far. */
  count(): number;
  /** Await all in-flight body reads/writes. MUST be called before context.close(). */
  drain(): Promise<void>;
  /**
   * Scan a page's <head> for favicons / og:image / web-app-manifest icons and
   * fetch+save them (they're often never requested by the page itself, so the
   * passive response listener misses them). Best-effort; never throws. Call once
   * per captured page, BEFORE drain().
   */
  collectHeadAssets(page: Page): Promise<void>;
  /** Writes <mode>/assets/manifest.json. */
  writeManifest(): Promise<void>;
}

/** A parsed @font-face descriptor → the src URLs it binds. */
interface FontFaceRule {
  family?: string;
  weight?: string;
  style?: string;
  /** Absolute (or relative-resolved) src URLs referenced by this rule. */
  srcUrls: string[];
}

/** Strip CSS comments so the @font-face scanner doesn't trip on commented rules. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Parse @font-face blocks out of a CSS body, resolving each src url() against
 * `baseUrl` (the stylesheet's own URL). Returns one rule per block. Bounded by a
 * rule cap so a pathological stylesheet can't blow up. Never throws.
 */
function parseFontFaces(css: string, baseUrl: string, maxRules = 500): FontFaceRule[] {
  const out: FontFaceRule[] = [];
  try {
    const clean = stripCssComments(css);
    const blockRe = /@font-face\s*\{([^}]*)\}/gi;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(clean)) !== null && out.length < maxRules) {
      const body = m[1];
      const family = /font-family\s*:\s*([^;]+)/i
        .exec(body)?.[1]
        ?.trim()
        .replace(/^['"]|['"]$/g, '');
      const weight = /font-weight\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim();
      const style = /font-style\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim();
      const srcMatch = /src\s*:\s*([^;]+)/i.exec(body)?.[1] ?? '';
      const srcUrls: string[] = [];
      const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
      let u: RegExpExecArray | null;
      while ((u = urlRe.exec(srcMatch)) !== null) {
        const ref = u[2].trim();
        if (!ref || ref.startsWith('data:')) continue;
        try {
          srcUrls.push(new URL(ref, baseUrl).toString());
        } catch {
          /* ignore unresolvable url() */
        }
      }
      out.push({ family, weight, style, srcUrls });
    }
  } catch {
    /* best-effort */
  }
  return out;
}

type Category = keyof AssetTypes; // 'fonts' | 'images' | 'svg' | 'css' | 'js'

const FONT_EXTS = new Set(['.woff2', '.woff', '.ttf', '.otf', '.eot']);
const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.avif',
  '.bmp',
]);
const JS_EXTS = new Set(['.js', '.mjs', '.cjs']);

/** All extensions we recognize on a URL basename, mapped to a normalized ext. */
const KNOWN_EXTS = new Set<string>([
  ...FONT_EXTS,
  ...IMAGE_EXTS,
  ...JS_EXTS,
  '.svg',
  '.css',
]);

/** Lowercased path extension (incl. dot) from a URL path basename, or ''. */
function extFromUrl(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return '';
  }
  const base = pathname.split('/').pop() ?? '';
  const ext = path.extname(base).toLowerCase();
  return ext;
}

/** Last path segment of a URL, or '' on parse failure. */
function basenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    return pathname.split('/').pop() ?? '';
  } catch {
    return '';
  }
}

/** Normalize a raw content-type header to its media type (lowercase, no params). */
function mediaType(contentType: string | undefined): string {
  if (!contentType) return '';
  return contentType.split(';')[0].trim().toLowerCase();
}

/** Decide the asset category from content-type + URL ext, or null if none.
 *  SVG is checked before images so image/svg+xml / .svg don't fall into images. */
function categorize(contentType: string, ext: string): Category | null {
  const ct = mediaType(contentType);

  // fonts
  if (
    ct.startsWith('font/') ||
    ct.startsWith('application/font') ||
    FONT_EXTS.has(ext)
  ) {
    return 'fonts';
  }

  // svg (before images)
  if (ct === 'image/svg+xml' || ext === '.svg') {
    return 'svg';
  }

  // images (non-svg)
  if ((ct.startsWith('image/') && ct !== 'image/svg+xml') || IMAGE_EXTS.has(ext)) {
    return 'images';
  }

  // css
  if (ct === 'text/css' || ext === '.css') {
    return 'css';
  }

  // js
  if (ct.includes('javascript') || ct.includes('ecmascript') || JS_EXTS.has(ext)) {
    return 'js';
  }

  return null;
}

/** Map a content-type media type to a file extension (incl. dot). */
function extFromContentType(contentType: string): string {
  const ct = mediaType(contentType);
  const map: Record<string, string> = {
    'font/woff2': '.woff2',
    'font/woff': '.woff',
    'font/ttf': '.ttf',
    'font/otf': '.otf',
    'application/font-woff2': '.woff2',
    'application/font-woff': '.woff',
    'application/font-woff2;': '.woff2',
    'application/vnd.ms-fontobject': '.eot',
    'application/x-font-ttf': '.ttf',
    'application/x-font-otf': '.otf',
    'image/svg+xml': '.svg',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/bmp': '.bmp',
    'image/x-icon': '.ico',
    'image/vnd.microsoft.icon': '.ico',
    'text/css': '.css',
    'application/javascript': '.js',
    'text/javascript': '.js',
    'application/ecmascript': '.js',
    'application/x-javascript': '.js',
  };
  if (map[ct]) return map[ct];
  // Generic fallbacks for font/* and image/* subtypes.
  if (ct.startsWith('font/')) {
    const sub = ct.slice('font/'.length);
    if (sub) return `.${sub}`;
  }
  if (ct.startsWith('image/')) {
    const sub = ct.slice('image/'.length);
    if (sub && /^[a-z0-9]+$/.test(sub)) return `.${sub}`;
  }
  return '.bin';
}

/** Sanitize a URL basename into a filesystem-safe slug. */
function sanitizeBasename(basename: string): string {
  // Drop a trailing extension; we append our own normalized ext separately.
  let name = basename;
  const dot = name.lastIndexOf('.');
  if (dot > 0) name = name.slice(0, dot);
  name = name.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  // Collapse runs of separators that resulted from sanitizing.
  name = name.replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (name.length > 40) name = name.slice(0, 40);
  if (!name) name = 'asset';
  return name;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function createAssetCollector(
  context: BrowserContext,
  cfg: RunConfig,
  outDir: string,
): AssetCollector {
  const seen = new Set<string>();
  const pending: Promise<void>[] = [];
  const entries: AssetManifestEntry[] = [];
  // Captured CSS bodies (url + text) — scanned for @font-face at manifest time.
  const cssBodies: { url: string; text: string }[] = [];
  // Bound how much CSS text we retain so we never balloon memory on huge sites.
  const MAX_CSS_BYTES_FOR_FONTFACE = 4 * 1024 * 1024;
  let cssTextBudget = 0;

  const assetTypes: AssetTypes = cfg.extract?.assetTypes ?? {
    fonts: false,
    images: false,
    svg: false,
    css: false,
    js: false,
  };
  const maxBytes = cfg.extract?.maxAssetBytes ?? Number.POSITIVE_INFINITY;

  const assetsRoot = path.join(outDir, cfg.mode, 'assets');

  async function save(
    response: Response,
    url: string,
    category: Category,
    contentType: string,
  ): Promise<void> {
    try {
      const headers = response.headers();

      // Pre-check declared size before pulling the body.
      const lenHeader = headers['content-length'];
      if (lenHeader) {
        const declared = Number(lenHeader);
        if (Number.isFinite(declared) && declared > maxBytes) return;
      }

      let body: Buffer;
      try {
        body = await response.body();
      } catch {
        // redirects / 204 / aborted / streamed bodies throw — just skip.
        return;
      }

      if (body.byteLength > maxBytes) return;

      await persist(url, body, category, contentType);
    } catch {
      // NEVER throw from within a response handler's async work.
    }
  }

  /** Write a buffer to its category dir and record a manifest entry. */
  async function persist(
    url: string,
    body: Buffer,
    category: Category,
    contentType: string,
  ): Promise<void> {
    // Retain CSS text (bounded) so writeManifest can link @font-face → fonts.
    if (
      category === 'css' &&
      cssTextBudget + body.byteLength <= MAX_CSS_BYTES_FOR_FONTFACE
    ) {
      try {
        cssBodies.push({ url, text: body.toString('utf8') });
        cssTextBudget += body.byteLength;
      } catch {
        /* non-utf8 CSS — skip font-face linkage for it */
      }
    }

    // Determine extension: prefer a known ext on the URL basename, else
    // derive from content-type, else .bin.
    const urlExt = extFromUrl(url);
    const ext = KNOWN_EXTS.has(urlExt) ? urlExt : extFromContentType(contentType);

    const slug = sanitizeBasename(basenameFromUrl(url));
    const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
    const filename = `${slug}-${hash}${ext}`;

    const destDir = path.join(assetsRoot, category);
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, filename), body);

    // Relative path under outDir, forward slashes (e.g. web/assets/fonts/foo.woff2).
    const relFile = [cfg.mode, 'assets', category, filename].join('/');

    entries.push({
      url,
      file: relFile,
      contentType,
      bytes: body.byteLength,
      category,
    });
  }

  /**
   * Fetch one URL via the context's request API (shares cookies/UA/auth) and
   * persist it if it categorizes into an enabled asset type and is under the
   * size cap. Synchronously dedups against `seen`. Never throws.
   */
  async function fetchAndSave(url: string): Promise<void> {
    try {
      if (!/^https?:\/\//i.test(url)) return;
      if (seen.has(url)) return;
      seen.add(url);
      const res = await context.request.get(url, { timeout: 15000 });
      if (!res.ok()) return;
      const contentType = res.headers()['content-type'] ?? '';
      const ext = extFromUrl(url);
      const category = categorize(contentType, ext);
      if (!category || !assetTypes[category]) return;
      const lenHeader = res.headers()['content-length'];
      if (lenHeader) {
        const declared = Number(lenHeader);
        if (Number.isFinite(declared) && declared > maxBytes) return;
      }
      const body = await res.body();
      if (body.byteLength > maxBytes) return;
      await persist(url, body, category, contentType);
    } catch {
      // best-effort — a missing favicon / blocked manifest must never throw.
    }
  }

  const handler = (response: Response): void => {
    try {
      const url = response.url();

      // 1. Skip non-http(s) and data: URLs.
      if (!/^https?:\/\//i.test(url)) return;

      // 2. Dedup by URL synchronously (before any await).
      if (seen.has(url)) return;
      seen.add(url);

      // 3. Categorize from content-type + URL ext.
      const headers = response.headers();
      const contentType = headers['content-type'] ?? '';
      const ext = extFromUrl(url);
      const category = categorize(contentType, ext);
      if (!category) return;

      // Skip categories disabled in config.
      if (!assetTypes[category]) return;

      // 4. Track in-flight save so drain() can await it.
      pending.push(save(response, url, category, contentType));
    } catch {
      // Response handlers must never throw (unhandled rejection / crash).
    }
  };

  context.on('response', handler);

  /**
   * Backfill fontFamily/fontWeight/fontStyle onto saved font manifest entries by
   * matching their source URL against parsed @font-face src url()s. Runs once at
   * manifest time (after all CSS has been captured + drained). Idempotent.
   */
  function linkFontFaces(): void {
    if (cssBodies.length === 0) return;
    // Build url → descriptor map from every captured stylesheet.
    const byUrl = new Map<string, { family?: string; weight?: string; style?: string }>();
    for (const { url, text } of cssBodies) {
      for (const rule of parseFontFaces(text, url)) {
        for (const src of rule.srcUrls) {
          if (!byUrl.has(src)) {
            byUrl.set(src, { family: rule.family, weight: rule.weight, style: rule.style });
          }
        }
      }
    }
    if (byUrl.size === 0) return;
    for (const entry of entries) {
      if (entry.category !== 'fonts') continue;
      const desc = byUrl.get(entry.url);
      if (!desc) continue;
      if (desc.family) entry.fontFamily = desc.family;
      if (desc.weight) entry.fontWeight = desc.weight;
      if (desc.style) entry.fontStyle = desc.style;
    }
  }

  return {
    count: () => entries.length,
    drain: async () => {
      // A single allSettled over the captured set is sufficient: the pipeline
      // drains after all page work, so no new responses arrive mid-drain.
      await Promise.allSettled(pending);
    },
    collectHeadAssets: async (page: Page): Promise<void> => {
      let urls: string[] = [];
      try {
        urls = await page.evaluate(() => {
          const out: string[] = [];
          const push = (v: string | null | undefined): void => {
            if (v) out.push(v);
          };
          // Favicons + apple-touch icons + any rel containing "icon".
          document
            .querySelectorAll('link[rel~="icon"], link[rel~="apple-touch-icon"], link[rel="mask-icon"], link[rel="shortcut icon"]')
            .forEach((el) => push((el as HTMLLinkElement).href));
          // Open Graph / Twitter card images.
          document
            .querySelectorAll('meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]')
            .forEach((el) => {
              const c = (el as HTMLMetaElement).content;
              if (c) {
                try {
                  push(new URL(c, document.baseURI).toString());
                } catch {
                  /* ignore */
                }
              }
            });
          // The web-app manifest itself (its icons are resolved separately).
          document
            .querySelectorAll('link[rel="manifest"]')
            .forEach((el) => push((el as HTMLLinkElement).href));
          return out;
        });
      } catch {
        return; // page closed / evaluate failed — nothing to do
      }

      // Split manifests from direct image assets.
      const manifests: string[] = [];
      const direct: string[] = [];
      for (const u of urls) {
        if (/\.webmanifest(\?|$)/i.test(u) || /manifest\.json(\?|$)/i.test(u)) manifests.push(u);
        else direct.push(u);
      }

      // Fetch direct icon/og-image assets (these go through the normal pipeline).
      await Promise.allSettled(direct.map((u) => fetchAndSave(u)));

      // For each manifest: fetch it, resolve its icon entries, and save those.
      await Promise.allSettled(
        manifests.map(async (mUrl) => {
          if (seen.has(mUrl)) return;
          // Mark seen so we don't refetch; the manifest JSON itself isn't an asset.
          seen.add(mUrl);
          try {
            const res = await context.request.get(mUrl, { timeout: 15000 });
            if (!res.ok()) return;
            const json = (await res.json()) as { icons?: { src?: string }[] };
            const icons = Array.isArray(json?.icons) ? json.icons : [];
            const iconUrls: string[] = [];
            for (const icon of icons) {
              if (icon?.src) {
                try {
                  iconUrls.push(new URL(icon.src, mUrl).toString());
                } catch {
                  /* ignore */
                }
              }
            }
            await Promise.allSettled(iconUrls.map((u) => fetchAndSave(u)));
          } catch {
            /* best-effort */
          }
        }),
      );
    },
    writeManifest: async () => {
      linkFontFaces();
      await mkdir(assetsRoot, { recursive: true });
      const manifest = {
        generatedFrom: hostOf(cfg.url),
        count: entries.length,
        assets: entries,
      };
      await writeFile(
        path.join(assetsRoot, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
      );
    },
  };
}
