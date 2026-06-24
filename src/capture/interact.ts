// Drives a bounded, SAFE sequence of interactions to provoke first-party API
// calls (which the context-level HAR records). Runs AFTER the screenshot, so the
// captured image is always the clean page.
//
// Safety (these run against live, possibly-authenticated sites):
//  - Only ever: scroll, type into search boxes, click role=tab, and click
//    allow-listed "load more / next" buttons.
//  - NEVER click links/arbitrary buttons; NEVER touch a control whose label looks
//    destructive (delete/logout/checkout/pay/cancel/…).
//  - Hard time budget; every step is individually guarded and never throws.
import type { Locator, Page } from 'playwright';
import type { Logger, RunConfig } from '../types';

/** Labels we must never click — avoids mutating/destructive or session-ending actions. */
const DESTRUCTIVE =
  /delete|remove|logout|log\s?out|sign\s?out|buy|purchas|\bpay\b|checkout|\bconfirm\b|\bcancel\b|unsubscrib|deactivat|close account|\breset\b|delete account|withdraw|transfer|send\b/i;

/** Button labels worth clicking to load more data (read-only pagination). */
const PAGINATION = /load more|show more|view more|see more|more results|^\s*more\s*$|^\s*next\s*$/i;

const SEARCH_SELECTORS = [
  'input[type="search"]',
  '[role="searchbox"]',
  'input[name*="search" i]',
  'input[placeholder*="search" i]',
  'input[aria-label*="search" i]',
  'input[name="q" i]',
];

const BUDGET_MS = 12_000;

async function settle(page: Page, ms: number): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
  await page.waitForTimeout(Math.min(ms, 800)).catch(() => {});
}

function labelOf(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Best-effort interaction pass. Never throws. Returns when the time budget is
 * spent or all interaction kinds have been attempted.
 */
export async function interactForApi(
  page: Page,
  cfg: RunConfig,
  _logger: Logger,
): Promise<void> {
  const start = Date.now();
  const within = (): boolean => Date.now() - start < BUDGET_MS;

  try {
    // 1. Deep scroll → infinite-scroll / pagination fetches.
    for (let i = 0; i < 4 && within(); i++) {
      await page
        .evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        .catch(() => {});
      await settle(page, 1000);
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

    // 2. Search → autocomplete + results APIs.
    if (within()) await trySearch(page, cfg.api?.searchTerm || 'a');

    // 3. Tabs → lazily-fetched tab content.
    if (within()) await clickTabs(page, within);

    // 4. "Load more" / "Next" → pagination APIs.
    if (within()) await clickPagination(page, within);
  } catch {
    // Interaction is strictly best-effort; a failure must not sink the capture.
  }
}

async function firstVisible(
  page: Page,
  selectors: string[],
): Promise<Locator | undefined> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.isVisible({ timeout: 800 })) return loc;
    } catch {
      // try next
    }
  }
  return undefined;
}

async function trySearch(page: Page, term: string): Promise<void> {
  try {
    const input = await firstVisible(page, SEARCH_SELECTORS);
    if (!input) return;
    await input.click({ timeout: 1500 }).catch(() => {});
    await input.fill('').catch(() => {});
    // Per-keystroke typing triggers debounced autocomplete endpoints.
    await input.pressSequentially(term, { delay: 80 }).catch(() => {});
    await settle(page, 1500);
    // Submit to load results (search forms are read-only GETs).
    await input.press('Enter').catch(() => {});
    await settle(page, 1500);
  } catch {
    // ignore
  }
}

async function clickTabs(page: Page, within: () => boolean): Promise<void> {
  try {
    const tabs = page.getByRole('tab');
    const count = Math.min(await tabs.count().catch(() => 0), 4);
    for (let i = 0; i < count && within(); i++) {
      const tab = tabs.nth(i);
      const name = labelOf(await tab.textContent().catch(() => ''));
      if (DESTRUCTIVE.test(name)) continue;
      if (!(await tab.isVisible({ timeout: 500 }).catch(() => false))) continue;
      await tab.click({ timeout: 1500 }).catch(() => {});
      await settle(page, 1000);
    }
  } catch {
    // ignore
  }
}

async function clickPagination(page: Page, within: () => boolean): Promise<void> {
  try {
    const buttons = page.locator('button, [role="button"]');
    const total = Math.min(await buttons.count().catch(() => 0), 60);
    let clicks = 0;
    for (let i = 0; i < total && clicks < 3 && within(); i++) {
      const btn = buttons.nth(i);
      const name = labelOf(await btn.textContent().catch(() => ''));
      if (!name || name.length > 40) continue;
      if (DESTRUCTIVE.test(name)) continue;
      if (!PAGINATION.test(name)) continue;
      if (!(await btn.isVisible({ timeout: 400 }).catch(() => false))) continue;
      await btn.click({ timeout: 1500 }).catch(() => {});
      clicks++;
      await settle(page, 1200);
    }
  } catch {
    // ignore
  }
}
