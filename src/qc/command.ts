// Owned by Wave 1 / Agent C (qc command).
// runQc: load a bundle's behaviors (or regenerate from graph.json), write
// qc/qc-tasks.{md,json}; with run+target, execute and gate (exit code).
import { promises as fs } from 'fs';
import path from 'path';
import pc from 'picocolors';
import type {
  ApiFixture,
  BehaviorBundle,
  EntityGraph,
  ExploreResult,
  ListingExtract,
  Mode,
} from '../types';
import { buildBehaviors } from '../explore/behaviors';
import { buildAllQcTasks, renderQcMd } from './generate';
import { runQcTasks } from './run';

export interface QcCommandOptions {
  run: boolean;
  target?: string;
  threshold: number;
  mode: Mode;
  json: boolean;
}

/** True if `p` is an existing directory. */
async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** True if `p` is an existing file. */
async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the mode directory inside a bundle. A bundle dir may contain
 * `web/`/`mobile/` subdirs, or it may already BE the mode dir (containing
 * `explore/` or `qc/`). Returns the resolved mode dir, or undefined when none
 * can be found.
 */
async function resolveModeDir(bundleDir: string, mode: Mode): Promise<string | undefined> {
  // Prefer the mode-matching subdir if it exists.
  const modeSub = path.join(bundleDir, mode);
  if (await isDir(modeSub)) return modeSub;

  // Fall back to the other mode subdir if present.
  const other: Mode = mode === 'web' ? 'mobile' : 'web';
  const otherSub = path.join(bundleDir, other);
  if (await isDir(otherSub)) return otherSub;

  // Otherwise assume bundleDir IS the mode dir — confirm via explore/ or qc/.
  if ((await isDir(path.join(bundleDir, 'explore'))) || (await isDir(path.join(bundleDir, 'qc')))) {
    return bundleDir;
  }

  return undefined;
}

/** Read + parse a JSON file, returning undefined on any error. */
async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Reconstruct ExploreResult[] from every graph.json under `<modeDir>/explore/`.
 * Each graph.json already carries `{ pageLabel, baseUrl, actions, states }`.
 */
async function loadGraphs(exploreDir: string): Promise<ExploreResult[]> {
  const results: ExploreResult[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(exploreDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const graphPath = path.join(exploreDir, entry, 'graph.json');
    if (!(await isFile(graphPath))) continue;
    const graph = await readJson<{
      pageLabel?: string;
      baseUrl?: string;
      actions?: unknown;
      states?: number;
    }>(graphPath);
    if (!graph) continue;
    results.push({
      pageLabel: graph.pageLabel ?? entry,
      baseUrl: graph.baseUrl ?? '',
      actions: Array.isArray(graph.actions) ? (graph.actions as ExploreResult['actions']) : [],
      states: typeof graph.states === 'number' ? graph.states : 0,
    });
  }

  return results;
}

/**
 * Load the behavior bundle for a mode dir: prefer a pre-built
 * `explore/behaviors.json`, else regenerate from graph.json files. Returns
 * undefined when neither source exists.
 */
async function loadBehaviors(modeDir: string): Promise<BehaviorBundle | undefined> {
  const exploreDir = path.join(modeDir, 'explore');
  const behaviorsPath = path.join(exploreDir, 'behaviors.json');

  const prebuilt = await readJson<BehaviorBundle>(behaviorsPath);
  if (prebuilt && typeof prebuilt === 'object') {
    return {
      features: Array.isArray(prebuilt.features) ? prebuilt.features : [],
      routes: Array.isArray(prebuilt.routes) ? prebuilt.routes : [],
    };
  }

  if (await isDir(exploreDir)) {
    const results = await loadGraphs(exploreDir);
    if (results.length > 0) {
      return buildBehaviors(results, []);
    }
  }

  return undefined;
}

/** Load captured API fixtures from `<modeDir>/api/fixtures/*.json` (best-effort). */
async function loadFixtures(modeDir: string): Promise<ApiFixture[]> {
  const dir = path.join(modeDir, 'api', 'fixtures');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: ApiFixture[] = [];
  for (const e of entries) {
    if (!e.endsWith('.json')) continue;
    const f = await readJson<ApiFixture>(path.join(dir, e));
    if (f && typeof f === 'object') out.push(f);
  }
  return out;
}

/** Load the entity graph (`<modeDir>/entity-graph.json`), if present. */
async function loadEntityGraph(modeDir: string): Promise<EntityGraph | undefined> {
  return readJson<EntityGraph>(path.join(modeDir, 'entity-graph.json'));
}

/** Load listing extracts from `<modeDir>/extract/listings/*.json` (best-effort). */
async function loadListings(modeDir: string): Promise<ListingExtract[]> {
  const dir = path.join(modeDir, 'extract', 'listings');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: ListingExtract[] = [];
  for (const e of entries) {
    if (!e.endsWith('.json')) continue;
    const l = await readJson<ListingExtract>(path.join(dir, e));
    if (l && typeof l === 'object') out.push(l);
  }
  return out;
}

/** Site name from the mode/bundle dir path (best-effort, for the md heading). */
function siteNameFor(bundleDir: string, modeDir: string): string {
  // Bundle layout is typically output/<site>/<mode>/…; the site name is the
  // parent of the mode dir, falling back to the bundle dir's basename.
  const parent = path.basename(path.dirname(modeDir));
  if (parent && parent !== '.' && parent !== '') return parent;
  return path.basename(bundleDir) || 'site';
}

export async function runQc(bundleDir: string, opts: QcCommandOptions): Promise<number> {
  const modeDir = await resolveModeDir(bundleDir, opts.mode);
  if (!modeDir) {
    process.stderr.write(
      `No bundle found at ${bundleDir}: expected a ${opts.mode}/ subdir or an explore/ or qc/ folder.\n`,
    );
    return 2;
  }

  // Gather every available input so the FULL task set (behaviors + data-fidelity +
  // coverage) is built — not just explore behaviors. An api-only bundle (no --full)
  // still yields data-fidelity tasks from its fixtures.
  const bundle = await loadBehaviors(modeDir);
  const fixtures = await loadFixtures(modeDir);
  const entityGraph = await loadEntityGraph(modeDir);
  const listings = await loadListings(modeDir);

  if (!bundle && fixtures.length === 0 && listings.length === 0) {
    process.stderr.write(
      `No QC inputs found under ${modeDir}: expected explore/behaviors.json, ` +
        'api/fixtures/, or extract/listings/. Run a --full / --api / --extract capture first.\n',
    );
    return 2;
  }

  const tasks = buildAllQcTasks({ behaviors: bundle, fixtures, entityGraph, listings });
  const siteName = siteNameFor(bundleDir, modeDir);

  const qcDir = path.join(modeDir, 'qc');
  await fs.mkdir(qcDir, { recursive: true });
  await fs.writeFile(path.join(qcDir, 'qc-tasks.json'), JSON.stringify(tasks, null, 2), 'utf8');
  await fs.writeFile(path.join(qcDir, 'qc-tasks.md'), renderQcMd(tasks, siteName), 'utf8');

  // Generate-only mode.
  if (!opts.run) {
    if (opts.json) {
      console.log(JSON.stringify({ generated: tasks.length }, null, 2));
    } else {
      console.log(`Generated ${tasks.length} QC task(s) → qc/`);
    }
    return 0;
  }

  // Run mode requires a target.
  if (!opts.target) {
    process.stderr.write('--run requires --target <url> (the rebuilt app to validate).\n');
    return 2;
  }

  const results = await runQcTasks(tasks, opts.target, {
    threshold: opts.threshold,
    mode: opts.mode,
  });

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const total = results.length;

  if (opts.json) {
    console.log(JSON.stringify({ passed, failed, total, results }, null, 2));
  } else {
    for (const r of results) {
      const mark = r.pass ? pc.green('✓') : pc.red('✗');
      console.log(`${mark} ${r.id} ${r.title} — ${r.reason}`);
    }
    console.log(`${passed}/${total} passed`);
  }

  return failed > 0 ? 1 : 0;
}
