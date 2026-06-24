// Owned by Wave 1 / Agent D (typography + output).
import type { Page } from 'playwright';
import type { PageTypography, ElementTypeSample } from '../types';

/**
 * Runs a single page.evaluate() that walks visible text elements, groups them by
 * role (h1..h6, p, a, button, code, li, span), and records computed
 * family/size/weight/line-height/letter-spacing/color. Tallies family and text
 * color frequencies. Pure read of the rendered DOM.
 */
export async function extractTypography(page: Page, url: string): Promise<PageTypography> {
  let raw: Omit<PageTypography, 'url'>;
  try {
    raw = await page.evaluate(() => {
      // Local shape mirrors ElementTypeSample (cannot import types inside evaluate).
      type ElementTypeSampleLocal = {
        role: string;
        fontFamily: string;
        fontSize: string;
        fontWeight: string;
        lineHeight: string;
        letterSpacing: string;
        color: string;
      };

      const roles = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'code', 'li', 'span'];
      const MAX_PER_ROLE = 12;

      const elements: ElementTypeSampleLocal[] = [];
      const families: Record<string, number> = {};
      const textColors: Record<string, number> = {};

      const firstFamily = (stack: string): string => {
        const first = stack.split(',')[0] ?? '';
        return first.replace(/["']/g, '').trim();
      };

      const isVisible = (el: Element, style: CSSStyleDeclaration): boolean => {
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      for (const role of roles) {
        const nodes = Array.from(document.querySelectorAll(role));
        let taken = 0;
        for (const el of nodes) {
          if (taken >= MAX_PER_ROLE) break;
          const text = (el.textContent ?? '').trim();
          if (!text) continue;
          const style = window.getComputedStyle(el);
          if (!isVisible(el, style)) continue;

          const sample: ElementTypeSampleLocal = {
            role,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            color: style.color,
          };
          elements.push(sample);
          taken++;

          const fam = firstFamily(style.fontFamily);
          if (fam) families[fam] = (families[fam] ?? 0) + 1;

          const col = style.color;
          if (col) textColors[col] = (textColors[col] ?? 0) + 1;
        }
      }

      return { families, elements, textColors };
    });
  } catch {
    // Non-fatal extraction failure → return an empty-but-valid result.
    return { url, families: {}, elements: [], textColors: {} };
  }

  return {
    url,
    families: raw.families,
    elements: raw.elements as ElementTypeSample[],
    textColors: raw.textColors,
  };
}
