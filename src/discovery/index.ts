// Owned by Wave 1 / Agent C (discovery).
// Resolves the list of pages to capture:
//   1. If cfg.pages is non-empty -> map those to PageTargets (absolute URLs).
//   2. Else select the first matching Profile and use it.
//   3. genericProfile.matches() === true is the guaranteed fallback (kept last).
// Always de-dupes by absolute URL and clamps the result to cfg.maxPages.
import type { BrowserContext } from 'playwright';
import type { RunConfig, PageTarget, Profile } from '../types';
import { huggingfaceProfile } from './profiles/huggingface';
import { genericProfile } from './profiles/generic';
import { expandSeeds } from './crawler';

/** Profile registry, in priority order. genericProfile MUST stay last. */
export const profiles: Profile[] = [huggingfaceProfile, genericProfile];

/** Readable slug from a URL path, e.g. /models/gpt2 -> "models-gpt2", / -> "home". */
function slugFromUrl(absUrl: string): string {
  let pathname = '/';
  try {
    pathname = new URL(absUrl).pathname;
  } catch {
    /* keep default */
  }
  const segs = pathname.split('/').filter(Boolean);
  if (segs.length === 0) return 'home';
  return (
    segs
      .join('-')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'home'
  );
}

export async function discoverPages(
  context: BrowserContext,
  cfg: RunConfig,
): Promise<PageTarget[]> {
  let targets: PageTarget[];
  // The generic profile already follows same-origin links (crawl()), so an extra
  // --sub-links expansion would be redundant there; curated profiles + explicit
  // --pages do NOT crawl, so they're the ones that need expansion.
  let didGenericCrawl = false;

  if (cfg.pages && cfg.pages.length > 0) {
    targets = cfg.pages.map((entry) => {
      const abs = new URL(entry, cfg.url).toString();
      return {
        url: abs,
        label: slugFromUrl(abs),
        category: 'pages',
      };
    });
  } else {
    const profile = profiles.find((p) => p.matches(cfg.url)) ?? genericProfile;
    targets = await profile.discover(context, cfg);
    didGenericCrawl = profile.name === genericProfile.name;
  }

  // De-duplicate seeds by absolute URL, keeping the first occurrence.
  const dedupeByUrl = (list: PageTarget[]): PageTarget[] => {
    const seen = new Set<string>();
    const out: PageTarget[] = [];
    for (const t of list) {
      if (seen.has(t.url)) continue;
      seen.add(t.url);
      out.push(t);
    }
    return out;
  };
  let deduped = dedupeByUrl(targets);

  // --sub-links: follow the same-origin links inside the seed pages and capture
  // them too (skipped for the generic profile, which already crawls links).
  if (cfg.subLinks && !didGenericCrawl) {
    const extra = await expandSeeds(context, deduped, cfg);
    deduped = dedupeByUrl([...deduped, ...extra]);
  }

  // Clamp to maxPages (backstop; profiles/crawler also respect it).
  return deduped.slice(0, cfg.maxPages);
}
