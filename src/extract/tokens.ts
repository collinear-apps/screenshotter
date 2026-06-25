// Owned by Wave 1 / Agent K (computed design tokens).
// extractTokens: one page.evaluate tallying computed color/background/border/
// radius/shadow/spacing/font values. aggregateTokens: frequency-rank across pages.
// renderTokensJson / renderTokensMd: emit design-tokens.json / design-tokens.md.
import type { Page } from 'playwright';
import type { DesignTokens, PageTokens, TokenValue } from '../types';

/** Max elements to walk per page (perf cap). */
const MAX_ELEMENTS = 4000;

/** Per-category caps applied during aggregation. */
const CAP_COLORS = 24;
const CAP_DEFAULT = 16;

/** Values that carry no design signal and should never be tallied/ranked. */
const NOISE_VALUES = new Set([
  'transparent',
  'rgba(0, 0, 0, 0)',
  'none',
  '0px',
  'normal',
  'auto',
  '',
]);

/** Returns an all-empty PageTokens (used on extraction failure / page errors). */
function emptyPageTokens(): PageTokens {
  return {
    colors: {},
    backgrounds: {},
    borderColors: {},
    radii: {},
    shadows: {},
    spacing: {},
    fonts: {},
    fontSizes: {},
  };
}

/** Tally computed-style design tokens from one rendered page. */
export async function extractTokens(page: Page): Promise<PageTokens> {
  try {
    return await page.evaluate((maxElements: number) => {
      const empty = {
        colors: {} as Record<string, number>,
        backgrounds: {} as Record<string, number>,
        borderColors: {} as Record<string, number>,
        radii: {} as Record<string, number>,
        shadows: {} as Record<string, number>,
        spacing: {} as Record<string, number>,
        fonts: {} as Record<string, number>,
        fontSizes: {} as Record<string, number>,
      };

      // Values that carry no design signal — skip them so we don't tally defaults.
      const skip = new Set([
        'rgba(0, 0, 0, 0)',
        'transparent',
        'none',
        '0px',
        'normal',
        'auto',
        '',
      ]);

      const bump = (tally: Record<string, number>, raw: string | null | undefined): void => {
        if (raw == null) return;
        const value = raw.trim();
        if (value === '' || skip.has(value)) return;
        tally[value] = (tally[value] ?? 0) + 1;
      };

      // Collect every element, descending into OPEN shadow roots (web
      // components) so encapsulated tokens are tallied too. Bounded by
      // maxElements. Inlined here (no cross-module import) and defensive.
      const all: Element[] = [];
      const collect = (root: ParentNode): void => {
        let kids: HTMLCollection;
        try {
          kids = root.children;
        } catch {
          return;
        }
        for (let k = 0; k < kids.length; k++) {
          if (all.length >= maxElements) return;
          const el = kids[k];
          all.push(el);
          let shadow: ShadowRoot | null = null;
          try {
            shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot || null;
          } catch {
            shadow = null;
          }
          if (shadow) collect(shadow);
          collect(el);
        }
      };
      try {
        const docEl = document.documentElement;
        if (docEl) {
          all.push(docEl); // include <html>, matching querySelectorAll('*')
          collect(docEl);
        }
      } catch {
        /* leave `all` as whatever was collected */
      }
      const limit = all.length;

      for (let i = 0; i < limit; i++) {
        const el = all[i] as Element;

        // Skip invisible / zero-size elements.
        let style: CSSStyleDeclaration;
        try {
          style = window.getComputedStyle(el);
        } catch {
          continue;
        }
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        bump(empty.colors, style.color);
        bump(empty.backgrounds, style.backgroundColor);

        // Border color only when there is an actual (non-zero) border drawn.
        const borderWidth = parseFloat(style.borderTopWidth || '0');
        if (Number.isFinite(borderWidth) && borderWidth > 0) {
          bump(empty.borderColors, style.borderTopColor);
        }

        // Radius only when rounded.
        if (style.borderTopLeftRadius && style.borderTopLeftRadius !== '0px') {
          bump(empty.radii, style.borderTopLeftRadius);
        }

        // Shadow only when present.
        if (style.boxShadow && style.boxShadow !== 'none') {
          bump(empty.shadows, style.boxShadow);
        }

        // Spacing: distinct non-zero px values from padding / margin / gap.
        const spacingProps = [
          style.paddingTop,
          style.paddingRight,
          style.paddingBottom,
          style.paddingLeft,
          style.marginTop,
          style.marginRight,
          style.marginBottom,
          style.marginLeft,
          style.gap,
          style.rowGap,
          style.columnGap,
        ];
        for (const sp of spacingProps) {
          // gap shorthand can resolve to "10px 20px"; split into individual values.
          if (!sp) continue;
          for (const part of sp.split(/\s+/)) {
            bump(empty.spacing, part);
          }
        }

        // Font family: first family only, stripped of quotes/whitespace.
        const family = (style.fontFamily || '').split(',')[0]?.replace(/['"]/g, '').trim();
        bump(empty.fonts, family);

        bump(empty.fontSizes, style.fontSize);
      }

      return empty;
    }, MAX_ELEMENTS);
  } catch {
    return emptyPageTokens();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS custom properties (theme variables) — Phase 3, cfg.extract.cssVars.
// Harvested as a sidecar map so PageTokens stays untouched. The pipeline calls
// extractCssVars() per page, aggregateCssVars() across pages, then renders.
// ─────────────────────────────────────────────────────────────────────────────

/** One CSS custom property and its resolved value, with where it was declared. */
export interface CssVar {
  name: string;
  value: string;
  /** ':root' for document-level vars, else a compact selector hint. */
  scope: string;
}

/** Per-page harvested custom properties (declaration-site, not just computed). */
export interface PageCssVars {
  url: string;
  vars: CssVar[];
}

/** Cap on vars collected per page (defensive against generated utility CSS). */
const MAX_CSS_VARS = 600;

/**
 * Harvest CSS custom properties from a rendered page. Walks every same-origin
 * stylesheet's rules for `--*` declarations (the AUTHORED values, e.g.
 * `--color-primary: #fff`), keyed by their selector scope (`:root`, `.dark`, …).
 * Cross-origin sheets whose `cssRules` throw are skipped. Falls back to reading
 * computed `--*` off :root when no rules are accessible. Never throws.
 */
export async function extractCssVars(page: Page): Promise<PageCssVars> {
  let vars: CssVar[] = [];
  try {
    vars = await page.evaluate((cap: number) => {
      const out: { name: string; value: string; scope: string }[] = [];
      const seen = new Set<string>();
      const add = (name: string, value: string, scope: string): void => {
        if (out.length >= cap) return;
        if (!name.startsWith('--')) return;
        const v = (value ?? '').trim();
        if (!v) return;
        const key = `${scope}|${name}|${v}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ name, value: v, scope });
      };

      // 1. Walk authored stylesheet rules for --* declarations.
      const sheets = Array.from(document.styleSheets);
      for (const sheet of sheets) {
        let rules: CSSRuleList | undefined;
        try {
          rules = sheet.cssRules; // throws for cross-origin sheets
        } catch {
          continue;
        }
        if (!rules) continue;
        for (let i = 0; i < rules.length && out.length < cap; i++) {
          const rule = rules[i] as CSSStyleRule;
          const style = rule.style;
          if (!style || typeof style.length !== 'number') continue;
          const scope = (rule.selectorText || '').slice(0, 60) || ':root';
          for (let j = 0; j < style.length; j++) {
            const prop = style[j];
            if (prop && prop.startsWith('--')) {
              add(prop, style.getPropertyValue(prop), scope);
            }
          }
        }
      }

      // 2. Fallback / augment: computed --* on :root (resolves vars not reachable
      //    via authored rules, e.g. injected at runtime).
      try {
        const rootStyle = getComputedStyle(document.documentElement);
        for (let i = 0; i < rootStyle.length && out.length < cap; i++) {
          const prop = rootStyle[i];
          if (prop && prop.startsWith('--')) {
            add(prop, rootStyle.getPropertyValue(prop), ':root');
          }
        }
      } catch {
        /* ignore */
      }

      // 3. Shadow DOM (web components): harvest --* declarations from each open
      //    shadow root's adoptedStyleSheets AND its inner <style> rules, so
      //    encapsulated theme variables are counted. Bounded element walk; never
      //    throws. Scope is tagged "shadow:<host-tag>" for provenance.
      const MAX_SHADOW_HOSTS = 2000;
      let hostBudget = MAX_SHADOW_HOSTS;
      const addFromRules = (rules: CSSRuleList | undefined, scope: string): void => {
        if (!rules) return;
        for (let i = 0; i < rules.length && out.length < cap; i++) {
          const rule = rules[i] as CSSStyleRule;
          const style = rule.style;
          if (!style || typeof style.length !== 'number') continue;
          for (let j = 0; j < style.length; j++) {
            const prop = style[j];
            if (prop && prop.startsWith('--')) {
              add(prop, style.getPropertyValue(prop), scope);
            }
          }
        }
      };
      const walkShadow = (rootNode: ParentNode): void => {
        if (out.length >= cap) return;
        let kids: HTMLCollection;
        try {
          kids = rootNode.children;
        } catch {
          return;
        }
        for (let k = 0; k < kids.length && out.length < cap; k++) {
          const el = kids[k];
          let shadow: ShadowRoot | null = null;
          try {
            shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot || null;
          } catch {
            shadow = null;
          }
          if (shadow && hostBudget-- > 0) {
            const scope = `shadow:${el.tagName.toLowerCase()}`;
            // 3a. adoptedStyleSheets (constructable stylesheets).
            let sheets: readonly CSSStyleSheet[] = [];
            try {
              sheets = (shadow as unknown as { adoptedStyleSheets?: CSSStyleSheet[] })
                .adoptedStyleSheets || [];
            } catch {
              sheets = [];
            }
            for (const sheet of sheets) {
              try {
                addFromRules(sheet.cssRules, scope);
              } catch {
                /* ignore cross-origin / unreadable sheet */
              }
            }
            // 3b. <style> elements rendered inside the shadow root.
            let styleEls: NodeListOf<HTMLStyleElement>;
            try {
              styleEls = shadow.querySelectorAll('style');
            } catch {
              styleEls = [] as unknown as NodeListOf<HTMLStyleElement>;
            }
            styleEls.forEach((styleEl) => {
              try {
                addFromRules(styleEl.sheet?.cssRules, scope);
              } catch {
                /* ignore */
              }
            });
            walkShadow(shadow);
          }
          walkShadow(el);
        }
      };
      try {
        if (document.documentElement) walkShadow(document.documentElement);
      } catch {
        /* ignore */
      }

      return out;
    }, MAX_CSS_VARS);
  } catch {
    vars = [];
  }
  let url = '';
  try {
    url = page.url();
  } catch {
    /* ignore */
  }
  return { url, vars };
}

/**
 * Aggregate harvested custom properties across pages into a stable
 * name → { value, scope } map. When the same var name appears with different
 * values across scopes/pages, the MOST FREQUENT value wins (ties broken
 * lexicographically) so the canonical theme value is surfaced; alternate
 * scoped values (e.g. dark-mode overrides) are retained in `byScope`.
 */
export interface AggregatedCssVars {
  /** Canonical value per var name (most frequent across pages). */
  vars: Record<string, string>;
  /** All observed (scope → value) per var name (e.g. :root vs .dark). */
  byScope: Record<string, Record<string, string>>;
  pageCount: number;
}

export function aggregateCssVars(pages: PageCssVars[]): AggregatedCssVars {
  // name → value → count   and   name → scope → value
  const counts: Record<string, Record<string, number>> = {};
  const byScope: Record<string, Record<string, string>> = {};
  for (const page of pages) {
    for (const { name, value, scope } of page.vars) {
      (counts[name] ??= {})[value] = (counts[name][value] ?? 0) + 1;
      (byScope[name] ??= {})[scope] = value;
    }
  }
  const vars: Record<string, string> = {};
  for (const [name, valueCounts] of Object.entries(counts)) {
    const best = Object.entries(valueCounts).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0];
    if (best) vars[name] = best[0];
  }
  return { vars, byScope, pageCount: pages.length };
}

/** Serialize aggregated CSS variables to a stable JSON document. */
export function renderCssVarsJson(agg: AggregatedCssVars): string {
  return JSON.stringify(agg, null, 2);
}

/** Merge per-page tallies into ranked TokenValue[] for one category. */
function rank(
  pages: PageTokens[],
  key: keyof PageTokens,
  cap: number,
): TokenValue[] {
  const totals: Record<string, number> = {};
  for (const page of pages) {
    const tally = page[key];
    if (!tally) continue;
    for (const [value, count] of Object.entries(tally)) {
      const trimmed = value.trim();
      if (NOISE_VALUES.has(trimmed)) continue;
      totals[trimmed] = (totals[trimmed] ?? 0) + count;
    }
  }
  return Object.entries(totals)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => (b.count - a.count) || a.value.localeCompare(b.value))
    .slice(0, cap);
}

/** Merge per-page design-token tallies into a single cross-page summary. */
export function aggregateTokens(pages: PageTokens[]): DesignTokens {
  return {
    colors: rank(pages, 'colors', CAP_COLORS),
    backgrounds: rank(pages, 'backgrounds', CAP_COLORS),
    borderColors: rank(pages, 'borderColors', CAP_DEFAULT),
    radii: rank(pages, 'radii', CAP_DEFAULT),
    shadows: rank(pages, 'shadows', CAP_DEFAULT),
    spacing: rank(pages, 'spacing', CAP_DEFAULT),
    fontFamilies: rank(pages, 'fonts', CAP_DEFAULT),
    fontSizes: rank(pages, 'fontSizes', CAP_DEFAULT),
    pageCount: pages.length,
  };
}

/** Serializes design tokens to a stable JSON document. */
export function renderTokensJson(tokens: DesignTokens): string {
  return JSON.stringify(tokens, null, 2);
}

/** Renders the design-tokens.md markdown document. */
export function renderTokensMd(tokens: DesignTokens, siteName: string): string {
  const lines: string[] = [];

  lines.push(`# Design tokens — ${siteName}`);
  lines.push('');
  lines.push(`_Auto-extracted from ${tokens.pageCount} page(s)._`);
  lines.push('');

  const section = (title: string, values: TokenValue[]): void => {
    lines.push(`## ${title}`);
    if (values.length === 0) {
      lines.push('');
      lines.push('_none captured_');
    } else {
      for (const { value, count } of values) {
        lines.push(`- ${value} (${count} uses)`);
      }
    }
    lines.push('');
  };

  section('Colors', tokens.colors);
  section('Backgrounds', tokens.backgrounds);
  section('Border colors', tokens.borderColors);
  section('Font families', tokens.fontFamilies);
  section('Font sizes', tokens.fontSizes);
  section('Spacing', tokens.spacing);
  section('Radii', tokens.radii);
  section('Shadows', tokens.shadows);

  return lines.join('\n');
}
