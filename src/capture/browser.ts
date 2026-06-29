// Owned by Wave 1 / Agent B (capture engine).
import { chromium, firefox, webkit, devices } from 'playwright';
import type { Browser, BrowserContext, BrowserContextOptions, BrowserType } from 'playwright';
import type { RunConfig, Breakpoint, ColorScheme } from '../types';
import { applyAuthToContextOptions } from '../auth';
import { harTempPath } from '../api';
import { createApiBodyCollector } from '../api/bodies';
import type { ApiBodyCollector } from '../api/bodies';
import { determinismContextOptions, seedRandom } from '../determinism';
import { createAssetCollector } from '../extract/assets';
import type { AssetCollector } from '../extract/assets';

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  /** Present when --extract assets is enabled; finalized by the pipeline. */
  collector?: AssetCollector;
  /** Present when --api is enabled; bounded JSON body sidecar for OpenAPI schemas. */
  apiBodies?: ApiBodyCollector;
}

/**
 * Present as a normal desktop browser, not an automated one. Many sites (incl.
 * HuggingFace's /login behind CloudFront) 403 the default headless fingerprint;
 * a realistic UA + clearing `navigator.webdriver` makes capture/login work. This
 * is presentation, not evasion — use it on sites/accounts you're authorized for.
 */
/**
 * Build a desktop-Chrome UA for a given Chromium version — WITHOUT the "Headless"
 * token and matching the REAL engine version. A stale/mismatched version triggers
 * "your browser is not compatible / upgrade your browser" blocks (e.g. Notion);
 * the launch path derives this from `browser.version()` so it never goes stale as
 * Playwright bumps its bundled Chromium. OS is derived from the host.
 */
export function chromeUserAgent(version: string): string {
  const os =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'linux'
        ? 'X11; Linux x86_64'
        : 'Macintosh; Intel Mac OS X 10_15_7';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

/**
 * Fallback desktop UA, used ONLY if the live engine version is unavailable. The
 * real capture/login paths override this with chromeUserAgent(browser.version()).
 */
export const DESKTOP_UA = chromeUserAgent('149.0.0.0');
export const ANTIBOT_ARGS = ['--disable-blink-features=AutomationControlled'];
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

/**
 * The viewport profile a default (back-compat) run implies from `--mode`:
 *  - web    -> 1440x900 desktop
 *  - mobile -> iPhone 13 device descriptor
 * The config builder seeds cfg.breakpoints with exactly this profile when no
 * `--breakpoints` flag is given, so the loop below reproduces the old behavior.
 */
function modeBreakpoint(cfg: RunConfig): Breakpoint {
  return cfg.mode === 'mobile'
    ? { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, device: 'iPhone 13' }
    : { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 2 };
}

/**
 * Build the BrowserContextOptions for ONE (breakpoint × colorScheme) variant.
 *
 * This is the per-variant factory the pipeline loop calls: it folds the
 * viewport/device profile, the color-scheme, deterministic locale/timezone,
 * non-interactive auth, the realistic UA + Accept-Language, and the optional
 * HAR recorder into a single options object. It NEVER launches anything and
 * NEVER mutates its inputs.
 *
 * Back-compat: when `breakpoint` is the mode-implied profile and `colorScheme`
 * is 'light', the result is byte-equivalent to the old binary
 * 1440x900 / iPhone-13 contexts (determinism's `colorScheme: 'light'` default is
 * preserved, just made explicit).
 *
 * Device descriptors (e.g. iPhone 13) own viewport/DSF/isMobile/UA — when
 * `breakpoint.device` is set we spread the descriptor and do NOT override those
 * fields. For plain breakpoints we set viewport + deviceScaleFactor + the
 * desktop UA. `isMobile`/`hasTouch` are applied for non-device mobile profiles
 * (e.g. tablet) so layout/media-queries resolve correctly.
 */
/**
 * Resolve the Playwright engine for a `--browser` value. Firefox/WebKit are
 * different ENGINES (not Chromium channels) with different TLS/HTTP-2 fingerprints
 * — the escape hatch for Chromium-tuned bot walls (e.g. Akamai/OpenTable, which
 * RSTs bundled-Chromium's HTTP/2 but serves Firefox/WebKit fine). 'chrome'/'msedge'
 * are real-Chromium channels (genuine fingerprint, needs the browser installed).
 */
export function pickEngine(channel?: string): {
  type: BrowserType;
  isChromium: boolean;
  launchChannel?: string;
} {
  switch (channel) {
    case 'firefox':
      return { type: firefox, isChromium: false };
    case 'webkit':
      return { type: webkit, isChromium: false };
    case 'chrome':
    case 'msedge':
      return { type: chromium, isChromium: true, launchChannel: channel };
    default:
      return { type: chromium, isChromium: true };
  }
}

export function buildContextOptions(
  breakpoint: Breakpoint,
  colorScheme: ColorScheme,
  cfg: RunConfig,
  userAgent?: string,
): BrowserContextOptions {
  // 1. Viewport / device base.
  let opts: BrowserContextOptions;
  const descriptor = breakpoint.device ? devices[breakpoint.device] : undefined;
  if (descriptor) {
    // Device descriptor owns viewport/DSF/isMobile/UA — do NOT override them.
    opts = { ...descriptor };
  } else {
    opts = {
      viewport: { width: breakpoint.width, height: breakpoint.height },
      deviceScaleFactor: breakpoint.deviceScaleFactor,
    };
    // Set the UA only when given (Chromium → derived Chrome UA). For Firefox/WebKit
    // the caller passes none so the engine's NATIVE UA is kept — a spoofed Chrome UA
    // would mismatch their fingerprint and defeat switching engines.
    if (userAgent) opts.userAgent = userAgent;
    // Non-device mobile/tablet profiles still need mobile emulation flags so
    // responsive media queries and touch layouts resolve.
    if (breakpoint.isMobile) {
      opts.isMobile = true;
      opts.hasTouch = true;
    }
  }

  // Firefox doesn't support isMobile/hasTouch — strip them so it doesn't throw.
  if (cfg.browserChannel === 'firefox') {
    delete opts.isMobile;
    delete opts.hasTouch;
  }

  // 2. Realistic browser headers (avoid bot-gated 403s on auth pages, etc.).
  opts.extraHTTPHeaders = {
    'Accept-Language': ACCEPT_LANGUAGE,
    ...(opts.extraHTTPHeaders ?? {}),
  };

  // 3. Non-interactive auth (saved session + HTTP Basic).
  opts = applyAuthToContextOptions(opts, cfg.auth, cfg.mode);

  // 4. Deterministic locale/timezone/reduced-motion. We override the scheme it
  //    sets so the requested colorScheme wins; when determinism is off we still
  //    honor the colorScheme via emulation.
  if (cfg.determinism?.enabled) {
    opts = { ...opts, ...determinismContextOptions(cfg) };
  }
  opts.colorScheme = colorScheme;

  // 5. HAR recorder (headers/timings, NO embedded bodies) when API capture is on.
  if (cfg.api?.enabled) {
    opts = {
      ...opts,
      recordHar: {
        path: harTempPath(cfg.outDir),
        content: 'omit',
        mode: 'full',
      },
    };
  }

  return opts;
}

/**
 * Launches Chromium and a single back-compat context (the first breakpoint and
 * the first color scheme). Multi-variant capture is driven by the pipeline loop,
 * which builds each variant's context via {@link buildContextOptions} and calls
 * {@link launchSessionForVariant}. This default path preserves the historical
 * one-context behavior so unchanged runs behave identically.
 */
export async function launchSession(cfg: RunConfig): Promise<BrowserSession> {
  const breakpoint = cfg.breakpoints?.[0] ?? modeBreakpoint(cfg);
  const colorScheme: ColorScheme = cfg.colorSchemes?.[0] ?? 'light';
  return launchSessionForVariant(cfg, breakpoint, colorScheme);
}

/**
 * Launch a browser + context configured for ONE (breakpoint × colorScheme)
 * variant. Same wiring as the legacy single-context path (asset collector +
 * API body sidecar + deterministic Math.random seed), just parameterized by the
 * visual axes. The pipeline calls this once per variant.
 *
 * NOTE: each call launches its OWN browser so HAR/recordHar paths and contexts
 * don't collide; the caller must {@link closeSession} every returned session.
 */
export async function launchSessionForVariant(
  cfg: RunConfig,
  breakpoint: Breakpoint,
  colorScheme: ColorScheme,
): Promise<BrowserSession> {
  // Anti-bot launch levers: a different ENGINE (firefox/webkit) escapes Chromium-
  // tuned fingerprint walls; a real Chromium channel (chrome/msedge) = genuine
  // fingerprint; headed = less detectable; http1 = no HTTP/2 fingerprint. Defaults
  // (no --browser, headless) match the historical bundled-Chromium behavior.
  const eng = pickEngine(cfg.browserChannel);
  const browser = await eng.type.launch({
    headless: !cfg.headed,
    // Chromium-only flags — Firefox/WebKit reject unknown chromium args.
    ...(eng.isChromium ? { args: cfg.http1 ? [...ANTIBOT_ARGS, '--disable-http2'] : ANTIBOT_ARGS } : {}),
    ...(eng.launchChannel ? { channel: eng.launchChannel } : {}),
  });

  // Chromium: override UA to the real engine version (fixes version-gated blocks
  // like Notion). Firefox/WebKit: keep their native UA (passing none).
  const ua = eng.isChromium ? chromeUserAgent(browser.version()) : undefined;
  const opts = buildContextOptions(breakpoint, colorScheme, cfg, ua);

  const context = await browser.newContext(opts);

  context.setDefaultTimeout(30000);
  context.setDefaultNavigationTimeout(45000);

  // Seed Math.random in every page (deterministic client-side ids).
  if (cfg.determinism?.enabled) {
    await context.addInitScript(seedRandom);
  }

  // Attach the asset collector (saves real downloaded files) before any nav.
  let collector: AssetCollector | undefined;
  if (cfg.extract?.enabled && cfg.extract.assets) {
    collector = createAssetCollector(context, cfg, cfg.outDir);
  }

  // Attach the bounded API JSON-body sidecar (feeds OpenAPI schemas).
  let apiBodies: ApiBodyCollector | undefined;
  if (cfg.api?.enabled) {
    apiBodies = createApiBodyCollector(context, cfg);
  }

  return { browser, context, collector, apiBodies };
}

/** Best-effort teardown: close context then browser; one failure won't block the other. */
export async function closeSession(session: BrowserSession): Promise<void> {
  try {
    await session.context.close();
  } catch {
    // ignore — still attempt to close the browser
  }
  try {
    await session.browser.close();
  } catch {
    // ignore
  }
}
