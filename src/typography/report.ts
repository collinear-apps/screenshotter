// Owned by Wave 1 / Agent D (typography + output).
import type { AggregatedTypography } from '../types';

/** Renders the typography.md markdown document. */
export function renderTypographyMarkdown(
  agg: AggregatedTypography,
  siteName: string,
): string {
  const lines: string[] = [];

  lines.push(`# Typography — ${siteName}`);
  lines.push('');
  lines.push(`_Auto-extracted from ${agg.pageCount} page(s)._`);
  lines.push('');

  // ── Font families ─────────────────────────────────────────────────────────
  lines.push('## Font families');
  if (agg.families.length === 0) {
    lines.push('');
    lines.push('_No typography captured._');
  } else {
    for (const { family, count } of agg.families) {
      const tags: string[] = [];
      if (family === agg.bodyFamily) tags.push('(body)');
      if (family === agg.monoFamily) tags.push('(mono)');
      const suffix = tags.length ? ` ${tags.join(' ')}` : '';
      lines.push(`- ${family} (${count} uses)${suffix}`);
    }
  }
  lines.push('');

  // ── Type scale ──────────────────────────────────────────────────────────────
  lines.push('## Type scale');
  if (agg.scale.length === 0) {
    lines.push('');
    lines.push('_No type scale captured._');
  } else {
    lines.push('| Role | Size | Weight | Line height | Letter spacing |');
    lines.push('|------|------|--------|-------------|----------------|');
    for (const row of agg.scale) {
      lines.push(
        `| ${row.role} | ${row.fontSize} | ${row.fontWeight} | ${row.lineHeight} | ${row.letterSpacing} |`,
      );
    }
  }
  lines.push('');

  // ── Text colors ─────────────────────────────────────────────────────────────
  lines.push('## Text colors');
  if (agg.textColors.length === 0) {
    lines.push('');
    lines.push('_No text colors captured._');
  } else {
    for (const { color, count } of agg.textColors) {
      lines.push(`- ${color} (${count} uses)`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
