// Tiny dependency-free progress renderer. Updates a single line in place on a TTY
// (carriage-return + clear-line); on a non-TTY it's a no-op so piped/MCP output
// stays clean (callers fall back to plain line logs there).
export interface Progress {
  /** Redraw the live line (TTY only). */
  render(line: string): void;
  /** Clear the live line and optionally print a final, permanent line. */
  done(finalLine?: string): void;
}

export function createProgress(
  stream: NodeJS.WriteStream = process.stdout,
): Progress {
  const isTTY = Boolean(stream.isTTY);
  let active = false;
  return {
    render(line: string): void {
      if (!isTTY) return;
      stream.write('\r\x1b[2K' + line);
      active = true;
    },
    done(finalLine?: string): void {
      if (isTTY && active) stream.write('\r\x1b[2K');
      active = false;
      if (finalLine) stream.write(finalLine + '\n');
    },
  };
}

/** Format a millisecond duration as a compact "1h2m", "3m12s", or "45s". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m${rem.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, '0')}m`;
}

/** A simple [████░░░] bar of `width` chars for `frac` in [0,1]. */
export function bar(frac: number, width = 16): string {
  const clamped = Math.max(0, Math.min(1, frac));
  const filled = Math.round(clamped * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
