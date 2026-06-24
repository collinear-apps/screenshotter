// Owned by Wave 1 / Agent C (qc generate).
// buildQcTasks: features → portable QC tasks (semantic role+name locators);
// renderQcMd: readable checklist. Pure + side-effect-free; tolerates malformed input.
import type {
  ActionOutcome,
  ApiFixture,
  BehaviorApiCall,
  BehaviorBundle,
  BehaviorSpec,
  DataAssertion,
  EntityGraph,
  ListingExtract,
  PageTarget,
  QcTask,
  RouteSpec,
} from '../types';

/** Cap on the number of light navigation tasks emitted for routes. */
const MAX_ROUTE_TASKS = 20;
/** Cap on coverage (render) tasks — one per discovered route. */
const MAX_COVERAGE_TASKS = 60;
/** Max salient values asserted per data-fidelity task. */
const MAX_DATA_ASSERTIONS = 5;
/** Min/max length of a value worth asserting renders (skip ids that are too short/long). */
const MIN_VALUE_LEN = 2;
const MAX_VALUE_LEN = 80;

/**
 * Map a trigger kind to an ARIA role usable by `page.getByRole`. Returns
 * undefined for kinds with no clean role mapping (the runner then falls back to
 * `getByText`). Case-insensitive.
 */
export function kindToRole(kind: string | undefined): string | undefined {
  switch ((kind ?? '').toLowerCase()) {
    case 'link':
      return 'link';
    case 'button':
      return 'button';
    case 'tab':
      return 'tab';
    case 'menuitem':
      return 'menuitem';
    case 'searchbox':
    case 'textbox':
      return 'textbox';
    default:
      return undefined;
  }
}

/** Best-effort URL pathname; falls back to the raw value when unparseable. */
function pathnameOf(raw: string | undefined): string {
  if (!raw) return '';
  try {
    return new URL(raw).pathname;
  } catch {
    return raw;
  }
}

/** Templated API endpoints (`METHOD /path`) from a behavior's linked calls. */
function apiPaths(api: BehaviorApiCall[] | undefined): string[] {
  if (!Array.isArray(api)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const call of api) {
    if (!call) continue;
    const method = (call.method ?? 'GET').toUpperCase();
    const path = pathnameOf(call.url);
    const entry = `${method} ${path}`;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/** Human-readable description of the expected outcome for a feature task. */
function outcomeText(
  outcome: ActionOutcome,
  toUrl: string | undefined,
  download: string | undefined,
  api: string[],
): string {
  switch (outcome) {
    case 'navigation':
      return toUrl ? `navigates to ${toUrl}` : 'navigates to a new page';
    case 'modal':
      return 'a dialog/modal opens';
    case 'download':
      return download ? `downloads ${download}` : 'a file download starts';
    case 'dom-change': {
      if (api.length === 0) return 'the view updates (DOM change)';
      // Keep the human line readable; the full list lives in expect.api.
      const shown = api.slice(0, 3).join(', ');
      const more = api.length > 3 ? ` +${api.length - 3} more` : '';
      return `the view updates (fires ${shown}${more})`;
    }
    default:
      return 'no error (control is reachable and actionable)';
  }
}

/** A short human label for the action verb based on kind. */
function actionVerb(action: string, kind: string): { verb: string; kind: string } {
  const k = kind || 'control';
  return { verb: action === 'fill' ? 'Type into' : 'Click', kind: k };
}

/** Build one QC task from a feature behavior. */
function taskFromFeature(feature: BehaviorSpec, index: number): QcTask {
  const id = `QC-${String(index).padStart(3, '0')}`;
  const label = feature.trigger?.label ?? '';
  const kind = feature.trigger?.kind ?? '';
  const role = kindToRole(kind);
  const api = apiPaths(feature.api);
  const detail = outcomeText(feature.outcome, feature.toUrl, feature.download, api);

  // Semantic pre-steps (reach a sub-state, e.g. open a dropdown) derived from the
  // feature's precondition path. Each is a click on a role+name locator.
  const precondition = Array.isArray(feature.precondition) ? feature.precondition : [];
  const pre = precondition.map((p) => ({
    role: kindToRole(p.kind),
    name: p.label,
    action: 'click',
  }));

  const { verb, kind: kindLabel } = actionVerb(feature.action, kind);
  // Order: navigate to page → open each precondition control → main action → expect.
  const preSteps = precondition.map((p) => `Open the ${p.kind} "${p.label}"`);
  const steps = [
    `Open ${feature.pageUrl}`,
    ...preSteps,
    `${verb} the ${kindLabel} "${label}"`,
    `Expect: ${detail}`,
  ];

  const expect: QcTask['expect'] = { kind: feature.outcome };
  expect.detail = detail;
  if (api.length > 0) expect.api = api;
  if (feature.a11y !== undefined) expect.a11yGolden = feature.a11y;

  const semantic: QcTask['semantic'] = { name: label };
  if (role !== undefined) semantic.role = role;

  const task: QcTask = {
    id,
    title: `${feature.outcome}: "${label}" on ${feature.page}`,
    page: feature.page,
    pageUrl: feature.pageUrl,
    semantic,
    action: feature.action,
    steps,
    expect,
  };
  if (pre.length > 0) task.pre = pre;
  return task;
}

/** Build one light navigation QC task from a route edge. */
function taskFromRoute(route: RouteSpec, index: number, fromUrl: string): QcTask {
  const id = `QC-${String(index).padStart(3, '0')}`;
  const label = route.label ?? '';
  const detail = route.toUrl
    ? `navigates to ${route.toUrl}`
    : 'navigates to a new page';

  const steps = [
    `Open ${fromUrl}`,
    `Click the link "${label}"`,
    `Expect: ${detail}`,
  ];

  return {
    id,
    title: `navigation: "${label}" on ${route.fromPage}`,
    page: route.fromPage,
    pageUrl: fromUrl,
    semantic: { role: 'link', name: label },
    action: 'click',
    steps,
    expect: { kind: 'navigation', detail },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — data-fidelity, fill/select, and coverage tasks.
// "Functional done" must mean "real data renders", so these assert captured
// VALUES appear in the rebuild — not just that controls are reachable.
// ─────────────────────────────────────────────────────────────────────────────

/** Pathname of a URL, or '' when unparseable. */
function pathnameOnly(raw: string | undefined): string {
  if (!raw) return '';
  try {
    return new URL(raw).pathname || '/';
  } catch {
    return raw;
  }
}

/** True when a string value is salient enough to assert it renders. */
function isSalientValue(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < MIN_VALUE_LEN || s.length > MAX_VALUE_LEN) return false;
  // Skip values that look like URLs, dates, booleans, or pure punctuation —
  // they're brittle to assert verbatim in a rebuild.
  if (/^https?:\/\//i.test(s)) return false;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return false;
  if (/^(true|false|null|undefined)$/i.test(s)) return false;
  if (!/[a-z0-9]/i.test(s)) return false;
  return true;
}

/** Pick the first record out of a fixture response (array or {data:[...]} / {items:[...]}). */
function firstRecord(response: unknown): { record: Record<string, unknown>; idx: string } | null {
  let arr: unknown = response;
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const obj = response as Record<string, unknown>;
    arr = obj.data ?? obj.items ?? obj.results ?? obj.models ?? obj.datasets ?? response;
  }
  if (Array.isArray(arr)) {
    for (let i = 0; i < arr.length; i++) {
      const r = arr[i];
      if (r && typeof r === 'object' && !Array.isArray(r)) return { record: r as Record<string, unknown>, idx: `[${i}]` };
    }
    return null;
  }
  if (arr && typeof arr === 'object') return { record: arr as Record<string, unknown>, idx: '' };
  return null;
}

/** Salient (key, value) pairs from a record, capped. Prefers id/name/title-ish keys. */
function salientPairs(record: Record<string, unknown>): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const preferred = ['id', 'name', 'title', 'label', 'fullName', 'displayName', 'slug', 'author', 'modelId'];
  const seen = new Set<string>();
  const push = (key: string): void => {
    if (out.length >= MAX_DATA_ASSERTIONS || seen.has(key)) return;
    const v = record[key];
    if (isSalientValue(v)) {
      seen.add(key);
      out.push({ key, value: (v as string).trim() });
    }
  };
  for (const k of preferred) push(k);
  for (const k of Object.keys(record)) push(k);
  return out;
}

/**
 * DATA-FIDELITY tasks: for each fixture with salient field values, emit a task
 * whose expect.data asserts those captured values render on the route the fixture
 * backs. Provenance is recorded in each DataAssertion.source.
 */
export function buildDataTasks(
  fixtures: ApiFixture[],
  startIndex = 0,
): QcTask[] {
  const list = Array.isArray(fixtures) ? fixtures : [];
  const tasks: QcTask[] = [];
  let n = startIndex;
  for (const fx of list) {
    if (!fx || fx.response === undefined) continue;
    const first = firstRecord(fx.response);
    if (!first) continue;
    const pairs = salientPairs(first.record);
    if (pairs.length === 0) continue;

    const route = pathnameOnly(fx.url) || fx.pathTemplate || '/';
    const data: DataAssertion[] = pairs.map((p) => ({
      expectText: p.value,
      selectorHint: undefined,
      source: `fixture:${fx.file}#${first.idx ? `${first.idx}.` : ''}${p.key}`,
    }));

    n += 1;
    tasks.push({
      id: `QC-${String(n).padStart(3, '0')}`,
      title: `data: real values render on ${route}`,
      page: route,
      pageUrl: fx.url || route,
      semantic: { name: pairs[0].value },
      action: 'none',
      steps: [
        `Open ${route}`,
        `Expect captured values to render: ${pairs.map((p) => `"${p.value}"`).join(', ')}`,
      ],
      expect: {
        kind: 'noop',
        detail: `real data from ${fx.file} renders (not a placeholder/mock)`,
        data,
      },
    });
  }
  return tasks;
}

/**
 * COVERAGE tasks: every discovered route must render. For listing routes, also
 * assert the row count is >= the captured count (so the rebuild isn't a stub
 * with one fake row). Routes come from capture targets; listing counts from the
 * captured ListingExtract for that route.
 */
export function buildCoverageTasks(
  targets: PageTarget[],
  listings: ListingExtract[],
  startIndex = 0,
): QcTask[] {
  const list = Array.isArray(targets) ? targets : [];
  const listingByPath = new Map<string, number>();
  for (const l of Array.isArray(listings) ? listings : []) {
    if (!l) continue;
    const p = pathnameOnly(l.pageUrl);
    const count = Array.isArray(l.rows) ? l.rows.length : 0;
    if (p && count > 0) listingByPath.set(p, Math.max(listingByPath.get(p) ?? 0, count));
  }

  const tasks: QcTask[] = [];
  const seen = new Set<string>();
  let n = startIndex;
  for (const t of list) {
    if (!t || !t.url) continue;
    if (tasks.length >= MAX_COVERAGE_TASKS) break;
    const route = pathnameOnly(t.url) || '/';
    if (seen.has(route)) continue;
    seen.add(route);

    const rowCount = listingByPath.get(route);
    n += 1;
    const isListing = typeof rowCount === 'number' && rowCount > 0;
    tasks.push({
      id: `QC-${String(n).padStart(3, '0')}`,
      title: isListing
        ? `coverage: ${route} renders >= ${rowCount} row(s)`
        : `coverage: ${route} renders`,
      page: t.label || route,
      pageUrl: t.url,
      semantic: { name: t.label || route },
      action: 'none',
      steps: isListing
        ? [`Open ${t.url}`, `Expect at least ${rowCount} listing row(s) to render`]
        : [`Open ${t.url}`, `Expect the page to render without error`],
      expect: {
        kind: 'noop',
        detail: isListing
          ? `route renders with >= ${rowCount} row(s) (captured listing count)`
          : 'route renders without error',
        // For listing routes, the captured min-row-count rides along in detail;
        // the runner reads it back from the `>= N row(s)` phrasing.
      },
    });
  }
  return tasks;
}

/**
 * Add fill/select task variants: for fill/select features, attach the captured
 * value so the runner types/selects it before asserting. Pure; returns a NEW
 * array (does not mutate the inputs).
 */
export function withFillSelectValues(tasks: QcTask[], features: BehaviorSpec[]): QcTask[] {
  const list = Array.isArray(tasks) ? tasks : [];
  const feats = Array.isArray(features) ? features : [];
  // Map a feature by (page + trigger label) to its recorded value.
  const valueByKey = new Map<string, string>();
  for (const f of feats) {
    if (!f || (f.action !== 'fill' && f.action !== 'select')) continue;
    if (typeof f.value !== 'string' || f.value.length === 0) continue;
    valueByKey.set(`${f.page}::${f.trigger?.label ?? ''}`, f.value);
  }
  return list.map((t) => {
    if ((t.action === 'fill' || t.action === 'select') && t.value === undefined) {
      const v = valueByKey.get(`${t.page}::${t.semantic.name}`);
      if (v !== undefined) return { ...t, value: v };
    }
    return t;
  });
}

/** All inputs the data-fidelity gate can consume (all optional). */
export interface QcBuildInput {
  behaviors?: BehaviorBundle;
  fixtures?: ApiFixture[];
  targets?: PageTarget[];
  listings?: ListingExtract[];
  entityGraph?: EntityGraph;
}

/**
 * Build the COMPLETE QC task set: behavior/route tasks (existing) PLUS
 * data-fidelity, fill/select values, and coverage tasks. Ids are unique and
 * sequential across all groups. Pure; never throws on malformed input.
 */
export function buildAllQcTasks(input: QcBuildInput): QcTask[] {
  const behaviors = input.behaviors ?? { features: [], routes: [] };
  const features = Array.isArray(behaviors.features) ? behaviors.features : [];

  // 1. Behavior + route tasks (existing logic), with fill/select values attached.
  let tasks = withFillSelectValues(buildQcTasks(behaviors), features);

  // 2. Data-fidelity tasks (captured values must render).
  const dataTasks = buildDataTasks(input.fixtures ?? [], tasks.length);
  tasks = tasks.concat(dataTasks);

  // 3. Coverage tasks (every route renders; listings meet captured row count).
  const coverage = buildCoverageTasks(input.targets ?? [], input.listings ?? [], tasks.length);
  tasks = tasks.concat(coverage);

  return tasks;
}

/**
 * Turn a behavior bundle into portable QC tasks: one per feature (semantic
 * role+name locator + asserted outcome), then up to ~20 light navigation tasks
 * for routes. Pure; never throws on malformed input.
 */
export function buildQcTasks(behaviors: BehaviorBundle): QcTask[] {
  const tasks: QcTask[] = [];
  if (!behaviors || typeof behaviors !== 'object') return tasks;

  const features = Array.isArray(behaviors.features) ? behaviors.features : [];
  const routes = Array.isArray(behaviors.routes) ? behaviors.routes : [];

  let n = 0;
  for (const feature of features) {
    if (!feature) continue;
    n += 1;
    tasks.push(taskFromFeature(feature, n));
  }

  // Build a fromPage → pageUrl lookup so route tasks know where to start. Routes
  // only carry the destination (toUrl); the origin URL comes from a feature on
  // the same page when available, else falls back to toUrl's origin or the path.
  const pageUrlByLabel = new Map<string, string>();
  for (const feature of features) {
    if (feature && feature.page && feature.pageUrl && !pageUrlByLabel.has(feature.page)) {
      pageUrlByLabel.set(feature.page, feature.pageUrl);
    }
  }

  let routeCount = 0;
  for (const route of routes) {
    if (!route) continue;
    if (routeCount >= MAX_ROUTE_TASKS) break;
    routeCount += 1;
    n += 1;
    const fromUrl = pageUrlByLabel.get(route.fromPage) ?? originOf(route.toUrl);
    tasks.push(taskFromRoute(route, n, fromUrl));
  }

  return tasks;
}

/** Origin (scheme + host) of a URL, or the raw value when unparseable. */
function originOf(raw: string | undefined): string {
  if (!raw) return '';
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}

/** Escape a value for safe inline Markdown (collapse newlines). */
function md(s: string): string {
  return (s ?? '').replace(/\r?\n/g, ' ').trim();
}

/** Render the expected-outcome summary line for a task. */
function expectLine(task: QcTask): string {
  const parts: string[] = [task.expect.detail ?? task.expect.kind];
  if (task.expect.api && task.expect.api.length > 0) {
    parts.push(`API: ${task.expect.api.join(', ')}`);
  }
  if (task.expect.a11yGolden) {
    parts.push(`a11y golden: \`${task.expect.a11yGolden}\``);
  }
  if (task.expect.data && task.expect.data.length > 0) {
    const vals = task.expect.data.map((d) => `"${d.expectText}"`).join(', ');
    parts.push(`data renders: ${vals}`);
  }
  return parts.join(' · ');
}

/** Append a task block (heading, step checklist, expected line) to `out`. */
function pushTaskBlock(out: string[], task: QcTask): void {
  out.push(`## ${task.id} ${md(task.title)}`);
  out.push('');
  for (const step of task.steps) {
    out.push(`- [ ] ${md(step)}`);
  }
  out.push('');
  out.push(`Expected: ${md(expectLine(task))}`);
  out.push('');
}

/**
 * Render a human checklist of QC tasks, grouped into Features vs Routes.
 *
 * Feature behaviors are only ever classified as modal/dom-change/download
 * upstream (`buildBehaviors`), so a feature task title never starts with
 * "navigation:". Route tasks are always plain-navigation edges. The title prefix
 * is therefore a reliable split between the two groups.
 */
export function renderQcMd(tasks: QcTask[], siteName: string): string {
  const list = Array.isArray(tasks) ? tasks : [];
  const out: string[] = [];

  out.push(`# QC tasks — ${md(siteName)}`);
  out.push('');
  out.push(`${list.length} task(s)`);
  out.push('');

  const dataTasks = list.filter((t) => t.title.startsWith('data:'));
  const coverage = list.filter((t) => t.title.startsWith('coverage:'));
  const routes = list.filter((t) => t.title.startsWith('navigation:'));
  const features = list.filter(
    (t) =>
      !t.title.startsWith('navigation:') &&
      !t.title.startsWith('data:') &&
      !t.title.startsWith('coverage:'),
  );

  const section = (heading: string, group: QcTask[], empty: string): void => {
    out.push(`## ${heading} (${group.length})`);
    out.push('');
    if (group.length === 0) {
      out.push(`_${empty}_`);
      out.push('');
    } else {
      for (const task of group) pushTaskBlock(out, task);
    }
  };

  section('Features', features, 'No feature tasks.');
  section('Data fidelity', dataTasks, 'No data-fidelity tasks.');
  section('Coverage', coverage, 'No coverage tasks.');
  section('Routes', routes, 'No route tasks.');

  return out.join('\n');
}
