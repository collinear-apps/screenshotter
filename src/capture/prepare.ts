// Owned by Wave 1 / Agent B (capture engine).
import type { Page } from 'playwright';

/** Common cookie/consent "accept" selectors seen across many sites. */
const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  'button#accept',
  '[aria-label="Accept all"]',
  '[data-testid="cookie-accept"]',
  '.cookie-accept',
  'button[aria-label*="accept" i]',
];

/**
 * Best-effort dismissal of cookie/consent banners. Never throws: each candidate
 * is checked with a short visibility timeout and the first visible match wins.
 */
async function dismissConsent(page: Page): Promise<void> {
  for (const selector of CONSENT_SELECTORS) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 500 })) {
        await el.click({ timeout: 1500 });
        return;
      }
    } catch {
      // ignore this candidate and try the next
    }
  }

  // Text/role-based fallback.
  try {
    const btn = page
      .getByRole('button', { name: /accept|agree|got it|allow all|i understand/i })
      .first();
    if (await btn.isVisible({ timeout: 500 })) {
      await btn.click({ timeout: 1500 });
    }
  } catch {
    // swallow — consent dismissal is always best-effort
  }
}

/**
 * Capped auto-scroll to trigger lazy-loaded content. Scrolls down in
 * viewport-height steps, stops at the bottom, after a hard step cap, or once the
 * document grows past a safety ceiling (to avoid runaway infinite-scroll), then
 * returns to the top.
 */
async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const step = window.innerHeight || 900;
    const MAX_STEPS = 30;
    // CSS-px ceiling for runaway/infinite-scroll pages. Kept conservative so
    // that at 2× deviceScaleFactor the captured image stays under Chromium's
    // ~32767px max dimension (15000 × 2 = 30000).
    const MAX_HEIGHT = 15000;

    for (let i = 0; i < MAX_STEPS; i++) {
      window.scrollBy(0, step);
      await sleep(150);

      const scrollHeight = document.body.scrollHeight;
      const atBottom = window.scrollY + window.innerHeight >= scrollHeight - 2;
      if (atBottom || scrollHeight > MAX_HEIGHT) {
        break;
      }
    }

    window.scrollTo(0, 0);
  });
}

/**
 * Navigates to `url` and readies the page for a clean full-page screenshot:
 * goto(load) -> best-effort networkidle (short timeout) -> document.fonts.ready
 * -> dismiss cookie/consent banners -> incremental auto-scroll (capped) to
 * trigger lazy media -> scroll to top -> short settle delay.
 *
 * `goto` failures propagate (the pipeline catches per-page); every other step is
 * isolated so a single failure does not abort the whole prepare.
 */
export async function preparePage(page: Page, url: string): Promise<void> {
  // Allow goto failures to propagate.
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  await settlePage(page);
}

/**
 * The post-navigation readiness steps (everything `preparePage` does after goto):
 * networkidle → fonts → consent → auto-scroll → settle. Exposed separately so the
 * pipeline can navigate via gotoWithRetry (Phase 0) and then settle, without
 * duplicating the goto. Every step is internally guarded.
 */
export async function settlePage(page: Page): Promise<void> {
  // Network settle that never hangs (HF et al. keep sockets open).
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  // Wait for web fonts.
  await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});

  // Dismiss consent banners (already fully internally guarded).
  await dismissConsent(page).catch(() => {});

  // Trigger lazy content.
  await autoScroll(page).catch(() => {});

  // Short settle.
  await page.waitForTimeout(400);
}
