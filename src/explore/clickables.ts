// OWNED by Wave 1 / Agent A (clickable enumeration).
// enumerateClickables: one page.evaluate collecting interactive elements with a
// unique selector + accessible label + kind, deduped by kind+label+structure so a
// list of N identical items yields ~1-2 representatives.
//
// Tier-3 coverage upgrades (additive, signature unchanged):
//   - Traverse OPEN shadow roots so in-component controls are reachable; mark
//     them inShadow=true and build a host-anchored selector Playwright can pierce.
//   - Stratify the scan across viewport regions (header/sidebar/main/footer +
//     above/in/below fold) with a PER-REGION dedupe quota, so a long central list
//     can't crowd out a sidebar/header (a busy page used to yield only ~4 actions).
import type { Page } from 'playwright';
import type { Clickable } from '../types';

export async function enumerateClickables(page: Page): Promise<Clickable[]> {
  return page.evaluate(() => {
    try {
      // Cap nodes scanned for the cursor:pointer pass, PER shadow tree, so deep
      // component trees don't blow the budget but each tree still gets coverage.
      const MAX_POINTER_NODES = 1500;
      const MAX_LABEL = 80;
      // Total elements collected as candidates across all trees (hard ceiling so
      // a pathological page can't make page.evaluate run unbounded).
      const MAX_CANDIDATES = 4000;
      // How many distinct controls we keep PER region before deduping the rest
      // away. Generous enough to over-collect; the global sig-dedupe + region
      // quota then trims, but every region is guaranteed representation.
      const PER_REGION_QUOTA = 60;

      // ── helpers ────────────────────────────────────────────────────────────
      const collapseWs = (s: string): string => s.replace(/\s+/g, ' ').trim();

      const isVisible = (el: Element): boolean => {
        try {
          const he = el as HTMLElement;
          const style = window.getComputedStyle(he);
          if (style.display === 'none') return false;
          if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
          if (parseFloat(style.opacity || '1') === 0) return false;
          const rect = he.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          return true;
        } catch {
          return false;
        }
      };

      const isDisabled = (el: Element): boolean => {
        const he = el as HTMLElement & { disabled?: boolean };
        if (he.disabled === true) return true;
        if (el.getAttribute('aria-disabled') === 'true') return true;
        if (el.hasAttribute('disabled')) return true;
        return false;
      };

      const accessibleName = (el: Element): string => {
        const he = el as HTMLElement;
        const candidates: (string | null | undefined)[] = [
          el.getAttribute('aria-label'),
          collapseWs(he.innerText || he.textContent || ''),
          el.getAttribute('title'),
          el.getAttribute('alt'),
          el.getAttribute('placeholder'),
          (el as HTMLInputElement).value,
        ];
        for (const c of candidates) {
          if (c == null) continue;
          const v = collapseWs(String(c));
          if (v) return v.length > MAX_LABEL ? v.slice(0, MAX_LABEL) : v;
        }
        return '';
      };

      const tag = (el: Element): string => el.tagName.toLowerCase();

      const role = (el: Element): string => (el.getAttribute('role') || '').toLowerCase();

      const deriveKind = (el: Element): string => {
        const t = tag(el);
        const r = role(el);
        // An explicit ARIA role overrides the tag's implicit role — that's the role
        // page.getByRole() resolves to (e.g. <button role="menuitem"> answers to
        // 'menuitem', not 'button'), so it must take precedence here or QC's
        // role-based locators won't match.
        if (r === 'link') return 'link';
        if (r === 'button') return 'button';
        if (r === 'tab') return 'tab';
        if (r === 'menuitem') return 'menuitem';
        if (t === 'a' && el.hasAttribute('href')) return 'link';
        if (t === 'button') return 'button';
        if (t === 'input') {
          const it = (el.getAttribute('type') || '').toLowerCase();
          if (it === 'submit' || it === 'button') return 'button';
        }
        if (t === 'summary') return 'summary';
        if (t === 'select') return 'select';
        if (r === 'searchbox') return 'searchbox';
        if (r === 'textbox') return 'textbox';
        if (r === 'combobox' || r === 'listbox') return 'combobox';
        if (r === 'spinbutton') return 'spinbutton';
        // Form fields (text inputs / textareas) — Phase 2.
        if (t === 'textarea') return 'textarea';
        if (t === 'input') {
          const it = (el.getAttribute('type') || 'text').toLowerCase();
          // checkbox/radio/file/range/color behave like clickable controls
          if (it === 'search') return 'searchbox';
          // everything else that accepts text/value is an 'input'
          return 'input';
        }
        return 'pointer';
      };

      // Kinds that represent a fillable text-ish field (vs a clickable control).
      const FILLABLE_KINDS = new Set([
        'input',
        'textarea',
        'searchbox',
        'textbox',
        'spinbutton',
      ]);

      // input[type]s that are clickable controls rather than text fields.
      const CLICKY_INPUT_TYPES = new Set([
        'checkbox',
        'radio',
        'file',
        'range',
        'color',
        'submit',
        'button',
        'reset',
        'image',
      ]);

      const VALID_ID = /^[A-Za-z][\w-]*$/;

      function cssEscapeAttr(v: string): string {
        return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      }

      const TESTID_ATTRS = ['data-testid', 'data-test', 'data-cy'];

      // The root a node lives in: the document, or an open ShadowRoot. We resolve
      // uniqueness WITHIN that root (querySelectorAll is root-scoped), then for
      // shadow nodes prefix a host-anchored path so Playwright (which pierces open
      // shadow DOM for descendant combinators) can re-find them.
      const rootOf = (el: Element): Document | ShadowRoot => {
        const r = el.getRootNode();
        return r as Document | ShadowRoot;
      };

      const isUniqueIn = (root: Document | ShadowRoot, sel: string): boolean => {
        try {
          return root.querySelectorAll(sel).length === 1;
        } catch {
          return false;
        }
      };

      // CSS path of `el` within its own root (no shadow crossing). Mirrors the
      // original nth-of-type chain but scoped to `root` for uniqueness checks.
      const localCssPath = (el: Element, root: Document | ShadowRoot): string => {
        // 1. unique, valid simple id within this root
        const id = el.getAttribute('id');
        if (id && VALID_ID.test(id) && isUniqueIn(root, '#' + id)) return '#' + id;

        // 2. unique testid-style attribute within this root
        for (const attr of TESTID_ATTRS) {
          const val = el.getAttribute(attr);
          if (val) {
            const sel = `[${attr}="${cssEscapeAttr(val)}"]`;
            if (isUniqueIn(root, sel)) return sel;
          }
        }

        // 3. nth-of-type chain up to the root boundary / nearest usable id ancestor
        const segments: string[] = [];
        let cur: Element | null = el;
        while (cur && cur.nodeType === 1 && tag(cur) !== 'html') {
          // Stop at the shadow host boundary: a ShadowRoot's host is not an
          // ancestor reachable via parentElement, so the loop naturally ends at
          // the root's top child — but guard against escaping the root.
          if (cur.getRootNode() !== root) break;

          const curId = cur.getAttribute('id');
          if (curId && VALID_ID.test(curId) && isUniqueIn(root, '#' + curId)) {
            segments.unshift('#' + curId);
            const candidate = segments.join('>');
            if (isUniqueIn(root, candidate)) return candidate;
            break;
          }

          const t = tag(cur);
          let nth = 1;
          let sib = cur.previousElementSibling;
          while (sib) {
            if (tag(sib) === t) nth++;
            sib = sib.previousElementSibling;
          }
          segments.unshift(`${t}:nth-of-type(${nth})`);

          const candidate = segments.join('>');
          if (isUniqueIn(root, candidate)) return candidate;

          if (t === 'body') break;
          cur = cur.parentElement;
        }

        return segments.join('>') || tag(el);
      };

      // Build an actuatable selector for `el`, crossing any number of open shadow
      // boundaries. For a light-DOM node this is just its local path. For a shadow
      // node we chain: <host path in light dom> ' ' <local path in shadow root>,
      // joining hosts with a descendant combinator (space) which Playwright's CSS
      // engine pierces through OPEN shadow roots.
      const buildSelector = (el: Element): string => {
        const parts: string[] = [];
        let node: Element = el;
        // Walk up through shadow roots: each iteration handles one tree.
        // Safety cap on shadow nesting depth.
        for (let guard = 0; guard < 12; guard++) {
          const root = rootOf(node);
          parts.unshift(localCssPath(node, root));
          if (root instanceof ShadowRoot && root.host) {
            node = root.host;
            continue;
          }
          break;
        }
        // Joining with spaces: Playwright pierces open shadow DOM for descendant
        // combinators, so "host inner-control" resolves across the boundary.
        return parts.join(' ');
      };

      const structuralKey = (el: Element): string => {
        const chain: string[] = [tag(el)];
        let p = el.parentElement;
        let count = 0;
        while (p && count < 2) {
          chain.push(tag(p));
          p = p.parentElement;
          count++;
        }
        return chain.join('>');
      };

      const normalizedLabel = (label: string): string =>
        collapseWs(label.toLowerCase().replace(/\d/g, '#'));

      // ── region stratification ────────────────────────────────────────────────
      // Assign each element to a coarse page region by its on-screen position +
      // landmark ancestry. The per-region quota guarantees a busy main list can't
      // starve the header/sidebar/footer of representation.
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;

      // Nearest landmark ancestor tag/role, walking up (and across shadow hosts).
      const landmarkOf = (el: Element): string | null => {
        let cur: Element | null = el;
        let guard = 0;
        while (cur && guard < 60) {
          guard++;
          const t = tag(cur);
          const r = role(cur);
          if (t === 'header' || r === 'banner') return 'header';
          if (t === 'footer' || r === 'contentinfo') return 'footer';
          if (t === 'nav' || r === 'navigation') return 'nav';
          if (t === 'aside' || r === 'complementary') return 'aside';
          if (t === 'main' || r === 'main') return 'main';
          let next: Element | null = cur.parentElement;
          if (!next) {
            const root = cur.getRootNode();
            if (root instanceof ShadowRoot && root.host) next = root.host;
          }
          cur = next;
        }
        return null;
      };

      // Region = landmark (if any) else a geometric band. This keeps both the
      // semantic structure AND raw screen coverage represented.
      const regionOf = (el: Element): string => {
        const lm = landmarkOf(el);
        if (lm) return lm;
        let rect: DOMRect;
        try {
          rect = (el as HTMLElement).getBoundingClientRect();
        } catch {
          return 'other';
        }
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        // Vertical band relative to the viewport/fold.
        const band = cy < vh * 0.15 ? 'top' : cy > vh ? 'belowfold' : cy > vh * 0.85 ? 'bottom' : 'mid';
        // Horizontal band (left rail / center / right rail).
        const col = cx < vw * 0.22 ? 'left' : cx > vw * 0.78 ? 'right' : 'center';
        return `${band}-${col}`;
      };

      // ── menu hints ───────────────────────────────────────────────────────────
      const HASPOPUP_VALUES = new Set(['menu', 'listbox', 'dialog', 'grid', 'tree', 'true']);

      // A disclosure trigger: aria-haspopup (menu/listbox/dialog/grid/tree/true),
      // any aria-expanded, a <summary>, or aria-controls.
      const isDisclosureTrigger = (el: Element): boolean => {
        const hp = (el.getAttribute('aria-haspopup') || '').toLowerCase();
        if (hp && HASPOPUP_VALUES.has(hp)) return true;
        if (el.hasAttribute('aria-expanded')) return true;
        if (tag(el) === 'summary') return true;
        if (el.hasAttribute('aria-controls')) return true;
        return false;
      };

      // Visible per the menu-ancestor rule: non-zero bounding box and not
      // display:none / visibility:hidden.
      const isMenuAncestorVisible = (el: Element): boolean => {
        try {
          const style = window.getComputedStyle(el as HTMLElement);
          if (style.display === 'none') return false;
          if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          return true;
        } catch {
          return false;
        }
      };

      const MENU_ANCESTOR_SEL =
        '[role=menu],[role=listbox],[role=dialog],[aria-modal="true"],dialog[open],[aria-expanded="true"]';

      // Inside a visible open menu/listbox/dialog/expanded popover: walk up parents
      // AND across shadow-host boundaries (a popover may live in a component root).
      const isInMenu = (el: Element): boolean => {
        let cur: Element | null = el.parentElement;
        let guard = 0;
        while (cur && cur.nodeType === 1 && guard < 80) {
          guard++;
          try {
            if (cur.matches(MENU_ANCESTOR_SEL) && isMenuAncestorVisible(cur)) return true;
          } catch {
            // ignore unmatchable selector edge cases
          }
          let next: Element | null = cur.parentElement;
          if (!next) {
            const root = cur.getRootNode();
            if (root instanceof ShadowRoot && root.host) next = root.host;
          }
          cur = next;
        }
        return false;
      };

      // ── collect candidate nodes (light DOM + open shadow roots) ───────────────
      const selectorList = [
        'button',
        'a[href]',
        '[role=button]',
        '[role=tab]',
        '[role=menuitem]',
        '[role=link]',
        'summary',
        'details > summary',
        '[onclick]',
        'input[type=submit]',
        'input[type=button]',
        'select',
        // Phase 2 — fillable form fields + remaining inputs (text/email/number/…).
        'textarea',
        'input:not([type=hidden])',
        '[role=textbox]',
        '[role=searchbox]',
        '[role=spinbutton]',
        '[role=combobox]',
        '[role=listbox]',
      ].join(',');

      const seen = new Set<Element>();
      // Candidate carries whether it was found inside an open shadow root.
      const candidates: { el: Element; inShadow: boolean }[] = [];

      const pushCandidate = (el: Element, inShadow: boolean): void => {
        if (candidates.length >= MAX_CANDIDATES) return;
        if (seen.has(el)) return;
        seen.add(el);
        candidates.push({ el, inShadow });
      };

      // Recursively scan a root (document or shadow root) for matching controls +
      // cursor:pointer elements, then descend into every OPEN shadow root within.
      const scanRoot = (root: Document | ShadowRoot, inShadow: boolean): void => {
        if (candidates.length >= MAX_CANDIDATES) return;

        try {
          const matches = root.querySelectorAll(selectorList);
          for (const el of Array.from(matches)) pushCandidate(el, inShadow);
        } catch {
          // ignore unmatchable selector edge cases for this root
        }

        // Walk every element in this root: cursor:pointer detection is bounded
        // (expensive getComputedStyle), but OPEN-shadow-root DESCENT is NOT — a
        // web component nested past the pointer cap must still be pierced or its
        // controls become unreachable.
        let all: NodeListOf<Element> | Element[] = [];
        try {
          all = root.querySelectorAll('*');
        } catch {
          all = [];
        }
        const pointerLimit = Math.min(all.length, MAX_POINTER_NODES);
        for (let i = 0; i < all.length; i++) {
          if (candidates.length >= MAX_CANDIDATES) break;
          const el = all[i];
          // Bounded cursor:pointer pass (only for not-yet-seen elements).
          if (i < pointerLimit && !seen.has(el)) {
            let cursorPointer = false;
            try {
              cursorPointer = window.getComputedStyle(el).cursor === 'pointer';
            } catch {
              cursorPointer = false;
            }
            if (cursorPointer && accessibleName(el)) pushCandidate(el, inShadow);
          }
          // Descend into an OPEN shadow root, if present (uncapped).
          const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
          if (sr) scanRoot(sr, true);
        }
      };

      scanRoot(document, false);

      // document-order sort within the LIGHT DOM; shadow nodes can't be compared
      // by compareDocumentPosition against light nodes reliably across roots, so
      // we keep insertion order for cross-root ties (scanRoot already visits in a
      // depth-first, document-ish order).
      candidates.sort((a, b) => {
        if (a.el === b.el) return 0;
        try {
          const pos = a.el.compareDocumentPosition(b.el);
          if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
          if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        } catch {
          // disconnected / cross-root — fall through to stable (0)
        }
        return 0;
      });

      // ── build Clickables + dedupe (region-quota aware) ───────────────────────
      interface Out {
        selector: string;
        label: string;
        kind: string;
        sameOriginHref?: string;
        inMenu?: boolean;
        opensMenu?: boolean;
        inputType?: string;
        required?: boolean;
        pattern?: string;
        placeholder?: string;
        options?: string[];
        inShadow?: boolean;
      }

      const isRequired = (el: Element): boolean => {
        if ((el as HTMLInputElement).required === true) return true;
        if (el.hasAttribute('required')) return true;
        if (el.getAttribute('aria-required') === 'true') return true;
        return false;
      };

      // For <select>/listbox: harvest option labels (bounded).
      const optionLabels = (el: Element): string[] | undefined => {
        const out: string[] = [];
        if (tag(el) === 'select') {
          const opts = (el as HTMLSelectElement).options;
          for (let i = 0; i < opts.length && out.length < 30; i++) {
            const v = collapseWs(opts[i].textContent || opts[i].value || '');
            if (v) out.push(v.length > MAX_LABEL ? v.slice(0, MAX_LABEL) : v);
          }
        } else {
          // listbox/combobox: read child [role=option]s.
          const opts = el.querySelectorAll('[role=option]');
          for (let i = 0; i < opts.length && out.length < 30; i++) {
            const v = collapseWs((opts[i] as HTMLElement).innerText || opts[i].textContent || '');
            if (v) out.push(v.length > MAX_LABEL ? v.slice(0, MAX_LABEL) : v);
          }
        }
        return out.length > 0 ? out : undefined;
      };

      const out: Out[] = [];
      const sigSeen = new Set<string>();
      // Per-region acceptance count, so no single region can monopolize output.
      const regionCount = new Map<string, number>();

      for (const cand of candidates) {
        const el = cand.el;
        if (!isVisible(el)) continue;
        if (isDisabled(el)) continue;

        const label = accessibleName(el);
        const kind = deriveKind(el);

        // require a usable identity: a label OR (for links) an href OR (for form
        // fields) a name/placeholder/type — unlabeled inputs are still actuatable.
        const t = tag(el);
        const isLink = t === 'a' && el.hasAttribute('href');
        const isFormField =
          t === 'select' ||
          t === 'textarea' ||
          (t === 'input' &&
            !CLICKY_INPUT_TYPES.has((el.getAttribute('type') || 'text').toLowerCase())) ||
          FILLABLE_KINDS.has(kind) ||
          kind === 'combobox' ||
          kind === 'select';
        const fieldId = el.getAttribute('name') || el.getAttribute('placeholder') || '';
        if (!label && !isLink && !(isFormField && fieldId)) continue;

        // For form fields with no accessible name, fall back to name/placeholder so
        // dedupe + behavior labelling have something stable.
        const effLabel = label || (isFormField ? collapseWs(fieldId) : '');

        // Region-scoped signature dedupe: identical-looking controls collapse, but
        // the SAME label in two different regions (e.g. "Edit" in a row vs in the
        // toolbar) survive — coverage without explosion.
        const region = regionOf(el);
        const sig = `${region}|${kind}|${normalizedLabel(effLabel)}|${structuralKey(el)}`;
        if (sigSeen.has(sig)) continue;

        // Per-region quota: once a region is saturated, only let through controls
        // that open a menu (high exploration value) — list rows have no reason to
        // keep flooding past the quota.
        const rc = regionCount.get(region) || 0;
        const opensMenu = isDisclosureTrigger(el);
        if (rc >= PER_REGION_QUOTA && !opensMenu && !isLink) continue;

        sigSeen.add(sig);
        regionCount.set(region, rc + 1);

        const item: Out = {
          selector: buildSelector(el),
          label: effLabel,
          kind,
          opensMenu,
          inMenu: isInMenu(el),
        };
        if (cand.inShadow) item.inShadow = true;

        // Phase 2: form-field metadata.
        if (isFormField) {
          if (t === 'input') {
            item.inputType = (el.getAttribute('type') || 'text').toLowerCase();
          } else if (t === 'textarea') {
            item.inputType = 'textarea';
          }
          if (isRequired(el)) item.required = true;
          const pat = el.getAttribute('pattern') || el.getAttribute('inputmode');
          if (pat) item.pattern = pat;
          const ph = el.getAttribute('placeholder');
          if (ph) item.placeholder = collapseWs(ph).slice(0, MAX_LABEL);
          if (t === 'select' || kind === 'combobox' || kind === 'select') {
            const opts = optionLabels(el);
            if (opts) item.options = opts;
          }
        }

        if (isLink) {
          const href = el.getAttribute('href') || '';
          try {
            const resolved = new URL(href, location.href);
            if (resolved.host === location.host) {
              item.sameOriginHref = resolved.href;
            }
          } catch {
            // unresolvable href (e.g. "javascript:") — leave undefined
          }
        }

        out.push(item);
      }

      return out;
    } catch {
      return [];
    }
  });
}
