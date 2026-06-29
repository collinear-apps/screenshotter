// Shared config builder used by BOTH the CLI and the MCP server, so the two
// entry points produce identical RunConfigs. Parses primitive inputs (URL,
// pages, numbers) and auth inputs (saved session / basic auth / form login)
// into a fully-resolved RunConfig.
import path from 'path';
import type {
  ApiConfig,
  AuthConfig,
  Breakpoint,
  CaptureIntegrityConfig,
  DeterminismConfig,
  ExploreConfig,
  ExtractConfig,
  FormLogin,
  Mode,
  PromptConfig,
  RunConfig,
} from './types';
import { siteNameFromUrl } from './output/naming';

export interface BuildConfigInput {
  url: string;
  mode: Mode;
  /** Raw page entries (absolute URLs or bare paths); resolved against url. */
  pages?: string[];
  out?: string;
  maxPages?: number;
  depth?: number;
  /** Follow same-origin links inside discovered pages (`--sub-links`). */
  subLinks?: boolean;
  /** Cap on links followed per page when subLinks is on. */
  maxSubLinksPerPage?: number;
  concurrency?: number;
  zip?: boolean;

  // ── Auth inputs (all optional) ──
  /** Path to a saved storageState JSON (from `screenshotter login`). */
  authFile?: string;
  /** "user:pass" for HTTP Basic. */
  basicAuth?: string;
  /** Form-login page URL; presence (or username/password) enables form login. */
  loginUrl?: string;
  /** Falls back to SCREENSHOTTER_USERNAME when omitted. */
  username?: string;
  /** Falls back to SCREENSHOTTER_PASSWORD when omitted. */
  password?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  successUrl?: string;

  // ── API capture inputs ──
  /** Enable network/API capture (OpenAPI + catalog + HAR). */
  api?: boolean;
  /** Restrict captured calls to the site's own origin/subdomains. */
  apiSameOrigin?: boolean;
  /** Per-body cap in KB (default 256). */
  apiMaxBodyKb?: number;
  /** Drive interactions to provoke first-party APIs (default true when api on). */
  apiInteract?: boolean;
  /** Search term typed during interaction (default "a"). */
  apiSearch?: string;

  // ── Extraction (DOM + tokens + assets) ──
  /** Enable DOM + design-tokens + real-asset capture. */
  extract?: boolean;
  /** Capture ONLY accessibility-tree goldens (skip DOM/tokens/assets/etc.). */
  a11y?: boolean;
  /** Also save JavaScript bundles as assets. */
  assetsJs?: boolean;
  /** Emit normalized copies of DOM (default true). */
  normalize?: boolean;

  // ── Determinism (default ON) ──
  /** Disable deterministic capture when false. */
  deterministic?: boolean;
  freezeTime?: string;
  timezone?: string;
  locale?: string;
  /** Comma-separated CSS selectors to visually mask in screenshots. */
  mask?: string;

  // ── Rebuild prompt ──
  /** Generate REBUILD-PROMPT.md (default true). */
  prompt?: boolean;
  /** Optional target-stack hint for the generated prompt. */
  promptStack?: string;

  // ── Full interaction explorer ──
  /** Enable `--full` exhaustive interaction recording. */
  full?: boolean;
  /** Aggressive clicking (form submits/mutations). */
  aggressive?: boolean;
  fullDepth?: number;
  maxActions?: number;
  maxActionsPerPage?: number;

  // ── Phase 0: capture integrity ──
  maxRetries?: number;
  requestDelayMs?: number;
  /** Disable mid-crawl 401/403/login-redirect detection when false (default on). */
  detectAuthExpiry?: boolean;
  /** Disable single-flight re-auth when false (default on). */
  reauth?: boolean;

  // ── Phase 1: dynamic data contract ──
  /** Disable SSE/stream capture when false (default on with --api). */
  captureStream?: boolean;
  /** Capture WebSocket frames (default off). */
  captureWebsocket?: boolean;
  /** Disable the stateful mock when false (default on with --api). */
  stateful?: boolean;
  /** Disable value-shape secret redaction when false (default on). */
  redactValueShapes?: boolean;

  // ── Phase 3: responsive / visual variants ──
  /** Comma-separated breakpoint names/specs (e.g. "mobile,tablet,desktop,wide"). */
  breakpoints?: string;
  /** Capture a dark color-scheme pass in addition to light. */
  dark?: boolean;
  /** Ingest sitemap.xml / robots.txt to seed discovery. */
  sitemap?: boolean;
  /** Mint pagination / load-more targets during discovery. */
  paginate?: boolean;

  // ── Phase 4: runnable handoff ──
  /** Emit a runnable frontend scaffold + bundle index (default on when --extract or --full). */
  scaffold?: boolean;

  // ── Anti-bot launch levers ──
  /** Browser channel: 'chrome' | 'msedge' (real browser) vs bundled Chromium. */
  browser?: string;
  /** Launch headed (visible). */
  headed?: boolean;
  /** Force HTTP/1.1 (adds --disable-http2). */
  http1?: boolean;
}

const DEFAULTS = {
  maxPages: 25,
  /** Effective max-pages default when --sub-links is on (much larger crawl). */
  subLinksMaxPages: 150,
  maxSubLinksPerPage: 25,
  depth: 2,
  concurrency: 4,
  apiMaxBodyKb: 256,
  apiSearch: 'a',
  freezeTime: '2024-01-01T00:00:00.000Z',
  timezone: 'UTC',
  locale: 'en-US',
  maxAssetBytes: 10 * 1024 * 1024,
  fullDepth: 2,
  maxActions: 500,
  maxActionsPerPage: 40,
  perActionTimeoutMs: 8000,
  pageBudgetMs: 120000,
  maxRetries: 3,
  requestDelayMs: 0,
  backoffBaseMs: 1000,
};

/** Named breakpoint registry. `mode` expands to one of these by default. */
const BREAKPOINTS: Record<string, Breakpoint> = {
  mobile: { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, device: 'iPhone 13' },
  tablet: { name: 'tablet', width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true },
  desktop: { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 2 },
  wide: { name: 'wide', width: 1920, height: 1080, deviceScaleFactor: 2 },
};

/** Resolve the requested breakpoints, defaulting to a single profile from `mode`. */
function buildBreakpoints(input: BuildConfigInput): Breakpoint[] {
  if (input.breakpoints) {
    const names = input.breakpoints
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const out = names.map((n) => BREAKPOINTS[n]).filter(Boolean) as Breakpoint[];
    if (out.length > 0) return out;
  }
  // Default: the single breakpoint implied by --mode (back-compat).
  return [input.mode === 'mobile' ? BREAKPOINTS.mobile : BREAKPOINTS.desktop];
}

/** Phase 0 — capture-integrity config (always present). */
function buildCaptureConfig(input: BuildConfigInput): CaptureIntegrityConfig {
  return {
    maxRetries: input.maxRetries ?? DEFAULTS.maxRetries,
    requestDelayMs: input.requestDelayMs ?? DEFAULTS.requestDelayMs,
    backoffBaseMs: DEFAULTS.backoffBaseMs,
    detectAuthExpiry: input.detectAuthExpiry !== false,
    reauth: input.reauth !== false,
  };
}

/** Prepends https:// only when NO URL scheme is present (preserves file://, etc.). */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * Resolves each page entry against the base URL:
 *  - absolute http(s) URLs pass through unchanged
 *  - bare paths ("/models") resolve relative to `baseUrl`
 */
function resolvePages(
  pages: string[] | undefined,
  baseUrl: string,
): string[] | undefined {
  if (!pages || pages.length === 0) return undefined;
  const resolved = pages.map((entry) =>
    /^https?:\/\//i.test(entry) ? entry : new URL(entry, baseUrl).toString(),
  );
  return resolved.length > 0 ? resolved : undefined;
}

/** Builds the optional AuthConfig from raw inputs. Throws on partial form login. */
function buildAuthConfig(input: BuildConfigInput): AuthConfig | undefined {
  const auth: AuthConfig = {};

  if (input.authFile) auth.storageState = input.authFile;

  if (input.basicAuth) {
    const idx = input.basicAuth.indexOf(':');
    if (idx === -1) {
      throw new Error('Invalid --basic-auth. Expected "username:password".');
    }
    auth.basicAuth = {
      username: input.basicAuth.slice(0, idx),
      password: input.basicAuth.slice(idx + 1),
    };
  }

  const username = input.username ?? process.env.SCREENSHOTTER_USERNAME;
  const password = input.password ?? process.env.SCREENSHOTTER_PASSWORD;
  const wantsFormLogin = Boolean(input.loginUrl || username || password);
  if (wantsFormLogin) {
    if (!input.loginUrl || !username || !password) {
      throw new Error(
        'Form login requires --login-url plus --username/--password ' +
          '(or SCREENSHOTTER_USERNAME / SCREENSHOTTER_PASSWORD).',
      );
    }
    const formLogin: FormLogin = {
      loginUrl: normalizeBaseUrl(input.loginUrl),
      username,
      password,
      usernameSelector: input.usernameSelector,
      passwordSelector: input.passwordSelector,
      submitSelector: input.submitSelector,
      successUrl: input.successUrl,
    };
    auth.formLogin = formLogin;
  }

  return auth.storageState || auth.basicAuth || auth.formLogin ? auth : undefined;
}

/** Builds the optional ApiConfig (only when API capture is enabled). */
function buildApiConfig(input: BuildConfigInput): ApiConfig | undefined {
  if (!input.api) return undefined;
  const kb = input.apiMaxBodyKb ?? DEFAULTS.apiMaxBodyKb;
  return {
    enabled: true,
    sameOriginOnly: Boolean(input.apiSameOrigin),
    maxBodyBytes: Math.max(1, kb) * 1024,
    interact: input.apiInteract !== false, // default ON when API capture is enabled
    searchTerm: input.apiSearch ?? DEFAULTS.apiSearch,
    captureStream: input.captureStream !== false, // default ON with --api
    captureWebsocket: Boolean(input.captureWebsocket),
    stateful: input.stateful !== false, // default ON with --api
    redactValueShapes: input.redactValueShapes !== false, // default ON
  };
}

/** Comma/space-separated selector list → string[]. */
function parseSelectors(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Determinism config — present on every run; `enabled` defaults to true. */
function buildDeterminismConfig(input: BuildConfigInput): DeterminismConfig {
  return {
    enabled: input.deterministic !== false,
    freezeTimeISO: input.freezeTime ?? DEFAULTS.freezeTime,
    timezone: input.timezone ?? DEFAULTS.timezone,
    locale: input.locale ?? DEFAULTS.locale,
    maskSelectors: parseSelectors(input.mask),
  };
}

/** Extraction config — only present when --extract is set. */
function buildExtractConfig(input: BuildConfigInput): ExtractConfig | undefined {
  if (!input.extract && !input.a11y) return undefined;
  // `--a11y` captures ONLY accessibility goldens — a fast, lean pass with every
  // other extract sub-feature off. `--extract` is the full source-material capture.
  const full = !input.a11y; // a11y flag narrows to a11y-only even alongside --extract
  return {
    enabled: true,
    dom: full,
    tokens: full,
    assets: full,
    assetTypes: {
      fonts: full,
      images: full,
      svg: full,
      css: full,
      js: full && Boolean(input.assetsJs),
    },
    normalize: full && input.normalize !== false,
    maxAssetBytes: DEFAULTS.maxAssetBytes,
    a11y: true,
    listings: full,
    entities: full,
    readme: full,
    cssVars: full,
    elementStates: full,
    scrubHtml: full,
    layout: full,
    surfaces: full,
    shadowDom: full,
  };
}

/** Rebuild-prompt config — present on every run; `enabled` defaults to true. */
function buildPromptConfig(input: BuildConfigInput): PromptConfig {
  return {
    enabled: input.prompt !== false,
    stack: input.promptStack,
  };
}

/** Explorer config — only present when --full is set. */
function buildExploreConfig(input: BuildConfigInput): ExploreConfig | undefined {
  if (!input.full) return undefined;
  return {
    enabled: true,
    aggressive: Boolean(input.aggressive),
    maxDepth: input.fullDepth ?? DEFAULTS.fullDepth,
    maxActions: input.maxActions ?? DEFAULTS.maxActions,
    maxActionsPerPage: input.maxActionsPerPage ?? DEFAULTS.maxActionsPerPage,
    perActionTimeoutMs: DEFAULTS.perActionTimeoutMs,
    pageBudgetMs: DEFAULTS.pageBudgetMs,
    captureDom: true,
    captureNetwork: true,
    downloads: true,
  };
}

export function buildRunConfig(input: BuildConfigInput): RunConfig {
  const url = normalizeBaseUrl(input.url);
  const siteName = siteNameFromUrl(url);

  return {
    url,
    mode: input.mode,
    pages: resolvePages(input.pages, url),
    outDir: input.out ?? path.join('output', siteName),
    siteName,
    maxPages:
      input.maxPages ?? (input.subLinks ? DEFAULTS.subLinksMaxPages : DEFAULTS.maxPages),
    depth: input.depth ?? DEFAULTS.depth,
    subLinks: input.subLinks ?? false,
    maxSubLinksPerPage: input.maxSubLinksPerPage ?? DEFAULTS.maxSubLinksPerPage,
    concurrency: input.concurrency ?? DEFAULTS.concurrency,
    zip: input.zip ?? true,
    capture: buildCaptureConfig(input),
    breakpoints: buildBreakpoints(input),
    colorSchemes: input.dark ? ['light', 'dark'] : ['light'],
    useSitemap: Boolean(input.sitemap),
    paginate: Boolean(input.paginate),
    // Scaffold defaults ON when we're producing rebuild material (extract or full).
    scaffold: input.scaffold ?? Boolean(input.extract || input.full),
    browserChannel: input.browser && input.browser !== 'chromium' ? input.browser : undefined,
    headed: Boolean(input.headed),
    http1: Boolean(input.http1),
    auth: buildAuthConfig(input),
    api: buildApiConfig(input),
    determinism: buildDeterminismConfig(input),
    extract: buildExtractConfig(input),
    prompt: buildPromptConfig(input),
    explore: buildExploreConfig(input),
  };
}
