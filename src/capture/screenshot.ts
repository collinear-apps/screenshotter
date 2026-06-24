// Owned by Wave 1 / Agent B (capture engine).
import { promises as fs } from 'fs';
import path from 'path';
import type { Page } from 'playwright';

/**
 * Writes a full-page PNG of the already-prepared page to `outFile`
 * (creates parent dirs as needed).
 *
 * We rely on Playwright's default `scale: 'device'` so the screenshot is
 * captured at the context's deviceScaleFactor (2× for web mode) — i.e. true
 * retina resolution. Passing `scale: 'css'` would force 1 image px per CSS px
 * and throw away the 2× the user asked for, so we deliberately omit it.
 */
export async function captureScreenshot(
  page: Page,
  outFile: string,
  maskSelectors: string[] = [],
): Promise<void> {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  const base = {
    path: outFile,
    fullPage: true,
    type: 'png' as const,
    animations: 'disabled' as const,
  };

  if (maskSelectors.length > 0) {
    try {
      await page.screenshot({
        ...base,
        mask: maskSelectors.map((s) => page.locator(s)),
        maskColor: '#000000',
      });
      return;
    } catch {
      // Invalid selector or masking failure — fall back to an unmasked shot
      // rather than failing the whole page capture.
    }
  }

  await page.screenshot(base);
}
