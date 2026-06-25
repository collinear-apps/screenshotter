// CLI wrapper for the verify gate: run runVerify, print a readable scorecard,
// and return an exit code (0 = pass, 1 = below threshold, 2 = usage/IO error).
import pc from 'picocolors';
import type { Mode } from '../types';
import { runVerify } from './index';

export interface VerifyCommandOptions {
  threshold: number;
  mode: Mode;
  json: boolean;
  mask?: string;
  maxRoutes?: number;
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export async function runVerifyCommand(
  bundleDir: string,
  target: string,
  opts: VerifyCommandOptions,
): Promise<number> {
  const masks = (opts.mask ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let report;
  try {
    report = await runVerify(bundleDir, target, {
      threshold: opts.threshold,
      mode: opts.mode,
      maskSelectors: masks,
      maxRoutes: opts.maxRoutes,
    });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.pass ? 0 : 1;
  }

  for (const r of report.routes) {
    const mark = r.score >= report.threshold ? pc.green('✓') : pc.red('✗');
    const parts = [`score ${pct(r.score)}`];
    if (r.pixelScore !== undefined) parts.push(`pixel ${pct(r.pixelScore)}`);
    if (r.a11yScore !== undefined) parts.push(`a11y ${pct(r.a11yScore)}`);
    if (r.note) parts.push(pc.yellow(r.note));
    console.log(`${mark} ${r.route} — ${parts.join(' · ')}`);
  }

  console.log('');
  console.log(
    `Visual ${pct(report.visual.avg)} (${report.visual.routes} route(s)) · ` +
      `Structural ${pct(report.structural.avg)} (${report.structural.routes}) · ` +
      `Functional ${report.functional.passed}/${report.functional.total}`,
  );
  const line = `Fidelity score: ${pct(report.score)} (threshold ${pct(report.threshold)})`;
  console.log(report.pass ? pc.green(`${line} — PASS`) : pc.red(`${line} — FAIL`));

  if (!report.pass && report.worst.length > 0) {
    console.log(pc.dim('Worst routes:'));
    for (const w of report.worst.slice(0, 5)) {
      console.log(pc.dim(`  ${pct(w.score)}  ${w.route}`));
    }
  }
  return report.pass ? 0 : 1;
}
