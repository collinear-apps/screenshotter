// PHASE 4 — runnable handoff. OWNED by Lane 4.
// Writes bundle.json: the machine-readable spine linking every route to its
// screenshot(s)/DOM/a11y golden/fixtures/behaviors, plus index.md for humans.
import { promises as fs, readdirSync } from 'fs';
import path from 'path';
import type {
  BehaviorBundle,
  BehaviorSpec,
  BundleIndex,
  BundleRouteArtifacts,
  CaptureResult,
} from '../types';

/**
 * Collect a primary screenshot plus its on-disk breakpoint/dark variant siblings
 * (`<base>@tablet.png`, `<base>@desktop-dark.png`, …), so the bundle exposes the
 * full responsive/dark set the pipeline already wrote (otherwise they're orphaned).
 * `absShot` is the primary PNG's absolute path; returns rel paths via `rel()`.
 */
function screenshotVariants(absShot: string, rel: (abs: string) => string): string[] {
  const dir = path.dirname(absShot);
  const baseNoExt = path.basename(absShot).replace(/\.png$/i, '');
  const out = [rel(absShot)];
  try {
    for (const f of readdirSync(dir)) {
      if (f.startsWith(`${baseNoExt}@`) && /\.png$/i.test(f)) out.push(rel(path.join(dir, f)));
    }
  } catch {
    /* dir unreadable — primary only */
  }
  return out;
}

/** Inputs the pipeline already has on hand, assembled into per-route artifacts. */
export interface BundleAssemblyInput {
  /** Successful capture results (each carries target + screenshotPath). */
  results: CaptureResult[];
  /** Mode dir name (e.g. "web" | "mobile") — paths are relative to <outDir>/<mode>. */
  mode: string;
  /** Absolute outDir, used to compute paths relative to the mode dir. */
  outDir: string;
  /** True when DOM was extracted (so we link <name>.html / .normalized.html). */
  hasDom: boolean;
  /** True when a11y goldens were extracted (so we link <name>.aria.yaml). */
  hasA11y: boolean;
  /** API fixtures (linked by templated path → route). */
  fixtures: { file: string; pathTemplate: string; url: string }[];
  /** Behaviors bundle, used to attach behavior ids per route. */
  behaviors?: BehaviorBundle;
}

/** Pathname of a URL, or '' when unparseable. */
function pathnameOf(raw: string | undefined): string {
  if (!raw) return '';
  try {
    return new URL(raw).pathname || '/';
  } catch {
    return raw;
  }
}

/**
 * Assemble per-route artifact records from capture results so each route links
 * to its screenshot(s)/DOM/normalizedDom/a11yGolden + the fixtures/behaviors that
 * belong to it. Paths are RELATIVE to <outDir>/<mode> (matching the zip layout
 * and the rebuild prompt). Pure; never throws on malformed input.
 */
export function assembleRouteArtifacts(
  input: BundleAssemblyInput,
): BundleRouteArtifacts[] {
  const modeDir = path.join(input.outDir, input.mode);
  const rel = (abs: string): string =>
    path.relative(modeDir, abs).split(path.sep).join('/');

  const features: BehaviorSpec[] = Array.isArray(input.behaviors?.features)
    ? (input.behaviors!.features as BehaviorSpec[])
    : [];

  const out: BundleRouteArtifacts[] = [];
  const results = Array.isArray(input.results) ? input.results : [];
  for (const r of results) {
    if (!r || !r.ok || !r.screenshotPath) continue;
    const shot = rel(r.screenshotPath);
    const route = pathnameOf(r.target.url);

    const artifacts: BundleRouteArtifacts = {
      route,
      label: r.target.label,
      category: r.target.category,
      url: r.target.url,
      screenshots: screenshotVariants(r.screenshotPath, rel),
      fixtures: [],
      behaviors: [],
    };

    if (input.hasDom) {
      artifacts.dom = shot.replace(/\.png$/i, '.html');
      artifacts.normalizedDom = shot.replace(/\.png$/i, '.normalized.html');
    }
    if (input.hasA11y) {
      artifacts.a11yGolden = shot.replace(/\.png$/i, '.aria.yaml');
    }

    // Behaviors whose page matches this route's label live here.
    for (const f of features) {
      if (f && (f.page === r.target.label || pathnameOf(f.pageUrl) === route)) {
        artifacts.behaviors.push(f.id);
      }
    }

    out.push(artifacts);
  }

  // Attach fixtures to the route whose path-prefix best matches the fixture
  // template; a fixture that matches no route stays only in the top-level list.
  const fixtures = Array.isArray(input.fixtures) ? input.fixtures : [];
  for (const fx of fixtures) {
    if (!fx || !fx.file) continue;
    const fxPath = pathnameOf(fx.url) || fx.pathTemplate || '';
    let best: BundleRouteArtifacts | undefined;
    let bestLen = -1;
    for (const a of out) {
      if (a.route && a.route !== '/' && fxPath.startsWith(a.route) && a.route.length > bestLen) {
        best = a;
        bestLen = a.route.length;
      }
    }
    if (best && !best.fixtures.includes(`api/fixtures/${fx.file}`)) {
      best.fixtures.push(`api/fixtures/${fx.file}`);
    }
  }

  return out;
}

/** Assemble a BundleIndex from per-route artifact records. */
export function buildBundleIndex(
  site: string,
  generatedFrom: string,
  routes: BundleRouteArtifacts[],
  extras: Partial<Pick<BundleIndex, 'fixtures' | 'mockServer' | 'manifest' | 'entityGraph' | 'scaffold'>> = {},
): BundleIndex {
  return {
    site,
    generatedFrom,
    routes: Array.isArray(routes) ? routes : [],
    fixtures: extras.fixtures ?? [],
    mockServer: extras.mockServer,
    manifest: extras.manifest,
    entityGraph: extras.entityGraph,
    scaffold: extras.scaffold,
  };
}

/** Write <bundleDir>/<mode>/bundle.json. Returns the path. */
export async function writeBundleIndex(
  outDir: string,
  mode: string,
  index: BundleIndex,
): Promise<string> {
  const dir = path.join(outDir, mode);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'bundle.json');
  await fs.writeFile(file, JSON.stringify(index, null, 2), 'utf8');
  return file;
}

/** Render a human-readable index.md cross-linking every artifact in the bundle. */
export function renderBundleMd(index: BundleIndex): string {
  const L: string[] = [];
  L.push(`# Bundle index — ${index.site}`);
  L.push('');
  L.push(`Captured from ${index.generatedFrom}. Machine-readable spine: \`bundle.json\`.`);
  L.push('');

  L.push('## Top-level artifacts');
  L.push('');
  L.push('| Artifact | Path |');
  L.push('|----------|------|');
  if (index.scaffold) L.push(`| Runnable frontend scaffold | \`${index.scaffold}\` |`);
  if (index.mockServer) L.push(`| Mock API server | \`${index.mockServer}\` |`);
  if (index.manifest) L.push(`| Capture manifest | \`${index.manifest}\` |`);
  if (index.entityGraph) L.push(`| Entity graph (seed data) | \`${index.entityGraph}\` |`);
  L.push(`| API fixtures | ${index.fixtures.length} file(s) under \`api/fixtures/\` |`);
  L.push('');

  L.push(`## Routes (${index.routes.length})`);
  L.push('');
  L.push('| Route | Label | Screenshot | DOM | a11y | Fixtures | Behaviors |');
  L.push('|-------|-------|-----------|-----|------|----------|-----------|');
  for (const r of index.routes) {
    const shot = r.screenshots[0] ? `\`${r.screenshots[0]}\`` : '—';
    const dom = r.dom ? `\`${r.dom}\`` : '—';
    const a11y = r.a11yGolden ? `\`${r.a11yGolden}\`` : '—';
    const fx = r.fixtures.length > 0 ? `${r.fixtures.length}` : '—';
    const bx = r.behaviors.length > 0 ? `${r.behaviors.length}` : '—';
    L.push(`| \`${r.route}\` | ${r.label} | ${shot} | ${dom} | ${a11y} | ${fx} | ${bx} |`);
  }
  L.push('');
  return L.join('\n');
}

/** Write <bundleDir>/<mode>/index.md from a BundleIndex. Returns the path. */
export async function writeBundleMd(
  outDir: string,
  mode: string,
  index: BundleIndex,
): Promise<string> {
  const dir = path.join(outDir, mode);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'index.md');
  await fs.writeFile(file, renderBundleMd(index), 'utf8');
  return file;
}
