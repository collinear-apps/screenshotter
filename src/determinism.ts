// Deterministic-capture helpers: stable clock/locale/timezone, seeded randomness,
// and animation suppression — so screenshots/DOM are reproducible and visual-diff
// / golden comparisons compare signal, not frame-timing or random-id noise.
import type { BrowserContextOptions, Page } from 'playwright';
import type { RunConfig } from './types';

/** Context options that pin locale/timezone and request reduced motion. */
export function determinismContextOptions(cfg: RunConfig): BrowserContextOptions {
  const d = cfg.determinism;
  if (!d?.enabled) return {};
  return {
    locale: d.locale,
    timezoneId: d.timezone,
    reducedMotion: 'reduce',
    colorScheme: 'light',
  };
}

/**
 * Runs in the PAGE via context.addInitScript (before page scripts): replaces
 * Math.random with a deterministic mulberry32 PRNG so any client-generated random
 * ids/keys are stable across runs.
 */
export function seedRandom(): void {
  let s = 0x9e3779b9 >>> 0;
  Math.random = function deterministicRandom(): number {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Freezes the page clock at the configured time (Date / performance.now /
 * timers). Best-effort: must run before navigation; never throws.
 */
export async function installClock(page: Page, cfg: RunConfig): Promise<void> {
  if (!cfg.determinism?.enabled) return;
  try {
    const time = new Date(cfg.determinism.freezeTimeISO);
    if (Number.isNaN(time.getTime())) return;
    await page.clock.install({ time });
    await page.clock.setFixedTime(time);
  } catch {
    // best-effort — some sites/browsers may reject clock control
  }
}

/** CSS that disables animations, transitions, smooth scroll and caret blink. */
export const ANIM_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
}
html, body { scroll-behavior: auto !important; }
`;
