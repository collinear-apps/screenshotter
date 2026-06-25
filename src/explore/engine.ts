// OWNED by Wave 1 / Agent B (explore engine).
// explorePage: bounded recursive DFS over page states (signature dedup +
// path-replay reset), clicking allowed elements, detecting outcome, capturing
// per-state screenshot/DOM/network, honoring budgets + safety. Best-effort.
import { promises as fs } from 'fs';
import path from 'path';
import type { BrowserContext, Page } from 'playwright';
import type {
  ActionOutcome,
  ActionRecord,
  Clickable,
  ExploreResult,
  Logger,
  PageTarget,
  RunConfig,
} from '../types';
import { preparePage } from '../capture/prepare';
import { captureScreenshot } from '../capture/screenshot';
import { captureDom } from '../extract/dom';
import { captureA11y } from '../a11y/capture';
import { installClock } from '../determinism';
import { sanitizeSegment } from '../output/naming';
import { enumerateClickables } from './clickables';
import { decide } from './safety';
import type { DownloadSink } from './downloads';

/** Shared, run-wide exploration environment. */
export interface ExploreEnv {
  /** Run output dir (artifacts go under outDir/<mode>/explore/...). */
  outDir: string;
  /** Global remaining-action budget (mutable; decremented across pages). */
  budget: { remaining: number };
  sink: DownloadSink;
  /** Called once per recorded action so callers can render live progress. */
  onProgress?: () => void;
}

/** A clickable is "external" when it's a link without a same-origin href. */
function isExternal(c: Clickable): boolean {
  return c.kind === 'link' && !c.sameOriginHref;
}

/** Kinds that represent a fillable text-ish field. */
const FILL_KINDS = new Set(['input', 'textarea', 'searchbox', 'textbox', 'spinbutton']);

/** input[type]s that are NOT free-text fields (clickable controls). */
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'file',
  'range',
  'color',
  'submit',
  'button',
  'reset',
  'image',
  'hidden',
]);

/** True when this clickable is a free-text field we can type into. */
function isFillable(c: Clickable): boolean {
  if (c.kind === 'select') return false;
  if (FILL_KINDS.has(c.kind)) {
    if (c.inputType && NON_TEXT_INPUT_TYPES.has(c.inputType)) return false;
    return true;
  }
  return false;
}

/** True when this clickable is a <select>/listbox with options to actuate. */
function isSelectable(c: Clickable): boolean {
  return (c.kind === 'select' || c.kind === 'combobox') && Array.isArray(c.options) && c.options.length > 0;
}

/**
 * A representative value for a field, respecting its inputType so client-side
 * validation runs against a plausible-but-real value (e.g. email → user@example.com).
 */
export function representativeValue(c: Clickable): string {
  const it = (c.inputType || '').toLowerCase();
  switch (it) {
    case 'email':
      return 'test@example.com';
    case 'number':
    case 'range':
      return '42';
    case 'tel':
      return '5551234567';
    case 'url':
      return 'https://example.com';
    case 'password':
      return 'Password123!';
    case 'date':
      return '2024-01-01';
    case 'time':
      return '12:00';
    case 'month':
      return '2024-01';
    case 'week':
      return '2024-W01';
    case 'search':
      return 'test';
    default:
      break;
  }
  // Honor a numeric inputmode/pattern hint even without an explicit number type.
  if (c.pattern && /\\d|\[0-9\]|numeric|tel/i.test(c.pattern)) return '42';
  if (c.kind === 'searchbox' || c.kind === 'spinbutton') {
    return c.kind === 'spinbutton' ? '42' : 'test';
  }
  return 'test';
}

/** Order-preserving dedupe, capped. */
function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/** Short filesystem slug for an action label. */
function slug(label: string): string {
  const s = sanitizeSegment(label || 'action');
  const capped = s.length > 40 ? s.slice(0, 40).replace(/-+$/g, '') : s;
  return capped.length > 0 ? capped : 'action';
}

export async function explorePage(
  context: BrowserContext,
  target: PageTarget,
  cfg: RunConfig,
  logger: Logger,
  env: ExploreEnv,
): Promise<ExploreResult> {
  const e = cfg.explore!;

  const page = await context.newPage();
  env.sink.attach(page);

  if (cfg.determinism?.enabled) {
    await installClock(page, cfg);
  }

  const pageSlug = sanitizeSegment(target.label);
  const artifactDir = path.join(env.outDir, cfg.mode, 'explore', pageSlug);
  let dirReady = false;

  const abs = (name: string): string => path.join(artifactDir, name);
  const rel = (name: string): string => `explore/${pageSlug}/${name}`;
  const ensureDir = async (): Promise<void> => {
    if (dirReady) return;
    await fs.mkdir(artifactDir, { recursive: true });
    dirReady = true;
  };

  const visited = new Set<string>();
  const actions: ActionRecord[] = [];
  let counter = 0;
  let perPage = 0;
  const startedAt = Date.now();

  const budgetOk = (): boolean =>
    env.budget.remaining > 0 &&
    perPage < e.maxActionsPerPage &&
    Date.now() - startedAt < e.pageBudgetMs;

  const settle = async (): Promise<void> => {
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
  };

  // Path-replay reset: re-navigate to the base page, then replay every step in
  // `pathArr` to re-reach the target state. Fill/select steps are re-actuated
  // with the SAME value generator used originally, so a sub-state revealed by a
  // typed value (e.g. live search results) is faithfully reproduced. Throws on
  // any step failure.
  const reach = async (pathArr: Clickable[]): Promise<void> => {
    await preparePage(page, target.url);
    for (const c of pathArr) {
      const loc = page.locator(c.selector).first();
      if (isFillable(c)) {
        await loc.fill(representativeValue(c), { timeout: e.perActionTimeoutMs });
        await loc.press('Enter', { timeout: e.perActionTimeoutMs }).catch(() => {});
      } else if (isSelectable(c)) {
        const opts = c.options || [];
        const pick = opts.length > 1 ? opts[1] : opts[0];
        try {
          await loc.selectOption({ label: pick }, { timeout: e.perActionTimeoutMs });
        } catch {
          await loc.click({ timeout: e.perActionTimeoutMs }).catch(() => {});
          await page
            .getByRole('option', { name: pick, exact: false })
            .first()
            .click({ timeout: e.perActionTimeoutMs })
            .catch(() => {});
        }
      } else {
        await loc.click({ timeout: e.perActionTimeoutMs });
      }
      await settle();
    }
  };

  // Compact, hashable signature of the current page state.
  const stateSig = async (): Promise<string> => {
    try {
      return await page.evaluate(() => {
        const visibleCount = (sel: string): number => {
          let n = 0;
          document.querySelectorAll(sel).forEach((el) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            if (r.width > 0 && r.height > 0) n++;
          });
          return n;
        };
        const modals = visibleCount('[role=dialog], [aria-modal=true], dialog[open], .modal');
        const nodeCount = document.querySelectorAll('*').length;
        const textBucket = Math.round((document.body?.innerText?.length || 0) / 200);
        // Menu/disclosure state: a dropdown often just toggles visibility of
        // already-present nodes, so also fingerprint visible menu items + how many
        // disclosures are currently expanded — otherwise opening a menu reads as a
        // no-op and never gets explored.
        const menuItems = visibleCount('[role=menuitem], [role=option], [role=menu], [role=listbox]');
        const expanded = document.querySelectorAll('[aria-expanded="true"]').length;
        // Bounded count of currently-visible elements — catches content that is
        // revealed/hidden by a display toggle (panels, snippets, popovers) which
        // leaves nodeCount/text unchanged.
        const all = document.querySelectorAll('*');
        const lim = Math.min(all.length, 1500);
        let vis = 0;
        for (let i = 0; i < lim; i++) {
          const r = (all[i] as HTMLElement).getBoundingClientRect();
          if (r.width > 0 && r.height > 0) vis++;
        }
        return `${location.pathname}|${nodeCount}|${modals}|${textBucket}|${menuItems}|${expanded}|${vis}`;
      });
    } catch {
      return '';
    }
  };

  // Is a visible modal/dialog present?
  const hasModal = async (): Promise<boolean> => {
    try {
      return await page.evaluate(() => {
        const els = document.querySelectorAll(
          '[role=dialog], [aria-modal=true], dialog[open], .modal',
        );
        for (const el of Array.from(els)) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
        return false;
      });
    } catch {
      return false;
    }
  };

  // Sample client-side validation for the field at `selector` AND any form it
  // owns: reads :invalid / aria-invalid / a nearby error message. Best-effort.
  const sampleValidation = async (
    selector: string,
  ): Promise<{ valid?: boolean; message?: string } | undefined> => {
    try {
      return await page.evaluate((sel) => {
        const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
        const el = document.querySelector(sel) as
          | (HTMLInputElement & { validationMessage?: string; checkValidity?: () => boolean })
          | null;
        if (!el) return undefined;
        let valid: boolean | undefined;
        let message: string | undefined;
        try {
          if (typeof el.checkValidity === 'function') valid = el.checkValidity();
        } catch {
          /* ignore */
        }
        if (el.validationMessage) message = collapse(el.validationMessage).slice(0, 160);
        const ariaInvalid = el.getAttribute('aria-invalid');
        if (ariaInvalid === 'true') valid = false;
        if (el.matches(':invalid')) valid = false;
        // aria-describedby / aria-errormessage error text.
        if (!message) {
          const ref =
            el.getAttribute('aria-errormessage') || el.getAttribute('aria-describedby');
          if (ref) {
            for (const id of ref.split(/\s+/)) {
              const node = id ? document.getElementById(id) : null;
              const txt = node ? collapse((node as HTMLElement).innerText || node.textContent || '') : '';
              if (txt) {
                message = txt.slice(0, 160);
                break;
              }
            }
          }
        }
        // Nearby [role=alert] / .error text inside the owning form.
        if (!message) {
          const form = el.closest('form') || el.parentElement;
          const alert = form
            ? form.querySelector('[role=alert], .error, .invalid-feedback, [class*="error" i]')
            : null;
          const txt = alert ? collapse((alert as HTMLElement).innerText || alert.textContent || '') : '';
          if (txt) {
            message = txt.slice(0, 160);
            if (valid === undefined) valid = false;
          }
        }
        if (valid === undefined && message === undefined) return undefined;
        const out: { valid?: boolean; message?: string } = {};
        if (valid !== undefined) out.valid = valid;
        if (message !== undefined) out.message = message;
        return out;
      }, selector);
    } catch {
      return undefined;
    }
  };

  // Classify the transient UI state visible right after an action settled.
  const sampleTransientState = async (): Promise<
    'loading' | 'empty' | 'error' | 'success' | undefined
  > => {
    try {
      return await page.evaluate(() => {
        const vis = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const anyVisible = (sel: string): boolean => {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            if (vis(el)) return true;
          }
          return false;
        };
        if (
          anyVisible(
            '[aria-busy="true"], [role=progressbar], .spinner, .loading, [class*="skeleton" i], [class*="loading" i]',
          )
        ) {
          return 'loading';
        }
        if (anyVisible('[role=alert], .error, [class*="error" i], [aria-invalid="true"]')) {
          return 'error';
        }
        if (
          anyVisible(
            '[class*="empty" i], [class*="no-results" i], [class*="noresults" i], [data-empty]',
          )
        ) {
          return 'empty';
        }
        if (anyVisible('[role=status], .success, [class*="success" i], [class*="toast" i]')) {
          return 'success';
        }
        return undefined;
      });
    } catch {
      return undefined;
    }
  };

  // Fast probe for a transient loading/skeleton frame, used to catch the moment
  // BEFORE networkidle settles (the normal settle() would let it vanish). Polls a
  // few times over a short window; returns true the first time a loading marker is
  // visible. Never throws.
  const probeLoading = async (): Promise<boolean> => {
    try {
      return await page.evaluate(() => {
        const vis = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const sel =
          '[aria-busy="true"], [role=progressbar], .spinner, .loading, [class*="skeleton" i], [class*="loading" i], [class*="spinner" i]';
        for (const el of Array.from(document.querySelectorAll(sel))) {
          if (vis(el)) return true;
        }
        return false;
      });
    } catch {
      return false;
    }
  };

  // Capture transient (loading/skeleton) artifacts that exist only BETWEEN the
  // actuation and networkidle. Call this concurrently WITH settle(). It races a
  // short poll loop and, the first time a loading marker shows, grabs a (viewport,
  // fast) screenshot into `<base>.loading.png`. `stop()` lets the caller end the
  // poll the moment settle() finishes with no loading seen, so a non-loading
  // action doesn't waste up to the full window per action (budget-friendly).
  // Returns the relative screenshot path when one was captured. Never throws.
  const captureLoadingFrame = async (
    base: string,
    stop: () => boolean,
  ): Promise<string | undefined> => {
    const LOADING_WINDOW_MS = 1200;
    const POLL_MS = 80;
    const deadline = Date.now() + LOADING_WINDOW_MS;
    try {
      while (Date.now() < deadline) {
        if (await probeLoading()) {
          await ensureDir();
          const name = base + '.loading.png';
          // Viewport-only + animations disabled: a loading frame is ephemeral, so
          // a fast clip beats a full-page shot (which could outlive the state).
          await page
            .screenshot({
              path: abs(name),
              fullPage: false,
              type: 'png',
              animations: 'disabled',
              timeout: 4000,
            })
            .catch(() => {});
          return rel(name);
        }
        // Settle finished and we never saw a spinner — no loading frame exists for
        // this action, so stop polling instead of burning the rest of the window.
        if (stop()) break;
        await page.waitForTimeout(POLL_MS);
      }
    } catch {
      // best-effort — a missed loading frame never fails the action.
    }
    return undefined;
  };

  // Bounded infinite-scroll / "load more" detection. Records the item count
  // before/after a capped scroll-and-wait; returns 'grew' when more content
  // appeared (a real load-more feature), else 'static'. Never throws.
  const detectLoadMore = async (): Promise<{ grew: boolean; before: number; after: number }> => {
    const countItems = async (): Promise<number> => {
      try {
        return await page.evaluate(() => {
          // Heuristic item count: the largest sibling-group of repeated elements,
          // falling back to anchor count.
          const groups = new Map<string, number>();
          const els = document.querySelectorAll('li, article, [role=listitem], [class*="card" i], [class*="item" i]');
          els.forEach((el) => {
            const key = `${el.tagName}.${(el.getAttribute('class') || '').split(/\s+/)[0] || ''}`;
            groups.set(key, (groups.get(key) || 0) + 1);
          });
          let max = 0;
          for (const v of groups.values()) if (v > max) max = v;
          return Math.max(max, document.querySelectorAll('a[href]').length);
        });
      } catch {
        return 0;
      }
    };

    const before = await countItems();
    try {
      // Try an explicit "load more"/"show more" trigger first; else scroll.
      const moreBtn = page
        .getByRole('button', { name: /load more|show more|view more|see more/i })
        .first();
      if (await moreBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await moreBtn.click({ timeout: e.perActionTimeoutMs }).catch(() => {});
      } else {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      }
      await page.waitForTimeout(800);
    } catch {
      /* ignore */
    }
    const after = await countItems();
    return { grew: after > before + 2, before, after };
  };

  const MENU_BONUS = 2;

  const dfs = async (
    pathArr: Clickable[],
    depth: number,
    menuHops: number,
    // When recursing into a same-page sub-state (menu/modal/panel), only explore
    // controls this action REVEALED — those NOT already in `parentSelectors`.
    // Pre-existing controls are explored at the parent level with a shorter (and
    // truthful) path, so we don't re-click them: that would attach a spurious
    // precondition and blow the action budget combinatorially.
    restrictToNew: boolean,
    parentSelectors: Set<string> | undefined,
  ): Promise<void> => {
    if (depth > e.maxDepth || menuHops > MENU_BONUS || !budgetOk()) return;

    try {
      await reach(pathArr);
    } catch {
      return; // can't reach this state — skip
    }

    const sig = await stateSig();
    if (visited.has(sig)) return;
    visited.add(sig);

    const clickables = await enumerateClickables(page);
    // Full selector set of THIS state — handed to same-page children so they can
    // diff against it and explore only the delta.
    const mySelectors = new Set(clickables.map((c) => c.selector));

    // In a revealed sub-state, drop controls already present in the parent (keep
    // genuine menu items even if their selector lingered hidden in the parent).
    const pool =
      restrictToNew && parentSelectors
        ? clickables.filter((c) => c.inMenu || !parentSelectors.has(c.selector))
        : clickables;

    // Stable priority ordering: inMenu first, then opensMenu, then the rest,
    // preserving original relative order within each tier.
    const rank = (c: Clickable): number => (c.inMenu ? 0 : c.opensMenu ? 1 : 2);
    const ordered = pool
      .map((c, i) => ({ c, i }))
      .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
      .map((x) => x.c);

    // Clicks (from baseline) taken to reach this state — recorded on every push.
    const statePath = pathArr.map((p) => ({ label: p.label, kind: p.kind, selector: p.selector }));

    for (const c of ordered) {
      if (!budgetOk()) break;

      counter++;
      const id = `${pageSlug}-${String(counter).padStart(3, '0')}`;

      const dec = decide(c, e.aggressive, isExternal(c));
      if (!dec.allowed) {
        actions.push({
          id,
          pageLabel: target.label,
          depth,
          label: c.label,
          kind: c.kind,
          selector: c.selector,
          outcome: 'skipped',
          note: dec.reason,
          path: statePath,
        });
        env.onProgress?.();
        continue; // don't spend budget on skips
      }

      // Re-reach baseline: a previous click in this loop may have mutated state.
      try {
        await reach(pathArr);
      } catch {
        actions.push({
          id,
          pageLabel: target.label,
          depth,
          label: c.label,
          kind: c.kind,
          selector: c.selector,
          outcome: 'error',
          note: 'reach-failed',
          path: statePath,
        });
        env.onProgress?.();
        continue;
      }

      const urlBefore = page.url();
      const dlBefore = env.sink.count();
      const modalBefore = await hasModal();
      const net: string[] = [];
      const onReq = (r: { url(): string }): void => {
        try {
          net.push(r.url());
        } catch {
          // ignore
        }
      };
      if (e.captureNetwork) page.on('request', onReq);

      // Phase 2: choose actuation by control kind.
      const fillable = isFillable(c);
      const selectable = isSelectable(c);
      let value: string | undefined;

      // Stem for this action's artifacts — computed BEFORE actuation so the
      // transient (loading/skeleton) frame, which exists only between actuation
      // and networkidle, can be captured as `<base>.loading.png`.
      const base = `${String(counter).padStart(3, '0')}-${slug(c.label)}`;
      // Run the loading-frame poll CONCURRENTLY with settle(): settle waits for
      // networkidle (during which the spinner is up), while captureLoadingFrame
      // races a short poll and screenshots the first loading marker it sees.
      let loadingShot: string | undefined;
      const settleWithTransient = async (): Promise<void> => {
        let settled = false;
        const settleThenMark = settle().then(() => {
          settled = true;
        });
        const [shot] = await Promise.all([
          captureLoadingFrame(base, () => settled),
          settleThenMark,
        ]);
        if (shot) loadingShot = shot;
      };

      let outcome: ActionOutcome = 'noop';
      try {
        const loc = page.locator(c.selector).first();
        if (fillable) {
          // Type a representative value, then submit the OWNING form (Enter)
          // so client-side validation + any submit handler runs.
          value = representativeValue(c);
          await loc.fill(value, { timeout: e.perActionTimeoutMs });
          await page.waitForTimeout(150);
          // Submit owning form: search/filter forms are allowed in safe mode;
          // aggressive submits anything not hard-denied (the label already
          // passed `decide`). Press Enter to mimic a real user submit.
          await loc.press('Enter', { timeout: e.perActionTimeoutMs }).catch(() => {});
          await settleWithTransient();
        } else if (selectable) {
          // Actuate the <select>/listbox: pick a non-placeholder option
          // (the 2nd option when present, since the 1st is often a placeholder).
          const opts = c.options || [];
          const pick = opts.length > 1 ? opts[1] : opts[0];
          value = pick;
          try {
            await loc.selectOption({ label: pick }, { timeout: e.perActionTimeoutMs });
          } catch {
            // listbox (not a native <select>): open + click the option by name.
            await loc.click({ timeout: e.perActionTimeoutMs }).catch(() => {});
            await page
              .getByRole('option', { name: pick, exact: false })
              .first()
              .click({ timeout: e.perActionTimeoutMs })
              .catch(() => {});
          }
          await settleWithTransient();
        } else {
          await loc.click({ timeout: e.perActionTimeoutMs });
          await settleWithTransient();
        }
      } catch {
        outcome = 'error';
      }

      if (e.captureNetwork) page.off('request', onReq);

      // Sample client-side validation + transient UI state right after the action.
      const validation =
        fillable || selectable ? await sampleValidation(c.selector) : undefined;
      const transientState = await sampleTransientState();

      let toUrl: string | undefined;
      let downloadFile: string | undefined;

      if (outcome !== 'error') {
        if (env.sink.count() > dlBefore) {
          outcome = 'download';
          downloadFile = env.sink.lastSaved();
        } else if (page.url() !== urlBefore) {
          outcome = 'navigation';
          toUrl = page.url();
        } else if (!modalBefore && (await hasModal())) {
          // Only "modal" if one NEWLY appeared (a modal already open from a prior
          // step in the path doesn't count).
          outcome = 'modal';
        } else {
          const changed = (await stateSig()) !== sig;
          // A fill/select that surfaced validation feedback or a transient state is
          // a real client-side behavior even when the coarse state signature is
          // unchanged — record it as a dom-change so it becomes a feature.
          const feedback =
            (fillable || selectable) && (validation !== undefined || transientState !== undefined);
          outcome = changed || feedback ? 'dom-change' : 'noop';
        }
      }

      let screenshot: string | undefined;
      let dom: string | undefined;
      // Empty/error frames are first-class artifacts even when the coarse outcome
      // is a no-op (e.g. a no-match search that only swaps in a "no results" panel
      // the state signature treats as unchanged) — capture them so the rebuild
      // reproduces the empty/error UX, not just the happy path.
      let transientShot: string | undefined;

      if (outcome === 'navigation' || outcome === 'modal' || outcome === 'dom-change') {
        try {
          await ensureDir();
          await captureScreenshot(
            page,
            abs(base + '.png'),
            cfg.determinism?.maskSelectors ?? [],
          );
          screenshot = rel(base + '.png');
        } catch {
          // best-effort
        }
        if (e.captureDom) {
          try {
            await ensureDir();
            await fs.writeFile(abs(base + '.html'), await captureDom(page));
            dom = rel(base + '.html');
          } catch {
            // best-effort
          }
        }
        if (cfg.extract?.enabled && cfg.extract.a11y) {
          try {
            await ensureDir();
            const a = await captureA11y(page);
            await fs.writeFile(abs(base + '.a11y.json'), JSON.stringify(a.axJson, null, 2));
            await fs.writeFile(abs(base + '.aria.yaml'), a.ariaYaml);
          } catch {
            // best-effort
          }
        }
      }

      // First-class empty/error frame: when the settled state is an empty-results
      // or error state, screenshot it explicitly (named by state) so it survives
      // even when the main `screenshot` above wasn't taken (e.g. a no-op outcome
      // whose only change was swapping in a "no results"/error panel). The full
      // `screenshot` (when present) already shows the same DOM, so skip the extra
      // shot if we already captured one for this action.
      if (
        (transientState === 'empty' || transientState === 'error') &&
        !screenshot
      ) {
        try {
          await ensureDir();
          const name = `${base}.${transientState}.png`;
          await captureScreenshot(page, abs(name), cfg.determinism?.maskSelectors ?? []);
          transientShot = rel(name);
        } catch {
          // best-effort
        }
      }

      actions.push({
        id,
        pageLabel: target.label,
        depth,
        label: c.label,
        kind: c.kind,
        selector: c.selector,
        outcome,
        toUrl,
        downloadFile,
        network: e.captureNetwork ? dedupe(net).slice(0, 50) : undefined,
        // Prefer the result-state shot; else the explicit empty/error frame; else
        // the transient loading frame — so every recorded transient state carries
        // a screenshot path the rebuild/QC layers can reference.
        screenshot: screenshot ?? transientShot ?? loadingShot,
        dom,
        path: statePath,
        value,
        validation,
        transientState,
      });

      env.budget.remaining--;
      perPage++;
      env.onProgress?.();

      // INDUCE an empty state (aggressive only): for a search/free-text field that
      // didn't navigate away, re-type a guaranteed no-match query so the page's
      // "no results"/empty branch renders, then capture it as its OWN action. This
      // is cheap (one extra fill on a field we're already focused on) and yields a
      // first-class empty-state artifact the rebuild must reproduce. Budget-aware.
      const isSearchField =
        fillable && (c.kind === 'searchbox' || (c.inputType || '') === 'search' || /search|filter|find|query/i.test(c.label));
      if (
        e.aggressive &&
        isSearchField &&
        outcome !== 'navigation' &&
        outcome !== 'error' &&
        budgetOk()
      ) {
        try {
          const loc = page.locator(c.selector).first();
          if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
            const NO_MATCH = 'zzqxnomatch9173';
            await loc.fill(NO_MATCH, { timeout: e.perActionTimeoutMs });
            await loc.press('Enter', { timeout: e.perActionTimeoutMs }).catch(() => {});
            await settle();
            const emptyState = await sampleTransientState();
            // Only record when the page actually showed an empty/error branch —
            // otherwise the no-match query taught us nothing worth an artifact.
            if (emptyState === 'empty' || emptyState === 'error') {
              counter++;
              const eid = `${pageSlug}-${String(counter).padStart(3, '0')}`;
              const ebase = `${String(counter).padStart(3, '0')}-${slug(c.label)}-empty`;
              let eshot: string | undefined;
              try {
                await ensureDir();
                await captureScreenshot(page, abs(ebase + '.png'), cfg.determinism?.maskSelectors ?? []);
                eshot = rel(ebase + '.png');
              } catch {
                // best-effort
              }
              actions.push({
                id: eid,
                pageLabel: target.label,
                depth,
                label: c.label,
                kind: c.kind,
                selector: c.selector,
                outcome: 'dom-change',
                note: `induced empty state via no-match query "${NO_MATCH}"`,
                screenshot: eshot,
                path: statePath,
                value: NO_MATCH,
                transientState: emptyState,
              });
              env.budget.remaining--;
              perPage++;
              env.onProgress?.();
            }
          }
        } catch {
          // best-effort: empty-state induction never fails the page.
        }
      }

      // Recurse into genuinely new states only.
      if (
        (outcome === 'modal' || outcome === 'dom-change' || outcome === 'navigation') &&
        budgetOk()
      ) {
        if (outcome === 'navigation') {
          // New URL → fresh selector namespace; explore the page fully.
          await dfs([...pathArr, c], depth + 1, menuHops, false, undefined);
        } else {
          // Same-page sub-state: explore only what this click revealed.
          // Opening a disclosure (modal / menu trigger) spends a menu-hop instead
          // of nav-depth, so dropdown→item→snippet can go MENU_BONUS levels deep.
          const openedDisclosure = outcome === 'modal' || c.opensMenu === true;
          if (openedDisclosure) {
            await dfs([...pathArr, c], depth, menuHops + 1, true, mySelectors);
          } else {
            await dfs([...pathArr, c], depth + 1, menuHops, true, mySelectors);
          }
        }
      }
    }
  };

  await dfs([], 0, 0, false, undefined);

  // Bounded infinite-scroll / "load more" detection — recorded as ONE feature per
  // page (a real client-side capability the twin must reproduce). Runs on the
  // baseline page state, after DFS, only if there's budget left.
  if (budgetOk()) {
    try {
      await reach([]);
      const lm = await detectLoadMore();
      if (lm.grew) {
        counter++;
        let screenshot: string | undefined;
        const base = `${String(counter).padStart(3, '0')}-load-more`;
        try {
          await ensureDir();
          await captureScreenshot(page, abs(base + '.png'), cfg.determinism?.maskSelectors ?? []);
          screenshot = rel(base + '.png');
        } catch {
          // best-effort
        }
        actions.push({
          id: `${pageSlug}-${String(counter).padStart(3, '0')}`,
          pageLabel: target.label,
          depth: 0,
          label: 'load more / infinite scroll',
          kind: 'scroll',
          selector: 'body',
          outcome: 'dom-change',
          note: `pagination: items ${lm.before}→${lm.after} on scroll/load-more`,
          screenshot,
          transientState: 'success',
          path: [],
        });
        env.budget.remaining--;
        perPage++;
        env.onProgress?.();
      }
    } catch {
      // best-effort: load-more probing never fails the page.
    }
  }

  await page.close().catch(() => {});

  // Per-page progress is reported by the caller (live bar / line) via onProgress.
  void logger;

  return {
    pageLabel: target.label,
    baseUrl: target.url,
    actions,
    states: visited.size,
  };
}
