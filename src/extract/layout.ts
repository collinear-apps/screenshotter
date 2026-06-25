// TIER 3 — exact box-model geometry. OWNED by Lane SURFACES.
// Captures precise rect + key computed box properties for ~20-40 landmark elements
// per page/viewport, so the rebuild can match spacing/structure exactly instead of
// eyeballing it.
import type { Page } from 'playwright';
import type { LayoutBox, LayoutCapture } from '../types';

/** Hard cap on captured landmark boxes (~20-40 in practice). */
const MAX_BOXES = 40;

/**
 * Capture box-model geometry for landmark elements (header/nav/main/sections/cards/
 * primary controls). Best-effort; never throws — returns an empty capture on error.
 */
export async function captureLayout(
  page: Page,
  pageLabel: string,
  pageUrl: string,
): Promise<LayoutCapture> {
  let data: { viewport: { width: number; height: number }; boxes: LayoutBox[] } | null = null;
  try {
    data = await page.evaluate(
      ({ maxBoxes }) => {
        const tag = (el: Element): string => el.tagName.toLowerCase();
        const round = (n: number): number => Math.round(n * 10) / 10;

        const cssEsc = (s: string): string => {
          try {
            return (window as unknown as { CSS?: { escape(v: string): string } }).CSS
              ? CSS.escape(s)
              : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
          } catch {
            return s;
          }
        };

        const selectorFor = (el: Element): string => {
          const id = el.getAttribute('id');
          if (id && /^[A-Za-z][\w-]*$/.test(id)) {
            try {
              if (document.querySelectorAll('#' + cssEsc(id)).length === 1) return '#' + cssEsc(id);
            } catch {
              /* ignore */
            }
          }
          const role = el.getAttribute('role');
          if (role) {
            const sel = `${tag(el)}[role="${role}"]`;
            try {
              if (document.querySelectorAll(sel).length === 1) return sel;
            } catch {
              /* ignore */
            }
          }
          const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)[0];
          if (cls) {
            const sel = `${tag(el)}.${cssEsc(cls)}`;
            try {
              if (document.querySelectorAll(sel).length === 1) return sel;
            } catch {
              /* ignore */
            }
          }
          const parent = el.parentElement;
          if (parent) {
            const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
            const idx = same.indexOf(el);
            if (idx >= 0) {
              const parentSel = parent.id && /^[A-Za-z][\w-]*$/.test(parent.id)
                ? '#' + cssEsc(parent.id)
                : tag(parent);
              return `${parentSel} > ${tag(el)}:nth-of-type(${idx + 1})`;
            }
          }
          return tag(el);
        };

        const isVisible = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const st = window.getComputedStyle(el);
          return st.display !== 'none' && st.visibility !== 'hidden';
        };

        // Box props that drive layout fidelity. Only kept when meaningfully set.
        const BOX_PROPS = [
          'display',
          'position',
          'boxSizing',
          'margin',
          'padding',
          'gap',
          'rowGap',
          'columnGap',
          'flexDirection',
          'flexWrap',
          'justifyContent',
          'alignItems',
          'gridTemplateColumns',
          'gridTemplateRows',
          'gridAutoFlow',
          'width',
          'height',
          'maxWidth',
          'zIndex',
          'overflow',
          'borderRadius',
        ] as const;

        const captureBox = (el: Element): LayoutBox => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const st = window.getComputedStyle(el);
          const box: Record<string, string> = {};
          for (const prop of BOX_PROPS) {
            const v = st[prop as keyof CSSStyleDeclaration] as unknown as string;
            if (v == null) continue;
            const s = String(v);
            // Drop noise: zero/none/normal/auto defaults that add nothing.
            if (s === '' || s === 'none' || s === 'normal' || s === 'auto') continue;
            if (s === '0px' || s === '0px 0px' || s === '0px 0px 0px 0px') continue;
            box[prop] = s;
          }
          const role = el.getAttribute('role') || undefined;
          const labelRaw =
            el.getAttribute('aria-label') ||
            (el as HTMLElement).innerText ||
            el.textContent ||
            '';
          const label = labelRaw.replace(/\s+/g, ' ').trim().slice(0, 80) || undefined;
          return {
            selector: selectorFor(el),
            role,
            label,
            x: round(r.left + window.scrollX),
            y: round(r.top + window.scrollY),
            width: round(r.width),
            height: round(r.height),
            box,
          };
        };

        // ── 1. Structural landmarks + headings (priority order). ─────────────
        const picked: Element[] = [];
        const seen = new Set<Element>();
        const add = (el: Element | null) => {
          if (!el || seen.has(el) || !isVisible(el)) return;
          if (picked.length >= maxBoxes) return;
          seen.add(el);
          picked.push(el);
        };

        const LANDMARK_SEL =
          'header, nav, main, footer, aside, section, ' +
          '[role="banner"], [role="navigation"], [role="main"], [role="contentinfo"], ' +
          '[role="complementary"], [role="search"], [role="region"], ' +
          'h1, h2, h3';
        let landmarks: Element[] = [];
        try {
          landmarks = Array.from(document.querySelectorAll(LANDMARK_SEL));
        } catch {
          landmarks = [];
        }
        for (const el of landmarks) {
          if (picked.length >= maxBoxes) break;
          add(el);
        }

        // ── 2. Largest containers/cards to fill remaining budget. ────────────
        if (picked.length < maxBoxes) {
          let containers: Element[] = [];
          try {
            containers = Array.from(
              document.querySelectorAll('div, ul, ol, article, [class*="card" i], [class*="container" i]'),
            );
          } catch {
            containers = [];
          }
          const scored: { el: Element; area: number }[] = [];
          const lim = Math.min(containers.length, 4000);
          for (let i = 0; i < lim; i++) {
            const el = containers[i];
            if (seen.has(el) || !isVisible(el)) continue;
            const r = (el as HTMLElement).getBoundingClientRect();
            scored.push({ el, area: r.width * r.height });
          }
          scored.sort((a, b) => b.area - a.area);
          for (const { el } of scored) {
            if (picked.length >= maxBoxes) break;
            add(el);
          }
        }

        const boxes = picked.slice(0, maxBoxes).map(captureBox);
        return {
          viewport: {
            width: Math.round(window.innerWidth),
            height: Math.round(window.innerHeight),
          },
          boxes,
        };
      },
      { maxBoxes: MAX_BOXES },
    );
  } catch {
    data = null;
  }

  if (!data) {
    return { page: pageLabel, pageUrl, viewport: { width: 0, height: 0 }, boxes: [] };
  }
  return { page: pageLabel, pageUrl, viewport: data.viewport, boxes: data.boxes };
}
