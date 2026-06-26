// Owned by Wave 1 / Agent A (CLI + orchestration).
// Orchestrates: launch browser -> discover pages -> capture (concurrency-limited,
// per-page screenshot + typography) -> aggregate typography -> write typography.md
// -> zip. Tolerates per-page failures and prints a summary.
import path from 'path';
import { promises as fs } from 'fs';
import pc from 'picocolors';
import type {
  ApiSummary,
  CaptureResult,
  Logger,
  PageTarget,
  PageTokens,
  PageTypography,
  RunConfig,
  RunResult,
} from './types';
import { launchSession, launchSessionForVariant, closeSession } from './capture/browser';
import { settlePage } from './capture/prepare';
import { gotoWithRetry, detectAuthState } from './capture/retry';
import { buildManifest, writeManifest } from './output/manifest';
import { captureScreenshot } from './capture/screenshot';
import { interactForApi } from './capture/interact';
import { installClock, ANIM_CSS } from './determinism';
import { captureDom, extractReadme } from './extract/dom';
import { captureA11y } from './a11y/capture';
import { normalizeHtml } from './extract/normalize';
import {
  extractTokens,
  aggregateTokens,
  renderTokensJson,
  renderTokensMd,
  extractCssVars,
  aggregateCssVars,
  renderCssVarsJson,
} from './extract/tokens';
import type { PageCssVars } from './extract/tokens';
import { extractListings } from './extract/listings';
import { buildEntityGraph } from './extract/entities';
import { captureLayout } from './extract/layout';
import { captureSurfaces } from './extract/surfaces';
import { captureElementStates } from './extract/elementStates';
import { renderRebuildPrompt } from './prompt/generate';
import type { PromptPageInfo } from './prompt/generate';
import type {
  ApiFixture,
  BehaviorBundle,
  Breakpoint,
  ColorScheme,
  DesignTokens,
  EntityGraph,
  ExploreResult,
  ListingExtract,
  RouteAuthState,
  RouteCaptureRecord,
} from './types';
import { buildBehaviors } from './explore/behaviors';
import { buildAllQcTasks, renderQcMd } from './qc/generate';
import { assembleRouteArtifacts, buildBundleIndex, writeBundleIndex, writeBundleMd } from './output/bundle';
import { emitScaffold } from './scaffold';
import { explorePage } from './explore/engine';
import { createDownloadSink } from './explore/downloads';
import type { DownloadSink } from './explore/downloads';
import {
  renderGraphJson,
  renderInteractionsMd,
  renderBehaviorsSection,
} from './explore/report';
import { sanitizeSegment } from './output/naming';
import { performFormLogin } from './auth/formLogin';
import { harTempPath, processApiArtifacts } from './api';
import { discoverPages } from './discovery';
import { normalize as normalizeUrl, ASSET_EXT } from './discovery/crawler';
import { extractTypography } from './typography/extract';
import { aggregateTypography } from './typography/aggregate';
import { renderTypographyMarkdown } from './typography/report';
import { ensureCleanOutDir, writeTypographyFile, createZip } from './output/zip';
import { screenshotRelPath, slugForUrl } from './output/naming';
import { pLimit } from './util/limit';
import { createProgress, fmtDuration, bar } from './util/progress';

/** Default logger writes progress to stdout (CLI behavior). */
const defaultLogger: Logger = { info: (msg: string) => console.log(msg) };

/** A target paired with its pre-assigned absolute output path. */
interface PlannedCapture {
  target: PageTarget;
  absPath: string;
}

/**
 * Assigns deterministic screenshot paths BEFORE capturing so concurrent tasks
 * never race on filenames. Targets are grouped by category (preserving
 * discovery order) and indexed 1-based within each category.
 */
function planCaptures(targets: PageTarget[], cfg: RunConfig): PlannedCapture[] {
  const categoryCounts = new Map<string, number>();
  const planned: PlannedCapture[] = [];

  for (const target of targets) {
    const category = target.category ?? 'pages';
    const index = (categoryCounts.get(category) ?? 0) + 1;
    categoryCounts.set(category, index);
    const relPath = screenshotRelPath(cfg.mode, category, index, target.url);
    const absPath = path.join(cfg.outDir, relPath);
    planned.push({ target, absPath });
  }

  return planned;
}

export async function run(
  cfg: RunConfig,
  logger: Logger = defaultLogger,
): Promise<RunResult> {
  logger.info(
    pc.bold(pc.cyan(`\nscreenshotter `)) +
      pc.dim(`→ ${cfg.url} `) +
      pc.dim(`(${cfg.mode})`),
  );

  await ensureCleanOutDir(cfg.outDir);

  const session = await launchSession(cfg);
  let results: CaptureResult[] = [];
  let noPages = false;
  const pageTokensList: PageTokens[] = [];
  const cssVarsList: PageCssVars[] = [];
  const listingExtracts: ListingExtract[] = [];
  let domPages = 0;
  let a11yCount = 0;
  const exploreResults: ExploreResult[] = [];
  let exploreSink: DownloadSink | undefined;
  // Hoisted so the bundle/QC/scaffold steps (after the capture try/finally) can see them.
  let targets: PageTarget[] = [];
  let entityGraph: EntityGraph | undefined;
  let behaviorBundle: BehaviorBundle | undefined;
  // Phase 0 — capture integrity: per-route manifest records + single-flight re-auth.
  const startedAtISO = new Date().toISOString();
  const routeRecords: RouteCaptureRecord[] = [];
  let reauthInFlight: Promise<void> | null = null;
  // Total screenshots written across all passes (for the summary).
  let variantShots = 0;
  try {
    // 0. Form login (once) when configured and no saved session is in use.
    if (cfg.auth?.formLogin && !cfg.auth.storageState) {
      logger.info(pc.dim('Authenticating (form login)…'));
      await performFormLogin(session.context, cfg.auth.formLogin, logger);
    }

    // 1. Discover targets.
    targets = await discoverPages(session.context, cfg);
    if (targets.length === 0) {
      logger.info(pc.yellow('No pages found to capture. Nothing to do.'));
      noPages = true;
    } else {
      logger.info(pc.green(`Found ${targets.length} page(s) to capture.`));

      // 2. Pre-assign deterministic output paths.
      const planned = planCaptures(targets, cfg);

      // 3. Capture concurrently with a limiter.
      const limit = pLimit(cfg.concurrency);
      let done = 0;
      const total = planned.length;

      const captureOne = async (item: PlannedCapture): Promise<CaptureResult> => {
        const { target, absPath } = item;
        // newPage() is inside the try so a launch failure is reported as a normal
        // per-page failure (counted + logged) instead of rejecting Promise.all
        // and aborting the whole run with sibling pages still open.
        let page: Awaited<ReturnType<typeof session.context.newPage>> | undefined;
        try {
          page = await session.context.newPage();
          // Freeze the clock BEFORE navigation so Date/timers are stable.
          if (cfg.determinism?.enabled) await installClock(page, cfg);
          // Phase 0: navigate with bounded retry/backoff + per-host politeness,
          // then run the post-goto settle steps.
          const gr = await gotoWithRetry(page, target.url, cfg.capture, 'load');
          await settlePage(page);

          // Phase 0: detect mid-crawl session expiry; single-flight re-auth + reload.
          let authState: RouteAuthState = 'unknown';
          if (cfg.capture.detectAuthExpiry) {
            authState = await detectAuthState(page).catch(() => 'unknown' as RouteAuthState);
            const canReauth =
              cfg.capture.reauth && Boolean(cfg.auth?.formLogin) && !cfg.auth?.storageState;
            if (authState === 'anonymous' && canReauth) {
              if (!reauthInFlight) {
                reauthInFlight = performFormLogin(session.context, cfg.auth!.formLogin!, logger)
                  .then(() => {})
                  .catch(() => {});
              }
              await reauthInFlight;
              await gotoWithRetry(page, target.url, cfg.capture, 'load');
              await settlePage(page);
              authState = await detectAuthState(page).catch(() => 'unknown' as RouteAuthState);
            }
          }

          // Kill animations/transitions for a stable frame.
          if (cfg.determinism?.enabled) {
            await page.addStyleTag({ content: ANIM_CSS }).catch(() => {});
          }
          await captureScreenshot(page, absPath, cfg.determinism?.maskSelectors ?? []);
          const typography = await extractTypography(page, target.url);

          // Source-material extraction (DOM + tokens) — BEFORE interaction so the
          // dumped DOM matches the screenshot's state.
          if (cfg.extract?.enabled && cfg.extract.dom) {
            const html = await captureDom(page, cfg.extract).catch(() => '');
            if (html) {
              const htmlPath = absPath.replace(/\.png$/i, '.html');
              await fs.writeFile(htmlPath, html, 'utf8').catch(() => {});
              if (cfg.extract.normalize) {
                await fs
                  .writeFile(
                    absPath.replace(/\.png$/i, '.normalized.html'),
                    normalizeHtml(html),
                    'utf8',
                  )
                  .catch(() => {});
              }
              domPages++;
            }
            // README/markdown content (raw + rendered) from detail pages.
            if (cfg.extract.readme) {
              const rd = await extractReadme(page, cfg.extract).catch(() => null);
              if (rd) {
                await fs
                  .writeFile(absPath.replace(/\.png$/i, '.readme.json'), JSON.stringify(rd, null, 2), 'utf8')
                  .catch(() => {});
              }
            }
          }
          if (cfg.extract?.enabled && cfg.extract.tokens) {
            const t = await extractTokens(page).catch(() => null);
            if (t) pageTokensList.push(t);
          }
          if (cfg.extract?.enabled && cfg.extract.cssVars) {
            const v = await extractCssVars(page).catch(() => null);
            if (v) cssVarsList.push(v);
          }
          // Structured listing rows (real records, not just a screenshot).
          if (cfg.extract?.enabled && cfg.extract.listings) {
            const le = await extractListings(page, target.label, target.url).catch(() => null);
            if (le) {
              listingExtracts.push(le);
              const lDir = path.join(cfg.outDir, cfg.mode, 'extract', 'listings');
              await fs.mkdir(lDir, { recursive: true }).catch(() => {});
              await fs
                .writeFile(path.join(lDir, `${sanitizeSegment(target.label)}.json`), JSON.stringify(le, null, 2), 'utf8')
                .catch(() => {});
            }
          }
          if (cfg.extract?.enabled && cfg.extract.a11y) {
            try {
              const a = await captureA11y(page);
              await fs.writeFile(
                absPath.replace(/\.png$/i, '.a11y.json'),
                JSON.stringify(a.axJson, null, 2),
                'utf8',
              );
              await fs.writeFile(
                absPath.replace(/\.png$/i, '.aria.yaml'),
                a.ariaYaml,
                'utf8',
              );
              a11yCount++;
            } catch {
              // best-effort: a11y capture must not fail the page
            }
          }

          // Save <head> assets (favicons / og-image / manifest icons) while open.
          if (cfg.extract?.enabled && cfg.extract.assets) {
            await session.collector?.collectHeadAssets(page).catch(() => {});
          }

          // Tier-3 per-page passes. Paths derive from the unique per-page absPath,
          // so concurrent captures never collide. Read-only passes (layout/surfaces)
          // run BEFORE element-states (which drives hover/focus/active and mutates
          // interaction state) — and all run AFTER the clean screenshot.
          const baseNoExt = absPath.replace(/\.png$/i, '');
          const modeRoot = path.join(cfg.outDir, cfg.mode);
          const relOf = (abs: string): string => path.relative(modeRoot, abs).split(path.sep).join('/');
          if (cfg.extract?.enabled && cfg.extract.layout) {
            const rep = await captureLayout(page, target.label, target.url).catch(() => null);
            if (rep && rep.boxes.length > 0) {
              await fs.writeFile(`${baseNoExt}.layout.json`, JSON.stringify(rep, null, 2), 'utf8').catch(() => {});
            }
          }
          if (cfg.extract?.enabled && cfg.extract.surfaces) {
            const absDir = `${baseNoExt}-surfaces`;
            const rep = await captureSurfaces(page, target.label, target.url, {
              absDir,
              relBase: relOf(absDir),
            }).catch(() => null);
            if (rep && (rep.surfaces.length > 0 || (rep.webComponents && rep.webComponents.length > 0))) {
              await fs.writeFile(`${baseNoExt}.surfaces.json`, JSON.stringify(rep, null, 2), 'utf8').catch(() => {});
            }
          }
          if (cfg.extract?.enabled && cfg.extract.elementStates) {
            const absDir = `${baseNoExt}-states`;
            const rep = await captureElementStates(page, target.label, target.url, {
              absDir,
              relBase: relOf(absDir),
              cfg: cfg.extract,
            }).catch(() => null);
            if (rep && rep.elements.length > 0) {
              await fs.writeFile(`${baseNoExt}.element-states.json`, JSON.stringify(rep, null, 2), 'utf8').catch(() => {});
            }
          }

          // Provoke first-party API calls AFTER capture (visuals/DOM stay clean).
          if (cfg.api?.enabled && cfg.api.interact) {
            await interactForApi(page, cfg, logger);
          }
          const result: CaptureResult = {
            target,
            screenshotPath: absPath,
            ok: true,
            typography,
          };
          routeRecords.push({
            url: target.url,
            label: target.label,
            category: target.category,
            ok: true,
            status: gr.status,
            authState,
            retries: gr.retries,
          });
          done++;
          logger.info(
            pc.green(`  ✓ [${done}/${total}] `) +
              `${target.label} ` +
              pc.dim(target.url),
          );
          return result;
        } catch (err) {
          done++;
          const message = err instanceof Error ? err.message : String(err);
          logger.info(
            pc.red(`  ✗ [${done}/${total}] `) +
              `${target.label} ` +
              pc.dim(`${target.url} — ${message}`),
          );
          routeRecords.push({
            url: target.url,
            label: target.label,
            category: target.category,
            ok: false,
            error: String(err),
            authState: 'unknown',
          });
          return { target, ok: false, error: String(err) };
        } finally {
          if (page) await page.close().catch(() => {});
        }
      };

      results = await Promise.all(
        planned.map((item) => limit(() => captureOne(item))),
      );

      // 4. Aggregate typography from successful captures.
      const typographies: PageTypography[] = results
        .filter((r): r is CaptureResult & { typography: PageTypography } =>
          Boolean(r.ok && r.typography),
        )
        .map((r) => r.typography);

      const agg = aggregateTypography(typographies);
      const md = renderTypographyMarkdown(agg, cfg.siteName);
      const typographyPath = await writeTypographyFile(cfg.outDir, cfg.mode, md);
      logger.info(pc.dim(`Typography written → ${typographyPath}`));

      // 4b. Full interaction exploration — runs pages CONCURRENTLY (shared global
      //     action budget), while the context is open (traffic feeds HAR/assets).
      if (cfg.explore?.enabled) {
        const okTargets = results.filter((x) => x.ok);
        const nPages = okTargets.length;
        const budgetTotal = cfg.explore.maxActions;
        logger.info(
          pc.bold(
            cfg.explore.aggressive
              ? pc.red('Exploring (AGGRESSIVE — may mutate data)…')
              : pc.cyan('Exploring interactions…'),
          ),
        );
        exploreSink = createDownloadSink(cfg, cfg.outDir);

        // Live progress bar on a TTY; plain per-page lines otherwise (pipes/MCP).
        const useBar = Boolean((process.stdout as NodeJS.WriteStream).isTTY);
        const progress = createProgress(process.stdout);
        const startedAt = Date.now();
        let pagesDone = 0;
        let active = 0;
        let totalActions = 0;
        const draw = () => {
          if (!useBar) return;
          const elapsed = Date.now() - startedAt;
          const eta =
            pagesDone > 0
              ? ((elapsed / pagesDone) * (nPages - pagesDone)) /
                Math.max(1, cfg.concurrency)
              : 0;
          progress.render(
            pc.cyan(`  exploring ${pagesDone}/${nPages}`) +
              (active > 0 ? pc.dim(` (${active} running)`) : '') +
              ` · ${bar(totalActions / budgetTotal)} ${totalActions}/${budgetTotal}` +
              ` · ${fmtDuration(elapsed)}` +
              (pagesDone > 0 ? ` · ETA ~${fmtDuration(eta)}` : ''),
          );
        };
        const logAround = (line: string) => {
          progress.done();
          logger.info(line);
        };

        const env = {
          outDir: cfg.outDir,
          budget: { remaining: cfg.explore.maxActions },
          sink: exploreSink,
          onProgress: () => {
            totalActions++;
            draw();
          },
        };

        const limit = pLimit(cfg.concurrency);
        let budgetNoted = false;
        await Promise.all(
          okTargets.map((r) =>
            limit(async () => {
              if (env.budget.remaining <= 0) {
                if (!budgetNoted) {
                  budgetNoted = true;
                  logAround(
                    pc.yellow(
                      `Action budget (${budgetTotal}) exhausted — skipping remaining pages.`,
                    ),
                  );
                }
                return;
              }
              active++;
              draw();
              try {
                const er = await explorePage(session.context, r.target, cfg, logger, env);
                exploreResults.push(er);
                pagesDone++;
                if (!useBar) {
                  logger.info(
                    pc.dim(
                      `  explored [${pagesDone}/${nPages}] ${r.target.label}: ${er.actions.length} actions`,
                    ),
                  );
                }
              } catch (err) {
                pagesDone++;
                const m = err instanceof Error ? err.message : String(err);
                logAround(pc.yellow(`  explore failed: ${r.target.label} — ${m}`));
              } finally {
                active--;
                draw();
              }
            }),
          ),
        );
        progress.done(
          useBar
            ? pc.green(`  explored ${pagesDone}/${nPages} page(s) · ${totalActions} actions`)
            : undefined,
        );

        // 4d. Capture pages discovered via EXPLORATION — SPA / clickable-div
        //     navigations the anchor-based crawler can't reach (e.g. Notion's
        //     sidebar tree). Every explorer click that changed the URL was recorded
        //     as a 'navigation'; promote those same-origin destinations to real
        //     captured pages (full screenshot + extract), deduped + budget-capped.
        let exploreOrigin = '';
        try {
          exploreOrigin = new URL(cfg.url).hostname;
        } catch {
          /* keep empty */
        }
        const have = new Set<string>();
        for (const p of planned) {
          const n = normalizeUrl(p.target.url);
          if (n) have.add(n);
        }
        const discovered: PageTarget[] = [];
        const seenDisc = new Set<string>();
        for (const er of exploreResults) {
          for (const a of er.actions) {
            if (a.outcome !== 'navigation' || !a.toUrl) continue;
            let u: URL;
            try {
              u = new URL(a.toUrl);
            } catch {
              continue;
            }
            if (u.hostname !== exploreOrigin) continue;
            if (ASSET_EXT.test(u.pathname)) continue;
            const key = normalizeUrl(a.toUrl);
            if (!key || have.has(key) || seenDisc.has(key)) continue;
            seenDisc.add(key);
            discovered.push({ url: key, label: slugForUrl(key), category: 'explored' });
          }
        }
        const budget = Math.max(0, cfg.maxPages - planned.length);
        const toCapture = discovered.slice(0, budget);
        if (toCapture.length > 0) {
          logger.info(
            pc.cyan(`Capturing ${toCapture.length} page(s) discovered via exploration…`),
          );
          const plannedExtra = planCaptures(toCapture, cfg);
          const extraResults = await Promise.all(
            plannedExtra.map((item) => limit(() => captureOne(item))),
          );
          results = results.concat(extraResults);
        }
      }

      // Finish reading any in-flight asset/API bodies BEFORE the context closes.
      if (session.collector) await session.collector.drain().catch(() => {});
      if (session.apiBodies) await session.apiBodies.drain().catch(() => {});
    }
  } finally {
    // Close the context FIRST so Playwright flushes the recorded HAR to disk
    // before we parse it.
    await closeSession(session);
  }

  if (noPages) {
    // Drop any HAR Playwright may have flushed (nothing to pair it with).
    if (cfg.api?.enabled) {
      await fs.rm(harTempPath(cfg.outDir), { force: true }).catch(() => {});
    }
    return { outDir: cfg.outDir, captured: 0, failed: 0, results: [] };
  }

  // 4c. Extra responsive / color-scheme variants (Phase 3) — screenshot-only passes
  //     in fully isolated contexts so the primary capture/API/explore flow is
  //     untouched. The list is empty by default (one breakpoint × light), so a
  //     default run does ZERO extra work here.
  {
    const variantList: { bp: Breakpoint; scheme: ColorScheme }[] = [];
    for (const bp of cfg.breakpoints) {
      for (const scheme of cfg.colorSchemes) variantList.push({ bp, scheme });
    }
    const extraVariants = variantList.slice(1); // index 0 = primary (already captured)
    if (extraVariants.length > 0) {
      const planned = planCaptures(targets, cfg);
      for (const { bp, scheme } of extraVariants) {
        const suffix = `@${bp.name}${scheme === 'dark' ? '-dark' : ''}`;
        let vSession: Awaited<ReturnType<typeof launchSessionForVariant>> | undefined;
        try {
          vSession = await launchSessionForVariant(cfg, bp, scheme);
        } catch (err) {
          logger.info(pc.yellow(`Variant ${suffix} launch failed: ${String(err)}`));
          continue;
        }
        const session2 = vSession;
        const vlimit = pLimit(cfg.concurrency);
        let vdone = 0;
        try {
          await Promise.all(
            planned.map((item) =>
              vlimit(async () => {
                const vpath = item.absPath.replace(/\.png$/i, `${suffix}.png`);
                let page: Awaited<ReturnType<typeof session2.context.newPage>> | undefined;
                try {
                  page = await session2.context.newPage();
                  if (cfg.determinism?.enabled) await installClock(page, cfg);
                  const gr = await gotoWithRetry(page, item.target.url, cfg.capture, 'load');
                  await settlePage(page);
                  if (cfg.determinism?.enabled) {
                    await page.addStyleTag({ content: ANIM_CSS }).catch(() => {});
                  }
                  await captureScreenshot(page, vpath, cfg.determinism?.maskSelectors ?? []);
                  routeRecords.push({
                    url: item.target.url,
                    label: item.target.label,
                    category: item.target.category,
                    breakpoint: bp.name,
                    ok: true,
                    status: gr.status,
                    authState: 'unknown',
                  });
                  vdone++;
                } catch (err) {
                  routeRecords.push({
                    url: item.target.url,
                    label: item.target.label,
                    category: item.target.category,
                    breakpoint: bp.name,
                    ok: false,
                    error: String(err),
                    authState: 'unknown',
                  });
                } finally {
                  if (page) await page.close().catch(() => {});
                }
              }),
            ),
          );
        } finally {
          await closeSession(session2);
        }
        variantShots += vdone;
        logger.info(pc.dim(`Variant ${suffix}: ${vdone}/${planned.length} screenshot(s)`));
      }
    }
  }

  // 5. API artifacts — AFTER the context is closed so the HAR is complete.
  //    Best-effort: a failure here must not sink the screenshots/zip.
  let apiSummary: ApiSummary | undefined;
  let apiFixtures: ApiFixture[] = [];
  if (cfg.api?.enabled) {
    try {
      const apiResult = await processApiArtifacts(
        harTempPath(cfg.outDir),
        cfg,
        logger,
        session.apiBodies,
      );
      apiSummary = apiResult.summary;
      apiFixtures = apiResult.fixtures;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.info(pc.yellow(`API capture failed: ${message}`));
    }
  }

  // 5b. Extraction artifacts: design tokens + asset manifest.
  let assetCount: number | undefined;
  let designTokens: DesignTokens | undefined;
  if (cfg.extract?.enabled) {
    if (cfg.extract.tokens) {
      try {
        designTokens = aggregateTokens(pageTokensList);
        const dir = path.join(cfg.outDir, cfg.mode);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          path.join(dir, 'design-tokens.json'),
          renderTokensJson(designTokens),
          'utf8',
        );
        await fs.writeFile(
          path.join(dir, 'design-tokens.md'),
          renderTokensMd(designTokens, cfg.siteName),
          'utf8',
        );
        logger.info(pc.dim('Design tokens written → design-tokens.json / .md'));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.info(pc.yellow(`Design tokens failed: ${message}`));
      }
    }
    if (cfg.extract.cssVars && cssVarsList.length > 0) {
      try {
        const dir = path.join(cfg.outDir, cfg.mode);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          path.join(dir, 'css-vars.json'),
          renderCssVarsJson(aggregateCssVars(cssVarsList)),
          'utf8',
        );
        logger.info(pc.dim('CSS custom properties written → css-vars.json'));
      } catch (err) {
        logger.info(pc.yellow(`CSS vars failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    if (session.collector) {
      try {
        await session.collector.writeManifest();
        assetCount = session.collector.count();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.info(pc.yellow(`Asset manifest failed: ${message}`));
      }
    }
  }

  // 5b1. Entity/relationship graph — normalized seed data for a stateful twin,
  //      built from captured API JSON + listing rows. Also feeds data-fidelity QC.
  if (cfg.extract?.enabled && cfg.extract.entities && (apiFixtures.length > 0 || listingExtracts.length > 0)) {
    try {
      entityGraph = buildEntityGraph({ fixtures: apiFixtures, listings: listingExtracts, baseUrl: cfg.url });
      const dir = path.join(cfg.outDir, cfg.mode);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'entity-graph.json'), JSON.stringify(entityGraph, null, 2), 'utf8');
      logger.info(
        pc.dim(
          `Entity graph: ${entityGraph.entities.length} entit(ies), ${entityGraph.relationships.length} relationship(s)`,
        ),
      );
    } catch (err) {
      logger.info(pc.yellow(`Entity graph failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // 5b2. Exploration artifacts: per-page state graph + aggregate behavioral spec
  //      + downloads manifest. (Per-action screenshots/DOM were written live.)
  let actionCount: number | undefined;
  let downloadCount: number | undefined;
  let behaviors: string | undefined;
  let qcTaskCount = 0;
  if (cfg.explore?.enabled) {
    try {
      const exploreDir = path.join(cfg.outDir, cfg.mode, 'explore');
      for (const er of exploreResults) {
        const pageDir = path.join(exploreDir, sanitizeSegment(er.pageLabel));
        await fs.mkdir(pageDir, { recursive: true });
        await fs.writeFile(path.join(pageDir, 'graph.json'), renderGraphJson(er), 'utf8');
      }
      if (exploreResults.length > 0) {
        await fs.mkdir(exploreDir, { recursive: true });
        await fs.writeFile(
          path.join(exploreDir, 'interactions.md'),
          renderInteractionsMd(exploreResults, cfg.siteName),
          'utf8',
        );
        behaviors = renderBehaviorsSection(exploreResults);

        // Machine-readable behavior contract (QC tasks are built below, so the
        // data-fidelity + coverage gate runs even on non-explore runs).
        try {
          behaviorBundle = buildBehaviors(exploreResults, apiFixtures);
          await fs.writeFile(
            path.join(exploreDir, 'behaviors.json'),
            JSON.stringify(behaviorBundle, null, 2),
            'utf8',
          );
          logger.info(pc.dim(`Behaviors: ${behaviorBundle.features.length} feature(s)`));
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          logger.info(pc.yellow(`Behaviors failed: ${m}`));
        }
      }
      actionCount = exploreResults.reduce((n, er) => n + er.actions.length, 0);
      if (exploreSink) {
        await exploreSink.writeManifest();
        downloadCount = exploreSink.count();
      }
      logger.info(
        pc.green(
          `Explore: ${actionCount} action(s), ${downloadCount ?? 0} download(s) → ${path.join(cfg.mode, 'explore')}/`,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.info(pc.yellow(`Explore artifacts failed: ${message}`));
    }
  }

  // 5b3. Functional QC gate — behavior + data-fidelity + coverage tasks. Built
  //      whenever we have behaviors, fixtures, or targets (not only with --full),
  //      so "functional done" means "captured data renders", not "a request fired".
  let bundleIndexPath: string | undefined;
  // Only when there's functional substance (behaviors or API fixtures) — a plain
  // screenshot run stays clean (no qc/ dir). Coverage tasks ride along via targets.
  if (behaviorBundle || apiFixtures.length > 0) {
    try {
      const tasks = buildAllQcTasks({
        behaviors: behaviorBundle,
        fixtures: apiFixtures,
        targets,
        listings: listingExtracts,
        entityGraph,
      });
      qcTaskCount = tasks.length;
      if (tasks.length > 0) {
        const qcDir = path.join(cfg.outDir, cfg.mode, 'qc');
        await fs.mkdir(qcDir, { recursive: true });
        await fs.writeFile(path.join(qcDir, 'qc-tasks.json'), JSON.stringify(tasks, null, 2), 'utf8');
        await fs.writeFile(path.join(qcDir, 'qc-tasks.md'), renderQcMd(tasks, cfg.siteName), 'utf8');
        logger.info(pc.dim(`QC tasks: ${tasks.length} (incl. data-fidelity + coverage)`));
      }
    } catch (err) {
      logger.info(pc.yellow(`QC tasks failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // 5b4. Runnable handoff — bundle.json spine + frontend scaffold (included in zip).
  if (cfg.scaffold) {
    try {
      const routeArtifacts = assembleRouteArtifacts({
        results,
        mode: cfg.mode,
        outDir: cfg.outDir,
        hasDom: Boolean(cfg.extract?.enabled && cfg.extract.dom && domPages > 0),
        hasA11y: Boolean(cfg.extract?.enabled && cfg.extract.a11y && a11yCount > 0),
        fixtures: apiFixtures.map((f) => ({ file: f.file, pathTemplate: f.pathTemplate, url: f.url })),
        behaviors: behaviorBundle,
      });
      const index = buildBundleIndex(cfg.siteName, cfg.url, routeArtifacts, {
        fixtures: apiFixtures.map((f) => `api/fixtures/${f.file}`),
        mockServer: apiFixtures.length > 0 ? 'api/mock/server.mjs' : undefined,
        entityGraph: entityGraph ? 'entity-graph.json' : undefined,
      });
      const scaffoldRes = await emitScaffold({
        bundleDir: path.join(cfg.outDir, cfg.mode),
        mode: cfg.mode,
        cfg,
        index,
        apiHosts: apiSummary?.hosts ?? [],
        tokens: designTokens,
      });
      if (scaffoldRes.files.length > 0) index.scaffold = 'scaffold';
      bundleIndexPath = await writeBundleIndex(cfg.outDir, cfg.mode, index);
      await writeBundleMd(cfg.outDir, cfg.mode, index);
      logger.info(
        pc.dim(`Bundle index + scaffold → bundle.json / index.md / scaffold/ (${scaffoldRes.files.length} files)`),
      );
    } catch (err) {
      logger.info(pc.yellow(`Bundle/scaffold failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // 5c. Rebuild prompt — a self-contained spec referencing every artifact, so the
  //     zip can be handed to Claude to one-shot a faithful rebuild.
  if (cfg.prompt?.enabled) {
    try {
      const modeDir = path.join(cfg.outDir, cfg.mode);
      const rel = (abs: string) =>
        path.relative(modeDir, abs).split(path.sep).join('/');
      const pages: PromptPageInfo[] = results
        .filter((r) => r.ok && r.screenshotPath)
        .map((r) => {
          const screenshot = rel(r.screenshotPath as string);
          return {
            label: r.target.label,
            url: r.target.url,
            category: r.target.category,
            screenshot,
            dom:
              cfg.extract?.enabled && cfg.extract.dom
                ? screenshot.replace(/\.png$/i, '.html')
                : undefined,
          };
        });
      const viewport =
        cfg.mode === 'mobile'
          ? 'iPhone 13 (390×844 @3×)'
          : '1440×900 @2× (desktop retina)';
      const md = renderRebuildPrompt({
        siteName: cfg.siteName,
        url: cfg.url,
        mode: cfg.mode,
        viewport,
        pages,
        tokens: designTokens,
        hasTypography: true,
        apiSummary,
        apiHosts: apiSummary?.hosts,
        assetCount,
        domCount: domPages,
        stack: cfg.prompt.stack,
        behaviors,
        fixtures: apiFixtures.length,
        qcTasks: qcTaskCount,
        hasScaffold: cfg.scaffold === true,
        hasBundleIndex: Boolean(bundleIndexPath),
        mockBase: 'http://localhost:8787',
      });
      await fs.mkdir(modeDir, { recursive: true });
      await fs.writeFile(path.join(modeDir, 'REBUILD-PROMPT.md'), md, 'utf8');
      logger.info(pc.dim('Rebuild prompt written → REBUILD-PROMPT.md'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.info(pc.yellow(`Rebuild prompt failed: ${message}`));
    }
  }

  // 5d. Run manifest — what was (and wasn't) captured: per-route ok/authState/
  //     retries + degradation notes. Cheap + always useful for a large crawl.
  let manifestPath: string | undefined;
  if (routeRecords.length > 0) {
    try {
      const manifest = buildManifest(cfg.siteName, cfg.mode, startedAtISO, routeRecords);
      manifestPath = await writeManifest(cfg.outDir, cfg.mode, manifest);
      const anon = manifest.totals.anonymous;
      logger.info(
        pc.dim(
          `Run manifest → run-manifest.json (${routeRecords.length} routes` +
            (anon > 0 ? `, ${anon} anonymous` : '') +
            ')',
        ),
      );
    } catch (err) {
      logger.info(pc.yellow(`Manifest failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // 6. Zip LAST so it includes screenshots + typography + tokens + assets + api/.
  let zipPath: string | undefined;
  if (cfg.zip) {
    zipPath = await createZip(cfg.outDir, cfg.siteName);
    logger.info(pc.green(`Zip created → ${zipPath}`));
  }

  // 7. Final summary.
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  logger.info(pc.bold('\nSummary'));
  logger.info(`  ${pc.green(`${succeeded.length} captured`)}, ${
    failed.length > 0 ? pc.red(`${failed.length} failed`) : pc.dim('0 failed')
  }`);
  if (failed.length > 0) {
    logger.info(pc.red('  Failed URLs:'));
    for (const f of failed) {
      logger.info(pc.red(`    - ${f.target.url}`));
    }
  }
  logger.info(`  Output dir: ${pc.cyan(cfg.outDir)}`);
  // Total screenshots written: one per captured page + breakpoint/dark variants +
  // per-interaction-state shots from the explorer.
  const pageShots = succeeded.filter((r) => r.screenshotPath).length;
  const exploreShots = exploreResults.reduce(
    (n, er) => n + er.actions.filter((a) => a.screenshot).length,
    0,
  );
  const totalShots = pageShots + variantShots + exploreShots;
  logger.info(
    `  Screenshots: ${pc.cyan(String(totalShots))} ` +
      pc.dim(
        `(${pageShots} page` +
          (variantShots > 0 ? `, ${variantShots} responsive/dark` : '') +
          (exploreShots > 0 ? `, ${exploreShots} interaction-state` : '') +
          `) → ${path.join(cfg.mode, 'screenshots')}/`,
      ),
  );
  if (apiSummary) {
    logger.info(
      `  API: ${pc.cyan(
        `${apiSummary.calls} call(s), ${apiSummary.endpoints} endpoint(s)`,
      )}`,
    );
  }
  if (cfg.extract?.enabled) {
    logger.info(
      `  Extract: ${pc.cyan(
        `${domPages} DOM, ${assetCount ?? 0} asset(s), ${a11yCount} a11y`,
      )}`,
    );
  }
  if (cfg.explore?.enabled) {
    logger.info(
      `  Explore: ${pc.cyan(
        `${actionCount ?? 0} action(s), ${downloadCount ?? 0} download(s)`,
      )}`,
    );
  }
  if (zipPath) {
    logger.info(`  Zip: ${pc.cyan(zipPath)}`);
  }

  return {
    outDir: cfg.outDir,
    zipPath,
    captured: succeeded.length,
    failed: failed.length,
    results,
    api: apiSummary,
    assets: assetCount,
    domPages: cfg.extract?.enabled ? domPages : undefined,
    a11y: cfg.extract?.enabled ? a11yCount : undefined,
    actions: actionCount,
    downloads: downloadCount,
    bundleIndexPath,
    manifestPath,
    screenshots: totalShots,
  };
}
