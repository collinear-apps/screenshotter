// VERIFY GATE — closed-loop fidelity scoring of a rebuild against the captured
// bundle. Re-captures each route from the rebuild with the SAME deterministic
// context used for capture, then scores it three ways:
//   • visual    — perceptual pixel diff vs the captured golden screenshot
//   • structural— accessibility-tree Dice similarity vs the captured .aria.yaml
//   • functional— the existing QC tasks (behavior + data-fidelity) run against it
// and emits one weighted fidelity score + verify-report.json. Best-effort per
// route; one bad route never aborts the run.
import { promises as fs } from 'fs';
import path from 'path';
import type {
  BundleIndex,
  Mode,
  QcTask,
  VerifyReport,
  VerifyRouteResult,
} from '../types';
import { buildRunConfig } from '../config';
import { launchSession, closeSession } from '../capture/browser';
import { preparePage } from '../capture/prepare';
import { captureScreenshot } from '../capture/screenshot';
import { captureA11y } from '../a11y/capture';
import { installClock, ANIM_CSS } from '../determinism';
import { flattenAria, scoreTrees } from '../a11y/diff';
import { runQcTasks } from '../qc/run';
import { sanitizeSegment } from '../output/naming';
import { pixelDiff } from './pixel';

export interface VerifyOptions {
  threshold: number;
  mode: Mode;
  maskSelectors?: string[];
  /** Cap routes verified (0 = all). Re-capturing is the slow part. */
  maxRoutes?: number;
}

/** Re-base a captured page URL onto the rebuild target's origin. */
function routeUrlFor(pageUrl: string, targetUrl: string): string {
  try {
    const target = new URL(targetUrl);
    try {
      const p = new URL(pageUrl);
      return new URL(p.pathname + p.search, target.origin).toString();
    } catch {
      return new URL(pageUrl, target.origin).toString();
    }
  } catch {
    return targetUrl;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
async function readJson<T>(p: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Resolve the mode dir inside a bundle (web/ | mobile/ | the dir itself). */
export async function resolveModeDir(bundleDir: string, mode: Mode): Promise<string | undefined> {
  const sub = path.join(bundleDir, mode);
  if (await isDir(sub)) return sub;
  const other: Mode = mode === 'web' ? 'mobile' : 'web';
  if (await isDir(path.join(bundleDir, other))) return path.join(bundleDir, other);
  if (await isDir(path.join(bundleDir, 'screenshots'))) return bundleDir;
  return undefined;
}

/** Weighted average over only the signals that are present (re-normalized). */
function weightedScore(parts: { value: number | undefined; weight: number }[]): number {
  let sum = 0;
  let w = 0;
  for (const p of parts) {
    if (typeof p.value === 'number' && !Number.isNaN(p.value)) {
      sum += p.value * p.weight;
      w += p.weight;
    }
  }
  return w > 0 ? sum / w : 0;
}

/**
 * Verify a rebuilt app (`targetUrl`) against a captured bundle. Returns a
 * VerifyReport and writes it + diff PNGs under `<modeDir>/verify/`.
 */
export async function runVerify(
  bundleDir: string,
  targetUrl: string,
  opts: VerifyOptions,
): Promise<VerifyReport> {
  const modeDir = await resolveModeDir(bundleDir, opts.mode);
  if (!modeDir) {
    throw new Error(`No bundle found at ${bundleDir} (expected a ${opts.mode}/ subdir or screenshots/).`);
  }

  const bundle = await readJson<BundleIndex>(path.join(modeDir, 'bundle.json'));
  let routes = bundle && Array.isArray(bundle.routes) ? bundle.routes : [];
  if (routes.length === 0) {
    throw new Error(`bundle.json has no routes under ${modeDir} — run a capture with --scaffold first.`);
  }
  if (opts.maxRoutes && opts.maxRoutes > 0) routes = routes.slice(0, opts.maxRoutes);

  const verifyDir = path.join(modeDir, 'verify');
  await fs.mkdir(verifyDir, { recursive: true });

  const cfg = buildRunConfig({ url: targetUrl, mode: opts.mode });
  const session = await launchSession(cfg);

  const results: VerifyRouteResult[] = [];
  try {
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      const goldenShot = r.screenshots && r.screenshots[0] ? path.join(modeDir, r.screenshots[0]) : undefined;
      const rebuildUrl = routeUrlFor(r.url, targetUrl);
      // Index-prefix the filename so distinct routes that slugify the same (e.g.
      // "Settings" vs "settings", or duplicate labels) can't overwrite each other's
      // actual/diff PNGs and mis-associate the report.
      const slug = `${String(i).padStart(3, '0')}-${sanitizeSegment(r.label || r.route || 'route')}`;
      const actualShot = path.join(verifyDir, 'actual', `${slug}.png`);

      let pixelScore: number | undefined;
      let a11yScore: number | undefined;
      let diffRel: string | undefined;
      let note: string | undefined;

      let page: Awaited<ReturnType<typeof session.context.newPage>> | undefined;
      try {
        page = await session.context.newPage();
        if (cfg.determinism?.enabled) await installClock(page, cfg);
        await preparePage(page, rebuildUrl);
        if (cfg.determinism?.enabled) await page.addStyleTag({ content: ANIM_CSS }).catch(() => {});
        await captureScreenshot(page, actualShot, opts.maskSelectors ?? []);

        // Visual.
        if (goldenShot) {
          const diffPath = path.join(verifyDir, 'diff', `${slug}.png`);
          const pd = await pixelDiff(goldenShot, actualShot, diffPath);
          if (pd) {
            pixelScore = pd.score;
            diffRel = path.relative(modeDir, diffPath).split(path.sep).join('/');
          }
        }

        // Structural (a11y).
        if (r.a11yGolden) {
          const goldenAria = await fs.readFile(path.join(modeDir, r.a11yGolden), 'utf8').catch(() => '');
          if (goldenAria) {
            try {
              const actual = await captureA11y(page);
              a11yScore = scoreTrees(flattenAria(goldenAria), flattenAria(actual.ariaYaml)).score;
            } catch {
              /* a11y best-effort */
            }
          }
        }
      } catch (err) {
        note = `recapture failed: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        if (page) await page.close().catch(() => {});
      }

      const score = weightedScore([
        { value: pixelScore, weight: 2 },
        { value: a11yScore, weight: 1 },
      ]);
      results.push({ route: r.route, url: r.url, pixelScore, diffPath: diffRel, a11yScore, score, note });
    }
  } finally {
    await closeSession(session);
  }

  // Functional — replay the captured QC tasks against the rebuild.
  let functional = { passed: 0, total: 0, rate: 1 };
  const tasks = await readJson<QcTask[]>(path.join(modeDir, 'qc', 'qc-tasks.json'));
  if (Array.isArray(tasks) && tasks.length > 0) {
    try {
      const qc = await runQcTasks(tasks, targetUrl, { threshold: opts.threshold, mode: opts.mode });
      const passed = qc.filter((q) => q.pass).length;
      functional = { passed, total: qc.length, rate: qc.length > 0 ? passed / qc.length : 1 };
    } catch {
      /* functional best-effort */
    }
  }

  const visualScores = results.map((r) => r.pixelScore).filter((v): v is number => typeof v === 'number');
  const structScores = results.map((r) => r.a11yScore).filter((v): v is number => typeof v === 'number');
  const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const visualAvg = avg(visualScores);
  const structAvg = avg(structScores);

  const overall = weightedScore([
    { value: visualScores.length ? visualAvg : undefined, weight: 2 },
    { value: structScores.length ? structAvg : undefined, weight: 1 },
    { value: functional.total ? functional.rate : undefined, weight: 1 },
  ]);

  const worst = [...results].sort((a, b) => a.score - b.score).slice(0, 10);

  // A gate must fail if ANY verifiable route is below the bar — not just on the
  // average. A route counts as failing when it produced a signal but scored low,
  // or when its re-capture failed outright.
  const failing = results.filter((r) =>
    r.pixelScore !== undefined || r.a11yScore !== undefined
      ? r.score < opts.threshold
      : Boolean(r.note),
  );

  const report: VerifyReport = {
    target: targetUrl,
    bundle: bundleDir,
    score: Number(overall.toFixed(4)),
    threshold: opts.threshold,
    pass: overall >= opts.threshold && failing.length === 0,
    visual: { avg: Number(visualAvg.toFixed(4)), routes: visualScores.length },
    structural: { avg: Number(structAvg.toFixed(4)), routes: structScores.length },
    functional,
    routes: results,
    worst,
  };

  await fs.writeFile(path.join(modeDir, 'verify-report.json'), JSON.stringify(report, null, 2), 'utf8');
  return report;
}
