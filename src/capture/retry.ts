// PHASE 0 — capture integrity. OWNED by Lane 0.
// gotoWithRetry: navigate with bounded retries + exponential backoff on 429/5xx,
// per-host politeness delay, and (optional) auth-expiry detection. Plus helpers to
// classify a loaded page's auth state.
import type { Page, Response } from 'playwright';
import type { CaptureIntegrityConfig, RouteAuthState } from '../types';

export interface GotoResult {
  ok: boolean;
  status?: number;
  response?: Response | null;
  retries: number;
  error?: string;
  authState: RouteAuthState;
  throttled?: boolean;
}

/** Default per-navigation timeout (ms). Matches the old bare-goto budget. */
const GOTO_TIMEOUT_MS = 45000;
/** Hard ceiling on a single backoff sleep so a misconfigured base can't hang the crawl. */
const MAX_BACKOFF_MS = 30000;

/**
 * Module-level per-host clock. Maps a host -> the timestamp (Date.now()) of the
 * last navigation we *scheduled* for that host. Used by throttleHost to space out
 * requests so we stay polite under concurrency. Date.now() is intentionally used
 * here (runtime throttling, not deterministic capture).
 */
const lastHostTs = new Map<string, number>();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** True when an error looks like a Playwright navigation timeout (retryable). */
function isTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|exceeded/i.test(msg);
}

/**
 * Per-host politeness throttle. Spaces successive navigations to the same host by
 * at least cfg.requestDelayMs. Reserves the slot synchronously (records the
 * intended start time before awaiting) so concurrent callers for the same host
 * queue behind each other instead of all reading a stale lastTs.
 */
export async function throttleHost(host: string, cfg: CaptureIntegrityConfig): Promise<boolean> {
  const delay = cfg?.requestDelayMs ?? 0;
  if (!host || delay <= 0) return false;

  const now = Date.now();
  const last = lastHostTs.get(host) ?? 0;
  // Next allowed start time for this host. If the host is idle, that's `now`.
  const nextAllowed = Math.max(now, last + delay);
  // Reserve the slot immediately so a sibling call computes off OUR start time,
  // not the stale previous one (prevents a thundering herd on one host).
  lastHostTs.set(host, nextAllowed);

  const wait = nextAllowed - now;
  if (wait > 0) {
    await sleep(wait);
    return true;
  }
  return false;
}

/**
 * Navigate to `url` with retry/backoff + per-host politeness delay.
 *
 * - Up to cfg.maxRetries attempts (so maxRetries=1 means a single try, matching
 *   the old bare-goto behavior).
 * - Exponential backoff (cfg.backoffBaseMs * 2^attempt) on HTTP 429/5xx and on
 *   navigation timeouts. The 429 Retry-After header, when present and sane, wins.
 * - A per-host politeness delay (throttleHost) before every attempt.
 *
 * Never throws: failures are returned as { ok:false, error }.
 */
export async function gotoWithRetry(
  page: Page,
  url: string,
  cfg: CaptureIntegrityConfig,
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'load',
): Promise<GotoResult> {
  const maxRetries = Math.max(1, cfg?.maxRetries ?? 1);
  const backoffBase = Math.max(0, cfg?.backoffBaseMs ?? 0);
  const host = hostOf(url);

  let throttledEver = false;
  let lastStatus: number | undefined;
  let lastResponse: Response | null | undefined;
  let lastError: string | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Politeness: space out same-host navigations (also between our own retries).
    const didThrottle = await throttleHost(host, cfg);
    throttledEver = throttledEver || didThrottle;

    let response: Response | null = null;
    try {
      response = await page.goto(url, { waitUntil, timeout: GOTO_TIMEOUT_MS });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      lastResponse = null;
      lastStatus = undefined;
      // Retry navigation timeouts with backoff; other errors (e.g. DNS, aborted)
      // are treated as non-retryable and returned immediately.
      if (isTimeoutError(err) && attempt < maxRetries - 1) {
        await sleep(backoffMs(backoffBase, attempt));
        continue;
      }
      return {
        ok: false,
        retries: attempt,
        error: lastError,
        authState: 'unknown',
        throttled: throttledEver,
      };
    }

    const status = response?.status();
    lastResponse = response;
    lastStatus = status;
    lastError = undefined;

    // Retryable server-side conditions: 429 (rate limit) and 5xx (transient).
    if (status !== undefined && (status === 429 || status >= 500) && attempt < maxRetries - 1) {
      const retryAfterMs = status === 429 ? retryAfterMs0(response) : undefined;
      const waitMs = retryAfterMs ?? backoffMs(backoffBase, attempt);
      await sleep(waitMs);
      continue;
    }

    // Final outcome for this attempt. ok mirrors Playwright's notion of a usable
    // navigation: a response object exists and is not a hard server error. A 4xx
    // page (other than 429) is still "captured" (e.g. a 404 page is real content).
    const ok = Boolean(response) && (status === undefined || status < 500);
    return {
      ok,
      status,
      response,
      retries: attempt,
      error: ok ? undefined : `HTTP ${status}`,
      authState: 'unknown',
      throttled: throttledEver,
    };
  }

  // Exhausted all attempts (last attempt was a retryable status/timeout).
  return {
    ok: false,
    status: lastStatus,
    response: lastResponse ?? null,
    retries: maxRetries - 1,
    error: lastError ?? (lastStatus !== undefined ? `HTTP ${lastStatus}` : 'navigation failed'),
    authState: 'unknown',
    throttled: throttledEver,
  };
}

/** Exponential backoff for attempt index `attempt` (0-based), capped. */
function backoffMs(base: number, attempt: number): number {
  if (base <= 0) return 0;
  return Math.min(MAX_BACKOFF_MS, base * 2 ** attempt);
}

/** Parse a 429 Retry-After header (seconds or HTTP-date) into ms, if sane. */
function retryAfterMs0(response: Response | null): number | undefined {
  if (!response) return undefined;
  let raw: string | undefined;
  try {
    raw = response.headers()['retry-after'];
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) {
    if (secs < 0) return undefined;
    return Math.min(MAX_BACKOFF_MS, secs * 1000);
  }
  const when = Date.parse(raw);
  if (Number.isFinite(when)) {
    const delta = when - Date.now();
    if (delta <= 0) return 0;
    return Math.min(MAX_BACKOFF_MS, delta);
  }
  return undefined;
}

/**
 * Best-effort classification of whether the current page is an authenticated view,
 * an anonymous/login-redirect view, or unknown. Fast + side-effect-free.
 *
 * Heuristics (in order):
 *  1. URL points at a login/signin/auth route  -> 'anonymous'.
 *  2. A visible login form (password field + submit) is present -> 'anonymous'.
 *  3. An authed-only marker (account/avatar/user/logout menu) is present -> 'authed'.
 *  4. Otherwise -> 'unknown'.
 */
export async function detectAuthState(page: Page): Promise<RouteAuthState> {
  // 1. Login-redirect by URL.
  try {
    const current = page.url();
    if (/\/(login|signin|sign-in|sign_in|auth\/login|account\/login)(\b|\/|\?|#|$)/i.test(current)) {
      return 'anonymous';
    }
  } catch {
    // ignore — fall through to DOM checks
  }

  // 2/3. Inspect the DOM in one fast pass. Guarded with a short timeout via
  // Promise.race so a hung page evaluation can never stall the crawl.
  try {
    // Swallow a late rejection on the losing side of the race below (e.g. the
    // page navigates/closes after the timeout wins) so it never surfaces as an
    // unhandled rejection.
    const probe = page.evaluate(() => {
      const visible = (el: Element | null): boolean => {
        if (!el) return false;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = window.getComputedStyle(el as HTMLElement);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
      };

      // Login form: a visible password field (+ ideally a form/submit nearby).
      const pwd = document.querySelector('input[type="password"]');
      const hasLoginForm = visible(pwd);

      // Authed-only markers: account/avatar/user/logout affordances.
      const authedSelectors = [
        '[href*="logout" i]',
        '[href*="signout" i]',
        '[href*="sign-out" i]',
        'button[aria-label*="account" i]',
        'button[aria-label*="profile" i]',
        'a[aria-label*="account" i]',
        '[data-testid*="user-menu" i]',
        '[data-testid*="avatar" i]',
        'img[alt*="avatar" i]',
        '[aria-label*="user menu" i]',
      ];
      let hasAuthedMarker = false;
      for (const sel of authedSelectors) {
        const el = document.querySelector(sel);
        if (visible(el)) {
          hasAuthedMarker = true;
          break;
        }
      }

      return { hasLoginForm, hasAuthedMarker };
    });
    // Detach a no-op catch so a post-race rejection can't go unhandled.
    probe.catch(() => undefined);

    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000));
    const res = await Promise.race([probe, timeout]);
    if (!res) return 'unknown';

    if (res.hasAuthedMarker) return 'authed';
    if (res.hasLoginForm) return 'anonymous';
  } catch {
    // ignore — best-effort
  }

  return 'unknown';
}

/** Result of a bot-wall / block-page probe. */
export interface ChallengeResult {
  challenged: boolean;
  reason?: string;
  kind?: 'cloudflare' | 'captcha' | 'compat' | 'access' | 'thin';
}

/**
 * Read-only probe for "this 200 response isn't the real site" pages: bot-wall
 * interstitials (Cloudflare), CAPTCHAs, browser-compat blocks, and access denials
 * (Akamai/PerimeterX/Imperva). These return HTTP 200 with block content, so the
 * crawler would otherwise capture them as successful pages and silently poison the
 * bundle. Matches on STRONG signals (known interstitial iframes + phrases); a
 * suspiciously-thin DOM is reported only as a soft companion. Never throws / clicks.
 */
export async function detectChallenge(page: Page): Promise<ChallengeResult> {
  try {
    const probe = page.evaluate(() => {
      const text = (document.body?.innerText || '').slice(0, 4000);
      const has = (sel: string): boolean => !!document.querySelector(sel);
      const m = (re: RegExp): boolean => re.test(text);
      // Bounded node count for the thin-shell soft signal.
      const nodes = document.querySelectorAll('*').length;

      if (
        has('iframe[src*="challenges.cloudflare.com"]') ||
        has('#challenge-running, #cf-challenge-running, [class*="cf-"][class*="challenge" i]') ||
        m(/just a moment|checking your browser|attention required|cf-browser-verification/i)
      ) {
        return { challenged: true, kind: 'cloudflare', reason: 'Cloudflare/bot interstitial' };
      }
      if (
        has('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[title*="captcha" i],.g-recaptcha,.h-captcha') ||
        m(/verify you are (a )?human|complete the captcha|unusual traffic from your/i)
      ) {
        return { challenged: true, kind: 'captcha', reason: 'CAPTCHA / human-verification' };
      }
      if (m(/not compatible with|unsupported browser|upgrade (your|to a) .{0,20}browser|please use a (modern|supported|different) browser/i)) {
        return { challenged: true, kind: 'compat', reason: 'Browser-compatibility block' };
      }
      if (m(/access denied|access to this page has been denied|pardon our interruption|you (have been|are being) blocked|request blocked|reference #?\d|error[ -]?54\d|akamai/i)) {
        return { challenged: true, kind: 'access', reason: 'Access / bot block' };
      }
      // Soft error/maintenance shells that bot defenses serve in place of the page
      // (e.g. OpenTable's "Well, this is embarrassing… we're aware of the issue").
      if (m(/this is embarrassing|we'?re aware of the (issue|problem)|it'?s not you,? it'?s us|something went wrong.{0,40}(try again|helpful links)/i)) {
        return { challenged: true, kind: 'access', reason: 'Error/maintenance shell (not the real page)' };
      }
      // Soft: a near-empty shell on a route that should be rich. Only flagged when
      // the page is essentially contentless (avoids false positives on real pages).
      if (nodes < 60 && text.replace(/\s+/g, '').length < 200) {
        return { challenged: true, kind: 'thin', reason: 'Suspiciously empty page (possible block/error shell)' };
      }
      return { challenged: false };
    }) as Promise<ChallengeResult>;
    probe.catch(() => undefined);
    const timeout = new Promise<ChallengeResult>((resolve) =>
      setTimeout(() => resolve({ challenged: false }), 2000),
    );
    return await Promise.race([probe, timeout]);
  } catch {
    return { challenged: false };
  }
}

/** Reset the per-host throttle clock. Exposed for tests / fresh runs. */
export function resetHostThrottle(): void {
  lastHostTs.clear();
}
