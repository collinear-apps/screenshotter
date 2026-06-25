// TIER 3 — element interaction-state capture. OWNED by Lane STATES.
// For a deduped sample of representative controls per page, drive Playwright
// pseudo-states (hover/focus/active/disabled) and record (a) a tight clipped
// screenshot per state and (b) the computed-style DELTA vs resting — the
// load-bearing artifact (exact hover/focus token values, not a fuzzy pixel read).
import { mkdir } from 'fs/promises';
import path from 'path';
import type { Page } from 'playwright';
import type {
  ElementState,
  ElementStateCapture,
  ElementStatesReport,
  ExtractConfig,
} from '../types';

/** Computed-style props whose change defines an interaction state. */
const TRACKED_PROPS = [
  'color',
  'background-color',
  'border-color',
  'border-top-color',
  'border-bottom-color',
  'box-shadow',
  'outline',
  'outline-color',
  'outline-width',
  'opacity',
  'transform',
  'text-decoration-line',
  'text-decoration',
  'cursor',
  'filter',
] as const;

/** Hard caps so a busy page can't blow up runtime or disk. */
const MAX_CONTROLS = 12;
/** How many DOM candidates we inspect before deduping (bounded scan). */
const MAX_CANDIDATES = 400;
/** Per-state operation timeout (hover/focus/screenshot). */
const STATE_TIMEOUT_MS = 1500;

/** One in-page candidate control (computed in the browser, returned to Node). */
interface Candidate {
  /** Internal re-find key — may carry a ::screenshotter-nth() index encoding. */
  selector: string;
  /** A VALID CSS selector for the report (best-effort; never the nth encoding). */
  cssSelector: string;
  label: string;
  role: string;
  /** Structural signature for dedupe (a grid of identical cards → 1 rep). */
  sig: string;
  /** Natively disabled (disabled attr / aria-disabled) — only :disabled is meaningful. */
  disabled: boolean;
  /** Width/height — used to skip zero-area / offscreen controls. */
  w: number;
  h: number;
}

/**
 * Enumerate a bounded, deduped set of representative controls in-page.
 * Self-contained: does NOT import enumerateClickables (owned by another lane).
 * Returns a precise selector per representative plus a structural signature.
 * Never throws — returns [] on any failure.
 */
async function findCandidates(page: Page): Promise<Candidate[]> {
  try {
    return await page.evaluate(
      ({ maxCandidates, maxControls }) => {
        const SELECTOR_GROUPS: { sel: string; role: string }[] = [
          { sel: 'button', role: 'button' },
          { sel: 'a[href]', role: 'link' },
          { sel: '[role="button"]', role: 'button' },
          { sel: '[role="tab"]', role: 'tab' },
          { sel: '[role="menuitem"]', role: 'menuitem' },
          { sel: 'input', role: 'input' },
          { sel: 'select', role: 'select' },
          { sel: 'textarea', role: 'textarea' },
        ];

        const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

        /** CSS-escape an attribute value for use inside a selector. */
        const esc = (v: string): string => {
          if (typeof (window as unknown as { CSS?: { escape?: (s: string) => string } }).CSS?.escape === 'function') {
            return (window as unknown as { CSS: { escape: (s: string) => string } }).CSS.escape(v);
          }
          return v.replace(/["\\\]]/g, '\\$&');
        };

        /**
         * Build (internal re-find key, valid CSS selector) for an element.
         * Prefers a unique #id (valid as both). Otherwise the re-find key is a
         * group-scoped positional encoding (resolved on the Node side), while the
         * reported CSS selector is a best-effort human-readable approximation
         * (tag + first class, or the group selector) that stays valid CSS.
         */
        const buildSelector = (
          el: Element,
          groupSel: string,
          groupIndex: number,
        ): { key: string; css: string } => {
          const id = el.getAttribute('id');
          if (id && /^[A-Za-z][\w-]*$/.test(id)) {
            // Validate uniqueness; ids are not guaranteed unique in the wild.
            try {
              if (document.querySelectorAll(`#${esc(id)}`).length === 1) {
                const sel = `#${esc(id)}`;
                return { key: sel, css: sel };
              }
            } catch {
              /* fall through */
            }
          }
          // Best-effort valid CSS approximation for the report.
          const tag = el.tagName.toLowerCase();
          const firstClass =
            el.classList && el.classList.length > 0 ? `.${esc(el.classList[0])}` : '';
          const css = `${tag}${firstClass}` || groupSel;
          // Re-find key: positional within the group's querySelectorAll order.
          return { key: `${groupSel}::screenshotter-nth(${groupIndex})`, css };
        };

        const accessibleName = (el: HTMLElement): string => {
          const aria = el.getAttribute('aria-label');
          if (aria && aria.trim()) return collapse(aria);
          const labelledby = el.getAttribute('aria-labelledby');
          if (labelledby) {
            const ref = document.getElementById(labelledby.split(/\s+/)[0]);
            if (ref) return collapse(ref.innerText || ref.textContent || '');
          }
          const title = el.getAttribute('title');
          if (title && title.trim()) return collapse(title);
          const ph = el.getAttribute('placeholder');
          if (ph && ph.trim()) return collapse(ph);
          const val = (el as HTMLInputElement).value;
          const text = collapse(el.innerText || el.textContent || '');
          if (text) return text;
          if (val && typeof val === 'string') return collapse(val);
          return '';
        };

        const out: Candidate[] = [];
        let scanned = 0;

        for (const group of SELECTOR_GROUPS) {
          let nodes: Element[] = [];
          try {
            nodes = Array.from(document.querySelectorAll(group.sel));
          } catch {
            continue;
          }
          for (let i = 0; i < nodes.length; i++) {
            if (scanned >= maxCandidates) break;
            const el = nodes[i] as HTMLElement;
            scanned++;
            const r = el.getBoundingClientRect();
            if (r.width <= 1 || r.height <= 1) continue;
            // Visible-ish: in or near the viewport-extended document, not hidden.
            const cs = getComputedStyle(el);
            if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;

            const inputEl = el as HTMLInputElement;
            const inputType = (inputEl.type || '').toLowerCase();
            // Skip hidden inputs (no visual state).
            if (group.role === 'input' && inputType === 'hidden') continue;

            const disabled =
              Boolean(inputEl.disabled) ||
              el.getAttribute('aria-disabled') === 'true' ||
              el.hasAttribute('disabled');

            const label = accessibleName(el).slice(0, 120);
            const role =
              group.role === 'input' && inputType ? `input:${inputType}` : group.role;

            // Structural signature: role + tag + sorted class list + type.
            // A grid of identical cards collapses to one representative.
            const classes = collapse(el.className && typeof el.className === 'string' ? el.className : '')
              .split(' ')
              .filter(Boolean)
              .sort()
              .join('.');
            const sig = `${role}|${el.tagName.toLowerCase()}|${inputType}|${classes}`;

            const sel = buildSelector(el, group.sel, i);
            out.push({
              selector: sel.key,
              cssSelector: sel.css,
              label,
              role,
              sig,
              disabled,
              w: Math.round(r.width),
              h: Math.round(r.height),
            });
          }
          if (scanned >= maxCandidates) break;
        }

        // Dedupe by signature, keeping the FIRST occurrence (usually the most
        // prominent / top-of-page instance). Prefer at least one disabled rep
        // and a spread of roles so the sample is representative.
        const bySig = new Map<string, Candidate>();
        const disabledSigs = new Set<string>();
        for (const c of out) {
          if (c.disabled && !disabledSigs.has(c.sig)) {
            // Keep a distinct entry for a disabled instance of this sig.
            disabledSigs.add(c.sig);
            const key = `${c.sig}#disabled`;
            if (!bySig.has(key)) bySig.set(key, c);
            continue;
          }
          if (!bySig.has(c.sig)) bySig.set(c.sig, c);
        }

        const deduped = Array.from(bySig.values());
        // Cap total controls; bias toward role variety by stable-sorting on role.
        deduped.sort((a, b) => a.role.localeCompare(b.role));
        return deduped.slice(0, maxControls);
      },
      { maxCandidates: MAX_CANDIDATES, maxControls: MAX_CONTROLS },
    );
  } catch {
    return [];
  }
}

/**
 * Read the tracked computed styles for the element matched by a candidate.
 * Uses the candidate's selector (with the custom ::screenshotter-nth() encoding
 * resolved back to a querySelectorAll index). Returns null when not found.
 */
async function readComputed(
  page: Page,
  candidate: Candidate,
): Promise<Record<string, string> | null> {
  try {
    return await page.evaluate(
      ({ selector, props }) => {
        const NTH = /^(.*)::screenshotter-nth\((\d+)\)$/;
        let el: Element | null = null;
        const m = selector.match(NTH);
        if (m) {
          const groupSel = m[1];
          const idx = parseInt(m[2], 10);
          let nodes: Element[] = [];
          try {
            nodes = Array.from(document.querySelectorAll(groupSel));
          } catch {
            return null;
          }
          el = nodes[idx] ?? null;
        } else {
          try {
            el = document.querySelector(selector);
          } catch {
            return null;
          }
        }
        if (!el) return null;
        const cs = getComputedStyle(el as HTMLElement);
        const result: Record<string, string> = {};
        for (const p of props) result[p] = cs.getPropertyValue(p).trim();
        return result;
      },
      { selector: candidate.selector, props: TRACKED_PROPS as unknown as string[] },
    );
  } catch {
    return null;
  }
}

/** Resolve a Candidate to a Playwright Locator (handles the nth encoding). */
function locatorFor(page: Page, candidate: Candidate) {
  const NTH = /^(.*)::screenshotter-nth\((\d+)\)$/;
  const m = candidate.selector.match(NTH);
  if (m) {
    const groupSel = m[1];
    const idx = parseInt(m[2], 10);
    return page.locator(groupSel).nth(idx);
  }
  return page.locator(candidate.selector);
}

/** Compute the changed-props delta between resting and a state. */
function styleDelta(
  resting: Record<string, string>,
  next: Record<string, string>,
): Record<string, { from: string; to: string }> {
  const delta: Record<string, { from: string; to: string }> = {};
  for (const prop of TRACKED_PROPS) {
    const from = resting[prop];
    const to = next[prop];
    if (from === undefined || to === undefined) continue;
    if (from !== to) delta[prop] = { from, to };
  }
  return delta;
}

/** Filename-safe slug from a label/role. */
function slug(s: string): string {
  return (s || 'el')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'el';
}

/**
 * Capture interaction states for a bounded, deduped sample of controls on the
 * page. Drives :hover / :focus / :active via Playwright and records the
 * computed-style delta vs resting + a tight clipped screenshot per state.
 *
 * `opts.absDir` — directory to write clipped PNGs into.
 * `opts.relBase` — path of absDir RELATIVE to the bundle mode dir; returned
 *   screenshot paths are joined onto this so they are bundle-mode-relative
 *   (matching how the rest of the bundle stores artifact paths).
 *
 * Best-effort: never throws; returns whatever it managed to capture.
 */
export async function captureElementStates(
  page: Page,
  pageLabel: string,
  pageUrl: string,
  opts: { absDir: string; relBase: string; cfg: ExtractConfig },
): Promise<ElementStatesReport> {
  const report: ElementStatesReport = { page: pageLabel, pageUrl, elements: [] };
  if (!opts.cfg?.elementStates) return report;

  let candidates: Candidate[] = [];
  try {
    candidates = await findCandidates(page);
  } catch {
    candidates = [];
  }
  if (candidates.length === 0) return report;

  // Lazy mkdir only if we have something to capture.
  let dirReady = false;
  const ensureDir = async (): Promise<boolean> => {
    if (dirReady) return true;
    try {
      await mkdir(opts.absDir, { recursive: true });
      dirReady = true;
      return true;
    } catch {
      return false;
    }
  };

  // Bundle-mode-relative path for a written file under absDir.
  const relOf = (filename: string): string =>
    path.posix.join(opts.relBase.split(path.sep).join('/'), filename);

  let seq = 0;
  for (const candidate of candidates) {
    seq++;
    const loc = locatorFor(page, candidate);

    // Confirm the element is still present + visible before driving states.
    let visible = false;
    try {
      visible = await loc.first().isVisible({ timeout: STATE_TIMEOUT_MS });
    } catch {
      visible = false;
    }
    if (!visible) continue;

    const resting = await readComputed(page, candidate);
    if (!resting) continue;

    const states: ElementState[] = [];
    const base = `${seq}-${slug(candidate.role)}-${slug(candidate.label)}`;

    // Which states to drive: disabled controls expose only :disabled (you can't
    // hover/focus/activate them meaningfully); everything else gets the trio.
    const drive: ElementState['state'][] = candidate.disabled
      ? ['disabled']
      : ['hover', 'focus', 'active'];

    for (const state of drive) {
      const shotPath = path.join(opts.absDir, `${base}-${state}.png`);
      let captured: { delta: Record<string, { from: string; to: string }>; screenshot?: string } | null =
        null;

      try {
        if (state === 'disabled') {
          // The resting read IS the disabled state for a natively-disabled
          // control. Delta is empty (no resting baseline differs), but the
          // screenshot + presence is the artifact. Record current computed as-is.
          const now = await readComputed(page, candidate);
          captured = { delta: now ? styleDelta(resting, now) : {} };
        } else if (state === 'hover') {
          await loc.first().hover({ timeout: STATE_TIMEOUT_MS, trial: false });
          const now = await readComputed(page, candidate);
          captured = { delta: now ? styleDelta(resting, now) : {} };
        } else if (state === 'focus') {
          await loc.first().focus({ timeout: STATE_TIMEOUT_MS });
          const now = await readComputed(page, candidate);
          captured = { delta: now ? styleDelta(resting, now) : {} };
        } else if (state === 'active') {
          // :active = pointer held down over the element box. Move to center,
          // press, read, release. Wrapped so a stuck button is always released.
          const box = await loc.first().boundingBox({ timeout: STATE_TIMEOUT_MS });
          if (box) {
            const cx = box.x + box.width / 2;
            const cy = box.y + box.height / 2;
            await page.mouse.move(cx, cy);
            await page.mouse.down();
            try {
              const now = await readComputed(page, candidate);
              captured = { delta: now ? styleDelta(resting, now) : {} };
              if (await ensureDir()) {
                await loc
                  .first()
                  .screenshot({ path: shotPath, timeout: STATE_TIMEOUT_MS })
                  .then(() => {
                    captured!.screenshot = relOf(`${base}-${state}.png`);
                  })
                  .catch(() => {});
              }
            } finally {
              // CRITICAL: release the mouse OFF the element (move away first) so the
              // :active capture NEVER completes a real click. mousedown lands on the
              // control but mouseup lands elsewhere → no click event fires, so this
              // pass can't submit a form / navigate / mutate a logged-in account
              // (it runs on plain --extract, with no safety gate). Always release so
              // a held button can't poison subsequent controls.
              await page.mouse.move(0, 0).catch(() => {});
              await page.mouse.up().catch(() => {});
            }
          }
        }

        // Screenshot for the non-active states (active handled inline above so
        // the shot happens while the button is held).
        if (captured && state !== 'active') {
          if (await ensureDir()) {
            await loc
              .first()
              .screenshot({ path: shotPath, timeout: STATE_TIMEOUT_MS })
              .then(() => {
                captured!.screenshot = relOf(`${base}-${state}.png`);
              })
              .catch(() => {});
          }
        }
      } catch {
        // Per-state failure is non-fatal; keep whatever (if anything) we got.
      }

      if (captured) {
        const entry: ElementState = { state, styleDelta: captured.delta };
        if (captured.screenshot) entry.screenshot = captured.screenshot;
        states.push(entry);
      }

      // Reset transient state between states: blur focus, move mouse away so the
      // next state read starts from a clean resting baseline.
      try {
        await page.mouse.move(0, 0);
        await loc.first().evaluate((el) => (el as HTMLElement).blur?.());
      } catch {
        /* best-effort reset */
      }
    }

    if (states.length > 0) {
      const capture: ElementStateCapture = {
        selector: candidate.cssSelector,
        label: candidate.label,
        role: candidate.role,
        states,
      };
      report.elements.push(capture);
    }
  }

  return report;
}
