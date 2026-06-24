// Owned by Wave 1 / Agent C (a11y-diff command).
// runA11yDiff loads both sides, scores/gates, prints a report, and returns an
// exit code (0 pass, 1 fail) so it works as a CI grading gate.
import pc from 'picocolors';
import type { AxNodeFlat, Mode } from '../types';
import { loadTree } from './load';
import { gate } from './diff';

export interface A11yDiffOptions {
  threshold: number;
  exact: boolean;
  mode: Mode;
  json: boolean;
}

/** Max diff entries to print per side in human-readable output. */
const MAX_DIFF_LINES = 15;

/** Render one diff node as `<role> "<name>"`. */
function describe(node: AxNodeFlat): string {
  return `${node.role} "${node.name}"`;
}

export async function runA11yDiff(
  expected: string,
  actual: string,
  opts: A11yDiffOptions,
): Promise<number> {
  // 1. Resolve both sides. A load/capture failure is a hard error (exit 2),
  //    distinct from a clean FAIL (exit 1).
  let exp: AxNodeFlat[];
  let act: AxNodeFlat[];
  try {
    exp = await loadTree(expected, opts.mode);
    act = await loadTree(actual, opts.mode);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      // Keep stdout valid JSON even on failure.
      console.log(JSON.stringify({ error: msg }));
    } else {
      console.error(msg);
    }
    return 2;
  }

  // 2. Score + gate.
  const { pass, diff } = gate(exp, act, opts.threshold, opts.exact);

  // 3. Report.
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          pass,
          score: diff.score,
          threshold: opts.threshold,
          exact: opts.exact,
          expectedNodes: exp.length,
          actualNodes: act.length,
          added: diff.added,
          removed: diff.removed,
        },
        null,
        2,
      ),
    );
  } else {
    const verdict = pass ? pc.green('PASS') : pc.red('FAIL');
    const score = diff.score.toFixed(2);
    console.log(`score ${score}  ${verdict} (≥${opts.threshold})`);

    for (const node of diff.removed.slice(0, MAX_DIFF_LINES)) {
      console.log(pc.red(`- missing: ${describe(node)}`));
    }
    for (const node of diff.added.slice(0, MAX_DIFF_LINES)) {
      console.log(pc.green(`+ extra:   ${describe(node)}`));
    }

    console.log(`(expected ${exp.length} nodes vs actual ${act.length} nodes)`);
  }

  // 4. Exit code (caller calls process.exit).
  return pass ? 0 : 1;
}
