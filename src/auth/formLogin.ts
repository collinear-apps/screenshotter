// Username/password autofill: fill + submit the login form so the shared context
// becomes authenticated before captures run. Cookies persist in the context.
//
// Owned by Wave 1 / Agent E (auth modules). Must NEVER log secrets, cookies,
// usernames, or tokens.
import type { BrowserContext, Locator, Page } from 'playwright';
import type { FormLogin, Logger } from '../types';

// Candidate selectors for autodetecting the username/email field, in priority
// order. The first visible match wins.
const USERNAME_SELECTORS = [
  'input[type="email"]',
  'input[name*="user" i]',
  'input[name*="email" i]',
  'input[id*="user" i]',
  'input[id*="email" i]',
  'input[type="text"]',
];

// Short per-locator probe so autodetection never hangs on missing fields.
async function firstVisible(
  page: Page,
  selectors: string[],
): Promise<Locator | undefined> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 1500 })) {
        return locator;
      }
    } catch {
      // Locator not present / detached — try the next candidate.
    }
  }
  return undefined;
}

/**
 * Drive a username/password login form in the given (shared) context so that the
 * context's cookies are authenticated for subsequent captures.
 *
 * Field selectors are autodetected when not supplied. The page used for login is
 * closed on the way out (try/finally), but its cookies remain in the context.
 */
export async function performFormLogin(
  context: BrowserContext,
  form: FormLogin,
  logger: Logger,
): Promise<void> {
  const page = await context.newPage();
  try {
    const resp = await page.goto(form.loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    if (resp && !resp.ok()) {
      throw new Error(
        `Login page ${form.loginUrl} returned HTTP ${resp.status()} — the site is ` +
          `blocking automated access. Capture a session in a real browser instead: ` +
          `\`screenshotter login ${new URL(form.loginUrl).origin}\` then use --auth.`,
      );
    }

    // ── Username/email field ──────────────────────────────────────────────
    let usernameLocator: Locator | undefined;
    if (form.usernameSelector) {
      const explicit = page.locator(form.usernameSelector).first();
      if (await explicit.isVisible({ timeout: 1500 }).catch(() => false)) {
        usernameLocator = explicit;
      }
    } else {
      usernameLocator = await firstVisible(page, USERNAME_SELECTORS);
    }
    if (!usernameLocator) {
      throw new Error(
        'Could not find a username/email field. Pass --user-selector, or if the ' +
          'site blocks automated logins use `screenshotter login` to save a session.',
      );
    }

    // ── Password field ────────────────────────────────────────────────────
    const passwordLocator = (
      form.passwordSelector
        ? page.locator(form.passwordSelector)
        : page.locator('input[type="password"]')
    ).first();
    if (!(await passwordLocator.isVisible({ timeout: 1500 }).catch(() => false))) {
      throw new Error('Could not find a password field; pass --pass-selector');
    }

    // ── Fill (never log the values) ───────────────────────────────────────
    await usernameLocator.fill(form.username);
    await passwordLocator.fill(form.password);
    logger.info('Form login: credentials filled, submitting…');

    // ── Submit ────────────────────────────────────────────────────────────
    let submitted = false;
    if (form.submitSelector) {
      await page.locator(form.submitSelector).first().click();
      submitted = true;
    } else {
      const candidates: Locator[] = [
        page.locator('button[type="submit"]').first(),
        page.locator('input[type="submit"]').first(),
        page
          .getByRole('button', { name: /log ?in|sign ?in|continue|submit/i })
          .first(),
      ];
      for (const candidate of candidates) {
        if (await candidate.isVisible({ timeout: 1500 }).catch(() => false)) {
          await candidate.click();
          submitted = true;
          break;
        }
      }
      if (!submitted) {
        // Last resort: submit the form by pressing Enter in the password field.
        await passwordLocator.press('Enter');
        submitted = true;
      }
    }

    // ── Wait for the result ───────────────────────────────────────────────
    if (form.successUrl) {
      logger.info('Form login: submitted, waiting for redirect…');
      await page.waitForURL(form.successUrl, { timeout: 20000 });
    } else {
      logger.info('Form login: submitted, waiting for page to settle…');
      await page
        .waitForLoadState('networkidle', { timeout: 10000 })
        .catch(() => {});
      await page.waitForTimeout(500);
    }
    logger.info('Form login: complete.');
  } finally {
    // Close the login page; cookies stay in the shared context.
    await page.close().catch(() => {});
  }
}
