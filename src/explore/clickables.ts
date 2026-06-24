// OWNED by Wave 1 / Agent A (clickable enumeration).
// enumerateClickables: one page.evaluate collecting interactive elements with a
// unique selector + accessible label + kind, deduped by kind+label+structure so a
// list of N identical items yields ~1-2 representatives.
import type { Page } from 'playwright';
import type { Clickable } from '../types';

export async function enumerateClickables(page: Page): Promise<Clickable[]> {
  return page.evaluate(() => {
    try {
      const MAX_NODES = 1500;
      const MAX_LABEL = 80;

      // ── helpers ────────────────────────────────────────────────────────────
      const collapseWs = (s: string): string => s.replace(/\s+/g, ' ').trim();

      const isVisible = (el: Element): boolean => {
        const he = el as HTMLElement;
        const style = window.getComputedStyle(he);
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        if (parseFloat(style.opacity || '1') === 0) return false;
        const rect = he.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        return true;
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

      const isUnique = (sel: string): boolean => {
        try {
          return document.querySelectorAll(sel).length === 1;
        } catch {
          return false;
        }
      };

      const TESTID_ATTRS = ['data-testid', 'data-test', 'data-cy'];

      const cssPath = (el: Element): string => {
        // 1. unique, valid simple id
        const id = el.getAttribute('id');
        if (id && VALID_ID.test(id) && isUnique('#' + id)) return '#' + id;

        // 2. unique testid-style attribute
        for (const attr of TESTID_ATTRS) {
          const val = el.getAttribute(attr);
          if (val) {
            const sel = `[${attr}="${cssEscapeAttr(val)}"]`;
            if (isUnique(sel)) return sel;
          }
        }

        // 3. nth-of-type chain up to body / nearest usable id ancestor
        const segments: string[] = [];
        let cur: Element | null = el;
        while (cur && cur.nodeType === 1 && tag(cur) !== 'html') {
          // anchor on an ancestor that has a unique valid id
          const curId = cur.getAttribute('id');
          if (curId && VALID_ID.test(curId) && isUnique('#' + curId)) {
            segments.unshift('#' + curId);
            const candidate = segments.join('>');
            if (isUnique(candidate)) return candidate;
            // otherwise keep the id segment and stop walking further up
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
          if (isUnique(candidate)) return candidate;

          if (t === 'body') break;
          cur = cur.parentElement;
        }

        // best-effort (engine uses .first() if not unique)
        return segments.join('>') || tag(el);
      };

      function cssEscapeAttr(v: string): string {
        return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      }

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

      // Inside a visible open menu/listbox/dialog/expanded popover: walk up parents.
      const isInMenu = (el: Element): boolean => {
        let cur: Element | null = el.parentElement;
        while (cur && cur.nodeType === 1) {
          try {
            if (cur.matches(MENU_ANCESTOR_SEL) && isMenuAncestorVisible(cur)) return true;
          } catch {
            // ignore unmatchable selector edge cases
          }
          cur = cur.parentElement;
        }
        return false;
      };

      // ── collect candidate nodes ──────────────────────────────────────────────
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
      const candidates: Element[] = [];

      const queryNodes = Array.from(document.querySelectorAll(selectorList));
      for (const el of queryNodes) {
        if (!seen.has(el)) {
          seen.add(el);
          candidates.push(el);
        }
      }

      // cursor:pointer elements that also have an accessible name
      const all = document.querySelectorAll('*');
      const scanLimit = Math.min(all.length, MAX_NODES);
      for (let i = 0; i < scanLimit; i++) {
        const el = all[i];
        if (seen.has(el)) continue;
        let cursorPointer = false;
        try {
          cursorPointer = window.getComputedStyle(el).cursor === 'pointer';
        } catch {
          cursorPointer = false;
        }
        if (!cursorPointer) continue;
        if (!accessibleName(el)) continue;
        seen.add(el);
        candidates.push(el);
      }

      // document-order: querySelectorAll already returns doc order per query,
      // but merged lists may interleave — re-sort by document position.
      candidates.sort((a, b) => {
        if (a === b) return 0;
        const pos = a.compareDocumentPosition(b);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });

      // ── build Clickables + dedupe ──────────────────────────────────────────
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

      for (const el of candidates) {
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

        const sig = `${kind}|${normalizedLabel(effLabel)}|${structuralKey(el)}`;
        if (sigSeen.has(sig)) continue;
        sigSeen.add(sig);

        const item: Out = {
          selector: cssPath(el),
          label: effLabel,
          kind,
          opensMenu: isDisclosureTrigger(el),
          inMenu: isInMenu(el),
        };

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
