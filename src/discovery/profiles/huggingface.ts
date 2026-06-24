// Owned by Wave 1 / Agent C (discovery).
import type { BrowserContext, Page } from 'playwright';
import type { Profile, RunConfig, PageTarget } from '../../types';

const HF = 'https://huggingface.co';

/** Section prefixes that are NOT model/user detail pages. */
const SECTION_PREFIXES =
  /^(models|datasets|spaces|organizations|join|login|pricing|docs|blog|settings|new|notifications|search|tasks|posts|enterprise|chat|api|inference|collections|papers)$/i;

/**
 * Open an index page, read its anchors, and return the first absolute URL whose
 * pathname matches `hrefPattern` and isn't the index page itself.
 * Best-effort: always closes the page; returns null on any failure.
 */
async function firstLink(
  context: BrowserContext,
  indexUrl: string,
  hrefPattern: RegExp,
): Promise<string | null> {
  let page: Page | undefined;
  try {
    page = await context.newPage();
    await page.goto(indexUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(
        (a) => (a as HTMLAnchorElement).href,
      ),
    );

    let indexPath = '';
    try {
      indexPath = new URL(indexUrl).pathname.replace(/\/$/, '');
    } catch {
      /* ignore */
    }

    for (const href of hrefs) {
      let u: URL;
      try {
        u = new URL(href);
      } catch {
        continue;
      }
      if (u.hostname !== 'huggingface.co') continue;
      const p = u.pathname.replace(/\/$/, '');
      if (p === indexPath) continue;
      if (hrefPattern.test(u.pathname)) {
        return `${HF}${u.pathname}`;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Owner/name pattern under a fixed section, e.g. /datasets/<owner>/<name>. */
function detailUnder(section: string): RegExp {
  return new RegExp(`^/${section}/[^/]+/[^/]+/?$`);
}

/**
 * Model/user detail pattern: /<owner>/<name> where <owner> is not a known
 * section prefix. We test the owner segment against SECTION_PREFIXES in code
 * (a plain RegExp test is run via a wrapper below).
 */
function isModelDetailPath(pathname: string): boolean {
  const m = pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
  if (!m) return false;
  if (SECTION_PREFIXES.test(m[1])) return false;
  return true;
}

export const huggingfaceProfile: Profile = {
  name: 'huggingface',
  matches: (url: string): boolean => {
    try {
      const host = new URL(url).hostname;
      return host === 'huggingface.co' || host.endsWith('.huggingface.co');
    } catch {
      return false;
    }
  },
  discover: async (
    context: BrowserContext,
    cfg: RunConfig,
  ): Promise<PageTarget[]> => {
    const targets: PageTarget[] = [];

    // Resolve dynamic representatives best-effort, in parallel where independent.
    const modelsIndex = `${HF}/models`;
    const datasetsIndex = `${HF}/datasets`;
    const spacesIndex = `${HF}/spaces`;
    const leaderboardsIndex = `${HF}/spaces?category=leaderboard`;

    // firstLink for a model detail page: an owner/name pair whose first segment
    // is NOT a known section. The negative lookahead is essential — without it
    // firstLink would commit to the first two-segment link in the DOM (often a
    // nav link like /docs/hub) and then get rejected, yielding no model detail.
    const modelDetailPattern =
      /^\/(?!(?:models|datasets|spaces|organizations|join|login|pricing|docs|blog|settings|new|notifications|search|tasks|posts|enterprise|chat|api|inference|collections|papers)\/)[^/]+\/[^/]+\/?$/;

    const [
      modelDetail,
      datasetDetail,
      spaceDetail,
      leaderboardDetail,
    ] = await Promise.all([
      firstLink(context, modelsIndex, modelDetailPattern).then((u) =>
        u && isModelDetailPath(new URL(u).pathname) ? u : null,
      ),
      firstLink(context, datasetsIndex, detailUnder('datasets')),
      firstLink(context, spacesIndex, detailUnder('spaces')),
      firstLink(context, leaderboardsIndex, detailUnder('spaces')),
    ]);

    // Profile: derive an author from a model detail link if we have one.
    let profileUrl: string | null = null;
    if (modelDetail) {
      try {
        const owner = new URL(modelDetail).pathname.split('/').filter(Boolean)[0];
        if (owner && !SECTION_PREFIXES.test(owner)) {
          profileUrl = `${HF}/${owner}`;
        }
      } catch {
        /* ignore */
      }
    }
    if (!profileUrl) profileUrl = `${HF}/julien-c`;

    // ── Build the target list (index pages + dynamic details). ──
    targets.push({ url: `${HF}/`, label: 'home', category: 'Home' });

    targets.push({ url: modelsIndex, label: 'models-index', category: 'Models' });
    if (modelDetail) {
      targets.push({ url: modelDetail, label: 'models-detail', category: 'Models' });
    }

    targets.push({
      url: datasetsIndex,
      label: 'datasets-index',
      category: 'Datasets',
    });
    if (datasetDetail) {
      targets.push({
        url: datasetDetail,
        label: 'datasets-detail',
        category: 'Datasets',
      });
    }

    targets.push({ url: spacesIndex, label: 'spaces-index', category: 'Spaces' });
    if (spaceDetail) {
      targets.push({ url: spaceDetail, label: 'spaces-detail', category: 'Spaces' });
    }

    targets.push({
      url: leaderboardsIndex,
      label: 'leaderboards-index',
      category: 'Leaderboards',
    });
    if (leaderboardDetail) {
      targets.push({
        url: leaderboardDetail,
        label: 'leaderboards-detail',
        category: 'Leaderboards',
      });
    }

    targets.push({
      url: `${HF}/organizations`,
      label: 'organizations-index',
      category: 'Organizations',
    });
    targets.push({
      url: `${HF}/huggingface`,
      label: 'organizations-detail',
      category: 'Organizations',
    });

    targets.push({
      url: profileUrl,
      label: 'profiles-detail',
      category: 'Profiles',
    });

    // ── Auth-gated seeds (Phase 3) ──────────────────────────────────────────
    // Only meaningful when a session is supplied — these routes 401/redirect to
    // /login anonymously, so they're added ONLY when cfg.auth is present. They
    // capture the logged-in surfaces a functional twin needs (account settings,
    // notifications, the repo Files tree, the dataset viewer). Added BEFORE the
    // maxPages slice so they compete fairly for the page budget.
    if (cfg.auth) {
      targets.push({ url: `${HF}/settings/profile`, label: 'settings-profile', category: 'Settings' });
      targets.push({ url: `${HF}/settings/tokens`, label: 'settings-tokens', category: 'Settings' });
      targets.push({ url: `${HF}/notifications`, label: 'notifications', category: 'Account' });
      targets.push({ url: `${HF}/new`, label: 'new-repo', category: 'Account' });

      // Repo Files tab tree (the "tree/main" view) — prefer the model we found.
      if (modelDetail) {
        try {
          const repoPath = new URL(modelDetail).pathname.replace(/\/$/, '');
          targets.push({
            url: `${HF}${repoPath}/tree/main`,
            label: 'models-files-tree',
            category: 'Models',
          });
        } catch {
          /* ignore malformed model URL */
        }
      }

      // Dataset viewer (the embedded data-preview surface) for the found dataset.
      if (datasetDetail) {
        try {
          const dsPath = new URL(datasetDetail).pathname.replace(/\/$/, '');
          targets.push({
            url: `${HF}${dsPath}/viewer`,
            label: 'datasets-viewer',
            category: 'Datasets',
          });
        } catch {
          /* ignore malformed dataset URL */
        }
      }
    }

    return targets.slice(0, cfg.maxPages);
  },
};
