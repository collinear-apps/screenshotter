// Owned by Wave 1 / Agent C (records + rebuild-prompt behaviors).
// renderGraphJson: per-page state graph. renderInteractionsMd: readable behavioral
// spec across pages. renderBehaviorsSection: markdown appended to REBUILD-PROMPT.md.
import type { ActionRecord, ExploreResult } from '../types';

/** Outcomes that represent an actual observable behavior worth cataloging. */
function isMeaningful(a: ActionRecord): boolean {
  return a.outcome !== 'noop' && a.outcome !== 'skipped';
}

/** Escape a string for safe inclusion inside a Markdown table cell. */
function mdCell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/** Per-page state graph as pretty JSON. */
export function renderGraphJson(result: ExploreResult): string {
  return JSON.stringify(
    {
      pageLabel: result.pageLabel,
      baseUrl: result.baseUrl,
      states: result.states,
      actionCount: result.actions.length,
      actions: result.actions,
    },
    null,
    2,
  );
}

/** Human-readable description of what an action's outcome produced. */
function resultCell(a: ActionRecord): string {
  let base: string;
  switch (a.outcome) {
    case 'navigation':
      base = `→ ${a.toUrl ?? '(unknown url)'}`;
      break;
    case 'download':
      base = `⬇ ${a.downloadFile ?? '(file)'}`;
      break;
    case 'modal':
      base = 'modal opened';
      break;
    case 'dom-change':
      base = 'DOM updated';
      break;
    case 'error':
      base = 'error';
      break;
    default:
      base = a.outcome;
  }
  if (a.note && (a.outcome === 'error' || a.outcome === 'dom-change')) {
    base += ` (${a.note})`;
  }
  if (a.screenshot) {
    base += ` · screenshot: \`${a.screenshot}\``;
  }
  return mdCell(base);
}

/** Readable behavioral catalog across all explored pages. */
export function renderInteractionsMd(
  results: ExploreResult[],
  siteName: string,
): string {
  const out: string[] = [];
  out.push(`# Interactions — ${siteName}`);
  out.push('');

  if (results.length === 0) {
    out.push('_No interactions recorded._');
    out.push('');
    return out.join('\n');
  }

  // Totals derived from outcomes.
  let totalActions = 0;
  let downloads = 0;
  let navigations = 0;
  for (const r of results) {
    for (const a of r.actions) {
      totalActions += 1;
      if (a.outcome === 'download') downloads += 1;
      if (a.outcome === 'navigation') navigations += 1;
    }
  }
  out.push(
    `${totalActions} actions across ${results.length} pages, ${downloads} downloads, ${navigations} navigations`,
  );
  out.push('');

  for (const r of results) {
    out.push(`## ${r.pageLabel}`);
    out.push('');
    out.push(`${r.baseUrl} · ${r.states} states`);
    out.push('');

    const meaningful = r.actions.filter(isMeaningful);
    const skipped = r.actions.filter((a) => a.outcome === 'skipped');
    const noopCount = r.actions.filter((a) => a.outcome === 'noop').length;

    if (meaningful.length === 0) {
      out.push('_no state-changing interactions recorded_');
      out.push('');
    } else {
      out.push('| Action | Kind | Outcome | Result |');
      out.push('| --- | --- | --- | --- |');
      for (const a of meaningful) {
        out.push(
          `| ${mdCell(a.label)} | ${mdCell(a.kind)} | ${mdCell(a.outcome)} | ${resultCell(a)} |`,
        );
      }
      out.push('');
    }

    if (skipped.length > 0) {
      out.push('<details>');
      out.push(`<summary>Skipped controls (${skipped.length})</summary>`);
      out.push('');
      for (const a of skipped) {
        const note = a.note ? ` — ${a.note}` : '';
        out.push(`- ${a.label} (${a.kind})${note}`);
      }
      out.push('');
      out.push('</details>');
      out.push('');
    }

    out.push(`_${noopCount} no-op actions._`);
    out.push('');
  }

  return out.join('\n');
}

/** Priority ranking so the most informative behaviors survive the per-page cap. */
function outcomeRank(outcome: ActionRecord['outcome']): number {
  switch (outcome) {
    case 'download':
      return 0;
    case 'navigation':
      return 1;
    case 'modal':
      return 2;
    case 'dom-change':
      return 3;
    default:
      return 9;
  }
}

/** One imperative behavior bullet for the rebuild prompt. */
function behaviorLine(a: ActionRecord): string | undefined {
  const label = a.label || '(unlabeled control)';
  switch (a.outcome) {
    case 'modal': {
      const shot = a.screenshot ? ` (state: ${a.screenshot})` : '';
      return `Clicking "${label}" opens a modal — rebuild that dialog${shot}.`;
    }
    case 'navigation':
      return `Clicking "${label}" navigates to ${a.toUrl ?? '(unknown url)'}.`;
    case 'download':
      return `"${label}" triggers a download (${a.downloadFile ?? 'file'}).`;
    case 'dom-change': {
      const net =
        a.network && a.network.length > 0
          ? `; fires API: ${a.network.slice(0, 2).join(', ')}`
          : '';
      return `"${label}" updates the view (DOM change)${net}.`;
    }
    default:
      return undefined;
  }
}

const MAX_BEHAVIORS_PER_PAGE = 8;

/** Concise behavior guidance injected into REBUILD-PROMPT.md. */
export function renderBehaviorsSection(results: ExploreResult[]): string {
  const blocks: string[] = [];

  for (const r of results) {
    const meaningful = r.actions
      .filter(isMeaningful)
      .filter((a) => a.outcome !== 'error')
      .sort((a, b) => outcomeRank(a.outcome) - outcomeRank(b.outcome));

    if (meaningful.length === 0) continue;

    const lines: string[] = [];
    const seen = new Set<string>();
    for (const a of meaningful) {
      if (lines.length >= MAX_BEHAVIORS_PER_PAGE) break;
      // Dedupe identical behaviors reached from multiple states.
      const key = `${a.outcome}|${a.label}|${a.toUrl ?? ''}|${a.downloadFile ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = behaviorLine(a);
      if (line) lines.push(`  - ${line}`);
    }
    if (lines.length === 0) continue;

    blocks.push([`- **${r.pageLabel}**`, ...lines].join('\n'));
  }

  if (blocks.length === 0) return '';
  return blocks.join('\n');
}
