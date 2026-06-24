// PHASE 2 — content extraction. OWNED by Lane 2.
// Extracts structured rows from listing pages (repeated card/row grids) so the
// rebuild has real records, not just a screenshot + one HTML blob.
//
// Heuristic: find the parent whose direct children form the largest group of
// structurally-similar siblings (>= MIN_ITEMS). For each item, harvest visible
// field text keyed by role/heading/link plus the item's primary href.
import type { Page } from 'playwright';
import type { ListingExtract, ListingRow } from '../types';

const MIN_ITEMS = 4;

/**
 * Detect the dominant repeated container on a page and extract one record per item.
 * Returns a ListingExtract, or null when no qualifying repeated grid is found.
 * Best-effort; never throws.
 */
export async function extractListings(
  page: Page,
  pageLabel: string,
  pageUrl: string,
): Promise<ListingExtract | null> {
  let result: { container: string; rows: ListingRow[] } | null = null;
  try {
    result = await page.evaluate(
      ({ minItems }) => {
        const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
        const MAX_FIELD = 200;
        const MAX_ROWS = 60;
        const cap = (s: string): string => (s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) : s);

        const isVisible = (el: Element): boolean => {
          const he = el as HTMLElement;
          const st = window.getComputedStyle(he);
          if (st.display === 'none' || st.visibility === 'hidden') return false;
          const r = he.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };

        const tag = (el: Element): string => el.tagName.toLowerCase();

        // A child's structural signature: tag + sorted class tokens (capped) — so
        // siblings rendered by the same template hash to the same key.
        const childSig = (el: Element): string => {
          const cls = (el.getAttribute('class') || '')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 4)
            .sort()
            .join('.');
          const role = el.getAttribute('role') || '';
          return `${tag(el)}|${role}|${cls}`;
        };

        // A stable-ish selector for the container (id > role > tag.firstclass).
        const containerSelector = (el: Element): string => {
          const id = el.getAttribute('id');
          if (id && /^[A-Za-z][\w-]*$/.test(id)) {
            try {
              if (document.querySelectorAll('#' + id).length === 1) return '#' + id;
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
            const sel = `${tag(el)}.${CSS.escape(cls)}`;
            try {
              if (document.querySelectorAll(sel).length <= 3) return sel;
            } catch {
              /* ignore */
            }
          }
          return tag(el);
        };

        // ── 1. Find the parent whose children form the largest similar group. ──
        type Cand = { parent: Element; items: Element[]; size: number };
        let best: Cand | null = null;

        const parents = document.querySelectorAll(
          'ul, ol, [role=list], [role=grid], [role=feed], div, section, main, tbody',
        );
        const limit = Math.min(parents.length, 4000);
        for (let i = 0; i < limit; i++) {
          const parent = parents[i];
          const children = Array.from(parent.children);
          if (children.length < minItems) continue;

          // Group direct children by structural signature.
          const groups = new Map<string, Element[]>();
          for (const ch of children) {
            if (!isVisible(ch)) continue;
            const sig = childSig(ch);
            const arr = groups.get(sig);
            if (arr) arr.push(ch);
            else groups.set(sig, [ch]);
          }
          let topSig = '';
          let topArr: Element[] = [];
          for (const [sig, arr] of groups) {
            if (arr.length > topArr.length) {
              topArr = arr;
              topSig = sig;
            }
          }
          void topSig;
          if (topArr.length < minItems) continue;
          // Prefer the deepest/most-specific container (more items, then deeper).
          const size = topArr.length;
          if (!best || size > best.size) {
            best = { parent, items: topArr, size };
          }
        }

        if (!best) return null;

        // ── 2. Extract one row per item. ───────────────────────────────────────
        const rows: { fields: Record<string, string>; href?: string }[] = [];
        const items = best.items.slice(0, MAX_ROWS);
        for (const item of items) {
          const fields: Record<string, string> = {};

          // Primary href: first in-document anchor.
          let href: string | undefined;
          const anchor = item.matches('a[href]')
            ? (item as HTMLAnchorElement)
            : (item.querySelector('a[href]') as HTMLAnchorElement | null);
          if (anchor) {
            try {
              href = new URL(anchor.getAttribute('href') || '', location.href).href;
            } catch {
              href = anchor.getAttribute('href') || undefined;
            }
          }

          // Headings → title fields.
          const heading = item.querySelector('h1,h2,h3,h4,h5,h6,[role=heading]');
          if (heading) {
            const t = collapse((heading as HTMLElement).innerText || heading.textContent || '');
            if (t) fields.title = cap(t);
          }

          // Link text (if not already the title).
          if (anchor) {
            const lt = collapse(anchor.innerText || anchor.textContent || '');
            if (lt && lt !== fields.title) fields.link = cap(lt);
          }

          // Time / date.
          const time = item.querySelector('time, [datetime]');
          if (time) {
            const dt =
              time.getAttribute('datetime') ||
              collapse((time as HTMLElement).innerText || time.textContent || '');
            if (dt) fields.date = cap(dt);
          }

          // Author / by-line via common attributes.
          const author = item.querySelector(
            '[itemprop=author], [rel=author], [class*="author" i], [class*="owner" i]',
          );
          if (author) {
            const at = collapse((author as HTMLElement).innerText || author.textContent || '');
            if (at) fields.author = cap(at);
          }

          // Explicit data-attribute fields (data-key="value" on the item).
          for (const attr of Array.from(item.attributes)) {
            if (attr.name.startsWith('data-') && attr.value && attr.value.length <= MAX_FIELD) {
              const key = attr.name.replace(/^data-/, '');
              if (key && !fields[key]) fields[key] = cap(collapse(attr.value));
            }
          }

          // Fallback: whole-item visible text when nothing structured was found.
          if (Object.keys(fields).length === 0) {
            const txt = collapse((item as HTMLElement).innerText || item.textContent || '');
            if (txt) fields.text = cap(txt);
          }

          if (Object.keys(fields).length > 0 || href) {
            rows.push(href ? { fields, href } : { fields });
          }
        }

        if (rows.length < minItems) return null;
        return { container: containerSelector(best.parent), rows };
      },
      { minItems: MIN_ITEMS },
    );
  } catch {
    return null;
  }

  if (!result || result.rows.length < MIN_ITEMS) return null;
  return {
    page: pageLabel,
    pageUrl,
    container: result.container,
    rows: result.rows,
  };
}
