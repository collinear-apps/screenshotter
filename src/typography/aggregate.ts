// Owned by Wave 1 / Agent D (typography + output).
import type {
  PageTypography,
  AggregatedTypography,
  ElementTypeSample,
  TypeScaleRow,
} from '../types';

const MONO_RE = /mono|consolas|menlo|courier|code/i;
const MAX_COLORS = 12;

/** Display order for type-scale rows; anything else trails after. */
const ROLE_ORDER = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'body', 'a', 'button', 'li', 'code'];

/** Parse "36px" → 36 for tie-breaking; non-px / unparsable → 0. */
function pxValue(size: string): number {
  const n = parseFloat(size);
  return Number.isFinite(n) ? n : 0;
}

/** Merges per-page typography into a single cross-page summary. */
export function aggregateTypography(pages: PageTypography[]): AggregatedTypography {
  const pageCount = pages.length;

  // ── Families ────────────────────────────────────────────────────────────
  const familyTotals: Record<string, number> = {};
  for (const page of pages) {
    for (const [family, count] of Object.entries(page.families)) {
      familyTotals[family] = (familyTotals[family] ?? 0) + count;
    }
  }
  const families = Object.entries(familyTotals)
    .map(([family, count]) => ({ family, count }))
    .sort((a, b) => b.count - a.count);

  // bodyFamily: most common family overall, preferring a non-mono one if it exists.
  let bodyFamily: string | undefined;
  const firstNonMono = families.find((f) => !MONO_RE.test(f.family));
  if (firstNonMono) {
    bodyFamily = firstNonMono.family;
  } else if (families.length > 0) {
    bodyFamily = families[0].family;
  }

  // monoFamily: most common family matching the mono pattern.
  const monoFamily = families.find((f) => MONO_RE.test(f.family))?.family;

  // ── Text colors ─────────────────────────────────────────────────────────
  const colorTotals: Record<string, number> = {};
  for (const page of pages) {
    for (const [color, count] of Object.entries(page.textColors)) {
      colorTotals[color] = (colorTotals[color] ?? 0) + count;
    }
  }
  const textColors = Object.entries(colorTotals)
    .map(([color, count]) => ({ color, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_COLORS);

  // ── Type scale ──────────────────────────────────────────────────────────
  const byRole = new Map<string, ElementTypeSample[]>();
  for (const page of pages) {
    for (const sample of page.elements) {
      const list = byRole.get(sample.role);
      if (list) list.push(sample);
      else byRole.set(sample.role, [sample]);
    }
  }

  const rows: TypeScaleRow[] = [];
  for (const [role, samples] of byRole) {
    if (samples.length === 0) continue;

    // Group identical (size/weight/line-height/letter-spacing) tuples; pick the
    // most frequent. Tie-break by larger fontSize.
    const groups = new Map<
      string,
      { count: number; sample: ElementTypeSample }
    >();
    for (const s of samples) {
      const key = `${s.fontSize}|${s.fontWeight}|${s.lineHeight}|${s.letterSpacing}`;
      const existing = groups.get(key);
      if (existing) existing.count++;
      else groups.set(key, { count: 1, sample: s });
    }

    let best: { count: number; sample: ElementTypeSample } | undefined;
    for (const g of groups.values()) {
      if (
        !best ||
        g.count > best.count ||
        (g.count === best.count && pxValue(g.sample.fontSize) > pxValue(best.sample.fontSize))
      ) {
        best = g;
      }
    }
    if (!best) continue;

    const displayRole = role === 'p' ? 'body' : role;
    rows.push({
      role: displayRole,
      fontSize: best.sample.fontSize,
      fontWeight: best.sample.fontWeight,
      lineHeight: best.sample.lineHeight,
      letterSpacing: best.sample.letterSpacing,
    });
  }

  const orderIndex = (role: string): number => {
    const i = ROLE_ORDER.indexOf(role);
    return i === -1 ? ROLE_ORDER.length : i;
  };
  rows.sort((a, b) => {
    const ai = orderIndex(a.role);
    const bi = orderIndex(b.role);
    if (ai !== bi) return ai - bi;
    return a.role.localeCompare(b.role);
  });

  return {
    bodyFamily,
    monoFamily,
    families,
    scale: rows,
    textColors,
    pageCount,
  };
}
