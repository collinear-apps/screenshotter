// Owned by Wave 1 / Agent C (qc runner).
// runQcTasks: replay each task against a target URL via semantic locators and assert
// the recorded outcome (navigation/modal/download/dom-change/api). The functional gate.
import type { Locator, Page } from 'playwright';
import type { DataAssertion, Mode, QcRunResult, QcTask } from '../types';
import { buildRunConfig } from '../config';
import { launchSession, closeSession } from '../capture/browser';
import { captureA11y } from '../a11y/capture';
import { flattenAria } from '../a11y/diff';

export interface QcRunOptions {
  threshold: number;
  mode: Mode;
}

/** Selector matching any visible modal/dialog surface. */
const MODAL_SELECTOR = '[role=dialog], [aria-modal=true], dialog[open], .modal';

/** How long to wait for the located control to become visible. */
const CONTROL_TIMEOUT_MS = 3000;
/** Navigation timeout for opening each task's page. */
const GOTO_TIMEOUT_MS = 30000;
/** Cap on the post-action settle wait for network to go idle. */
const NETWORK_IDLE_MS = 3000;
/** Fixed settle delay after an action so async DOM updates land. */
const SETTLE_MS = 400;
/** How long to wait for a `download` event after a download-action click. */
const DOWNLOAD_TIMEOUT_MS = 5000;
/** How long to wait for a captured value to appear (data-fidelity assertion). */
const DATA_ASSERTION_TIMEOUT_MS = 3000;

/** Sleep helper. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-base a task's recorded page URL onto the target origin so tasks run against
 * the REBUILD at the same path. Falls back to the raw target on any parse error.
 */
function routeUrlFor(pageUrl: string, targetUrl: string): string {
  try {
    const target = new URL(targetUrl);
    try {
      const page = new URL(pageUrl);
      return new URL(page.pathname + page.search, target.origin).toString();
    } catch {
      // pageUrl might be a bare path.
      return new URL(pageUrl, target.origin).toString();
    }
  } catch {
    return targetUrl;
  }
}

/** Count of currently-visible modal surfaces. */
async function visibleModalCount(page: Page): Promise<number> {
  try {
    return await page.evaluate((sel: string) => {
      const nodes = Array.from(document.querySelectorAll(sel));
      let n = 0;
      for (const el of nodes) {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(el as HTMLElement);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
        if (visible) n += 1;
      }
      return n;
    }, MODAL_SELECTOR);
  } catch {
    return 0;
  }
}

/**
 * Candidate locators for a (role, name), most-specific first. The captured role
 * is tried first; the name-based fallbacks make the gate robust to ROLE DRIFT —
 * a faithful rebuild that implements, say, a menuitem as a plain <button> (or a
 * tab as a link) should still pass on accessible name.
 */
function candidatesFor(page: Page, role: string | undefined, name: string): Locator[] {
  const list: Locator[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byRole = (r: string): Locator => page.getByRole(r as any, { name, exact: false });
  if (role) list.push(byRole(role));
  if (name) {
    list.push(page.getByText(name, { exact: false }));
    if (role !== 'button') list.push(byRole('button'));
    if (role !== 'link') list.push(byRole('link'));
  }
  return list.map((l) => l.first());
}

/** First candidate that becomes visible within the budget, else null. Never throws. */
async function resolveVisible(
  page: Page,
  role: string | undefined,
  name: string,
  timeout: number,
): Promise<Locator | null> {
  const cands = candidatesFor(page, role, name);
  if (cands.length === 0) return null;
  // Split the budget across candidates with a sane per-candidate floor.
  const per = Math.max(800, Math.floor(timeout / cands.length));
  for (const loc of cands) {
    try {
      await loc.waitFor({ state: 'visible', timeout: per });
      return loc;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Pathname of a URL, or '' when unparseable. */
function pathOf(raw: string): string {
  try {
    return new URL(raw).pathname;
  } catch {
    return '';
  }
}

/** Pathname embedded in an expected `METHOD /path` api entry. */
function expectedApiPaths(api: string[] | undefined): string[] {
  if (!Array.isArray(api)) return [];
  const out: string[] = [];
  for (const entry of api) {
    const idx = entry.indexOf(' ');
    const path = idx === -1 ? entry : entry.slice(idx + 1);
    if (path) out.push(path);
  }
  return out;
}

/** Settle: wait for network idle (best effort) plus a short fixed delay. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_MS }).catch(() => {});
  await delay(SETTLE_MS);
}

/**
 * Assert each captured value is present in the rendered DOM (bounded). Returns the
 * first missing value, or null when all are present. Uses getByText so a faithful
 * rebuild passes regardless of element structure.
 */
async function assertData(
  page: Page,
  data: DataAssertion[] | undefined,
): Promise<{ ok: boolean; missing?: DataAssertion }> {
  const list = Array.isArray(data) ? data : [];
  for (const d of list) {
    const text = (d?.expectText ?? '').trim();
    if (!text) continue;
    try {
      // Bounded wait: a faithful rebuild renders the value promptly. First match
      // is enough — we only care that the captured value appears somewhere.
      await page.getByText(text, { exact: false }).first().waitFor({
        state: 'visible',
        timeout: DATA_ASSERTION_TIMEOUT_MS,
      });
    } catch {
      return { ok: false, missing: d };
    }
  }
  return { ok: true };
}

/** Parse a coverage task's captured min-row-count from its `>= N row(s)` detail. */
function expectedMinRows(task: QcTask): number | undefined {
  const detail = task.expect.detail ?? task.title ?? '';
  const m = /(\d+)\s+row\(s\)/.exec(detail);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Count visible "row-like" repeated items (li / [role=row] / article / card). */
async function visibleRowCount(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => {
      const sel = 'li, [role="row"], [role="listitem"], article, tr';
      const nodes = Array.from(document.querySelectorAll(sel));
      let n = 0;
      for (const el of nodes) {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(el as HTMLElement);
        if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none') {
          n += 1;
        }
      }
      return n;
    });
  } catch {
    return 0;
  }
}

/**
 * Render-only tasks (data-fidelity + coverage): no control to click — open the
 * route and assert real data renders (and, for listings, the captured row count).
 * Returns null when the task is NOT render-only (caller continues normal flow).
 */
async function runRenderOnly(
  page: Page,
  task: QcTask,
  base: { id: string; title: string },
): Promise<QcRunResult | null> {
  const isData = (task.expect.data?.length ?? 0) > 0;
  const minRows = expectedMinRows(task);
  const isCoverage = task.action === 'none' && (isData || minRows !== undefined || task.expect.kind === 'noop');
  if (!isData && minRows === undefined && !isCoverage) return null;

  // Listing row-count gate (coverage).
  if (minRows !== undefined) {
    const got = await visibleRowCount(page);
    if (got < minRows) {
      return { ...base, pass: false, reason: `expected >= ${minRows} row(s) but only ${got} rendered` };
    }
  }

  // Data-fidelity: captured values must render.
  if (isData) {
    const res = await assertData(page, task.expect.data);
    if (!res.ok && res.missing) {
      return {
        ...base,
        pass: false,
        reason: `captured value "${res.missing.expectText}" (${res.missing.source}) did not render`,
      };
    }
  }

  const note = minRows !== undefined ? ` (>= ${minRows} row(s))` : '';
  return { ...base, pass: true, reason: `route rendered with real data${note}` };
}

/** Execute one task and produce its pass/fail result. Never throws. */
async function runOne(
  page: Page,
  task: QcTask,
  targetUrl: string,
): Promise<QcRunResult> {
  const base = { id: task.id, title: task.title };

  const routeUrl = routeUrlFor(task.pageUrl, targetUrl);
  try {
    await page.goto(routeUrl, { waitUntil: 'load', timeout: GOTO_TIMEOUT_MS });
  } catch (err) {
    return { ...base, pass: false, reason: `navigation to ${routeUrl} failed: ${msg(err)}` };
  }
  await delay(SETTLE_MS);

  // Render-only tasks (data-fidelity + coverage) have no control to click — they
  // assert real data/rows render on the freshly-opened route, then return.
  if (task.action === 'none') {
    const rendered = await runRenderOnly(page, task, base);
    if (rendered) return rendered;
  }

  // Replay each precondition step (e.g. open a dropdown/menu) to reach the
  // sub-state the main control lives in. Located the same way as the main
  // control; an unreachable pre-step is a clean FAIL (not a throw).
  const preSteps = Array.isArray(task.pre) ? task.pre : [];
  for (const pre of preSteps) {
    const preControl = await resolveVisible(page, pre.role, pre.name, CONTROL_TIMEOUT_MS);
    if (!preControl) {
      return { ...base, pass: false, reason: `precondition "${pre.name}" not reachable` };
    }
    try {
      await preControl.click();
    } catch (err) {
      return { ...base, pass: false, reason: `precondition "${pre.name}" not reachable: ${msg(err)}` };
    }
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_MS }).catch(() => {});
    await delay(300);
  }

  // Locate the control (captured role first, then accessible-name fallbacks).
  const control = await resolveVisible(
    page,
    task.semantic.role,
    task.semantic.name ?? '',
    CONTROL_TIMEOUT_MS,
  );
  if (!control) {
    return {
      ...base,
      pass: false,
      reason: `control not found (${task.semantic.role ?? 'text'} "${task.semantic.name}")`,
    };
  }

  // BEFORE snapshot.
  const urlBefore = page.url();
  const modalBefore = await visibleModalCount(page);
  let ariaBefore: string;
  try {
    ariaBefore = (await captureA11y(page)).ariaYaml;
  } catch {
    ariaBefore = '';
  }

  // Collect request URLs fired while the action settles.
  const requests: string[] = [];
  const onReq = (r: { url(): string }): void => {
    try {
      requests.push(r.url());
    } catch {
      // ignore
    }
  };
  page.on('request', onReq);

  // Perform the action. For downloads, arm a download listener around the click.
  let downloaded = false;
  try {
    if (task.action === 'fill') {
      // Use the captured value when present so the rebuild sees realistic input.
      await control.fill(task.value && task.value.length > 0 ? task.value : 'test');
      await control.press('Enter');
    } else if (task.action === 'select') {
      // Select the captured option label/value when present (best-effort).
      if (task.value && task.value.length > 0) {
        await control.selectOption({ label: task.value }).catch(async () => {
          await control.selectOption(task.value as string).catch(() => {});
        });
      }
    } else if (task.expect.kind === 'download') {
      // Arm the download listener BEFORE the click (it carries its own timeout),
      // then await it so a fired download sets the flag; a no-download times out.
      const dlPromise = page
        .waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS })
        .then(() => {
          downloaded = true;
        })
        .catch(() => {});
      await control.click();
      await dlPromise;
    } else {
      await control.click();
    }
    await settle(page);
  } catch (err) {
    page.off('request', onReq);
    return { ...base, pass: false, reason: `action failed: ${msg(err)}` };
  }
  page.off('request', onReq);

  // Data-fidelity rider: a feature task may also assert captured values render
  // AFTER its action (e.g. a search/filter that should surface real records). A
  // missing value is a clean FAIL regardless of the structural outcome.
  if ((task.expect.data?.length ?? 0) > 0) {
    const res = await assertData(page, task.expect.data);
    if (!res.ok && res.missing) {
      return {
        ...base,
        pass: false,
        reason: `captured value "${res.missing.expectText}" (${res.missing.source}) did not render after action`,
      };
    }
  }

  // Assert by expected outcome.
  switch (task.expect.kind) {
    case 'navigation': {
      const urlAfter = page.url();
      if (urlAfter === urlBefore) {
        return { ...base, pass: false, reason: 'expected navigation but URL did not change' };
      }
      const expectedPath = pathOf(task.expect.detail?.replace(/^navigates to /, '') ?? '');
      const matchedPath = expectedPath && pathOf(urlAfter) === expectedPath;
      const note = matchedPath ? ' (path matches)' : '';
      return { ...base, pass: true, reason: `navigated ${urlBefore} → ${urlAfter}${note}` };
    }

    case 'modal': {
      const modalAfter = await visibleModalCount(page);
      if (modalAfter > modalBefore) {
        return { ...base, pass: true, reason: 'a dialog/modal appeared after the action' };
      }
      return { ...base, pass: false, reason: 'expected a modal/dialog to open but none appeared' };
    }

    case 'download': {
      if (downloaded) {
        return { ...base, pass: true, reason: 'a download started' };
      }
      return { ...base, pass: false, reason: 'expected a download but no download event fired' };
    }

    case 'dom-change': {
      // Lenient but meaningful: pass if an expected API request fired, OR the
      // page's a11y tree visibly changed vs the before snapshot.
      const wantApi = expectedApiPaths(task.expect.api);
      let apiMatched = false;
      if (wantApi.length > 0) {
        for (const req of requests) {
          const p = pathOf(req);
          if (p && wantApi.includes(p)) {
            apiMatched = true;
            break;
          }
        }
      }

      let ariaAfter = '';
      try {
        ariaAfter = (await captureA11y(page)).ariaYaml;
      } catch {
        ariaAfter = '';
      }
      const before = flattenAria(ariaBefore).length;
      const after = flattenAria(ariaAfter).length;
      const domChanged = ariaAfter !== ariaBefore || before !== after;

      if (wantApi.length > 0) {
        if (apiMatched) {
          return { ...base, pass: true, reason: `expected API fired (${wantApi.join(', ')})` };
        }
        if (domChanged) {
          return { ...base, pass: true, reason: 'view updated (a11y/DOM changed) though no API matched' };
        }
        return {
          ...base,
          pass: false,
          reason: `expected API (${wantApi.join(', ')}) and no visible DOM change`,
        };
      }

      if (domChanged) {
        return { ...base, pass: true, reason: 'view updated (a11y/DOM changed)' };
      }
      return { ...base, pass: false, reason: 'expected a DOM change but the view looked unchanged' };
    }

    default: {
      // noop / other: pass if the control was found and acted on without error.
      return { ...base, pass: true, reason: 'control found and actioned without error' };
    }
  }
}

/** Extract a readable message from an unknown thrown value. */
function msg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Replay each QC task against `targetUrl` (the rebuild) and assert its recorded
 * outcome. Tasks run sequentially in one browser context; one task throwing
 * never aborts the loop. Returns one result per task, in order.
 */
export async function runQcTasks(
  tasks: QcTask[],
  targetUrl: string,
  opts: QcRunOptions,
): Promise<QcRunResult[]> {
  const list = Array.isArray(tasks) ? tasks : [];
  const results: QcRunResult[] = [];

  const cfg = buildRunConfig({ url: targetUrl, mode: opts.mode });
  const session = await launchSession(cfg);
  try {
    for (const task of list) {
      const page = await session.context.newPage();
      try {
        const result = await runOne(page, task, targetUrl);
        results.push(result);
      } catch (err) {
        results.push({
          id: task.id,
          title: task.title,
          pass: false,
          reason: `unexpected error: ${msg(err)}`,
        });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await closeSession(session);
  }

  return results;
}
