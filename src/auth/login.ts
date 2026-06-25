// Interactive session capture: open a real (headed) browser at `url`, let the
// user log in (SSO/2FA/captcha/accept-terms), wait for them to press Enter, then
// save the context's storageState to `outFile` and return its path.
//
// Owned by Wave 1 / Agent E (auth modules). Never prints cookies/tokens.
import { chromium, devices, type BrowserContext } from 'playwright';
import { mkdir } from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import type { Mode } from '../types';
import { ANTIBOT_ARGS, chromeUserAgent } from '../capture/browser';

/**
 * Launch a headed browser at `url`, let a human authenticate interactively, and
 * persist the resulting Playwright storageState to `outFile`.
 *
 * The browser is launched non-headless so the user can complete SSO/2FA/captcha
 * or "accept terms" flows by hand. We then wait for the user to press Enter in
 * the terminal before saving the session and tearing everything down.
 *
 * Returns the absolute path to the saved storageState JSON.
 */
export async function captureLogin(
  url: string,
  outFile: string,
  mode: Mode,
): Promise<string> {
  // Let launch failures (e.g. no display / missing browser) propagate clearly.
  const browser = await chromium.launch({ headless: false, args: ANTIBOT_ARGS });

  let context: BrowserContext | undefined;
  let rl: readline.Interface | undefined;
  try {
    // storageState is viewport-independent, but give the user a layout that
    // matches the mode they intend to capture in. A realistic UA avoids bot-gated
    // login pages (e.g. HuggingFace) returning 403.
    context =
      mode === 'mobile'
        ? await browser.newContext({ ...devices['iPhone 13'] })
        : await browser.newContext({
            viewport: { width: 1440, height: 900 },
            // Derived from the real engine version so version-gated sites (Notion's
            // "browser not compatible") accept the login window too.
            userAgent: chromeUserAgent(browser.version()),
            extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
          });

    const page = await context.newPage();
    // Don't hard-fail if the login page is slow or blocks `load`.
    await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});

    // Instructions go to stderr so stdout consumers stay clean.
    console.error('');
    console.error('A browser window has opened at:');
    console.error(`  ${url}`);
    console.error('');
    console.error('Log in / accept terms in that window (SSO, 2FA, and captcha');
    console.error('are all fine — take as long as you need).');
    console.error('');
    console.error('When you are fully logged in, come back here and press Enter');
    console.error('to save the session. (Ctrl-C cancels without saving.)');
    console.error('');

    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    await new Promise<void>((resolve, reject) => {
      const onSigint = () => {
        reject(new Error('Login cancelled (Ctrl-C); no session was saved.'));
      };
      // First Enter resolves; Ctrl-C rejects so nothing is written.
      rl!.once('line', () => {
        rl!.off('SIGINT', onSigint);
        resolve();
      });
      rl!.once('SIGINT', onSigint);
    });

    // Ensure the destination directory exists before writing the session.
    await mkdir(path.dirname(outFile), { recursive: true });
    await context.storageState({ path: outFile });
    console.error(`Session saved to ${path.resolve(outFile)}`);

    return path.resolve(outFile);
  } finally {
    // Best-effort teardown — never mask the primary error.
    try {
      rl?.close();
    } catch {
      /* ignore */
    }
    try {
      await context?.close();
    } catch {
      /* ignore */
    }
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
}
