// ─────────────────────────────────────────────────────────────────────────────
// SHARED CONTRACTS — the integration boundary for all modules.
// Every wave-1 module codes against the types in this file and must NOT change
// these signatures without coordinating, since other modules depend on them.
// ─────────────────────────────────────────────────────────────────────────────

import type { BrowserContext } from 'playwright';

export type Mode = 'web' | 'mobile';

/** Fully-resolved configuration for a single run (after CLI flags + prompts). */
export interface RunConfig {
  /** Base URL to capture, absolute (e.g. "https://huggingface.co"). */
  url: string;
  mode: Mode;
  /** Explicit pages/paths to capture. If omitted/empty, discovery picks pages. */
  pages?: string[];
  /** Working output directory, e.g. "./output/huggingface". */
  outDir: string;
  /** Short site name used for the zip filename, e.g. "huggingface". */
  siteName: string;
  /** Max pages discovery/crawl may return. */
  maxPages: number;
  /** Max crawl depth for the generic crawler. */
  depth: number;
  /** Follow same-origin links inside discovered pages and capture them too (`--sub-links`). */
  subLinks: boolean;
  /** Cap on links followed per page when `subLinks` is on. */
  maxSubLinksPerPage: number;
  /** Number of pages captured concurrently. */
  concurrency: number;
  /** Whether to produce the final zip. */
  zip: boolean;
  /** Phase 0 — capture integrity (retry/backoff, auth-expiry detection, manifest). */
  capture: CaptureIntegrityConfig;
  /** Phase 3 — responsive breakpoints to capture in one run (expands from `mode`). */
  breakpoints: Breakpoint[];
  /** Phase 3 — color-scheme variants to capture (e.g. ['light','dark']). */
  colorSchemes: ColorScheme[];
  /** Phase 3 — ingest sitemap.xml / robots.txt to seed discovery. */
  useSitemap: boolean;
  /** Phase 3 — mint pagination / "load more" targets during discovery. */
  paginate: boolean;
  /** Phase 4 — emit a runnable frontend scaffold + bundle index into the zip. */
  scaffold: boolean;
  /** Optional authentication for gated sites. */
  auth?: AuthConfig;
  /** Optional network/API capture. */
  api?: ApiConfig;
  /** Deterministic-capture knobs (always present; `enabled` toggles). */
  determinism: DeterminismConfig;
  /** Optional source-material extraction (DOM + design tokens + real assets). */
  extract?: ExtractConfig;
  /** Self-contained rebuild-prompt generation (always present; `enabled` toggles). */
  prompt: PromptConfig;
  /** Optional `--full` exhaustive interaction explorer. */
  explore?: ExploreConfig;
}

/** Controls the generated REBUILD-PROMPT.md (the "give the zip to Claude" spec). */
export interface PromptConfig {
  enabled: boolean;
  /** Optional target-stack hint, e.g. "react+tailwind", "next", "html+css". */
  stack?: string;
}

/** `--full` exhaustive interaction explorer config. */
export interface ExploreConfig {
  enabled: boolean;
  /** Click ~everything incl. form submits/mutations (still hard-skips logout/payment). */
  aggressive: boolean;
  maxDepth: number;
  /** Global cap on actions across the whole run. */
  maxActions: number;
  maxActionsPerPage: number;
  perActionTimeoutMs: number;
  pageBudgetMs: number;
  captureDom: boolean;
  captureNetwork: boolean;
  downloads: boolean;
}

/** One enumerated clickable element on a page. */
export interface Clickable {
  /** Unique, reasonably stable selector to re-find the element. */
  selector: string;
  /** Accessible name / trimmed text. */
  label: string;
  /** button | link | tab | menuitem | summary | input | select | pointer | … */
  kind: string;
  /** Resolved same-origin href, if this is an in-app link. */
  sameOriginHref?: string;
  /** Sits inside a visible open menu/listbox/dialog/expanded popover. */
  inMenu?: boolean;
  /** A disclosure trigger (aria-haspopup / aria-expanded / <summary>). */
  opensMenu?: boolean;
  // ── Phase 2: form-field metadata (when kind is an input/select/textarea) ──
  /** input[type] (text/search/email/password/number/checkbox/radio/file/...). */
  inputType?: string;
  /** Field is required (required attr / aria-required). */
  required?: boolean;
  /** HTML pattern / inputmode constraint, when present. */
  pattern?: string;
  /** Placeholder text, when present. */
  placeholder?: string;
  /** For <select>/listbox: the option labels. */
  options?: string[];
}

export type ActionOutcome =
  | 'navigation'
  | 'modal'
  | 'download'
  | 'dom-change'
  | 'noop'
  | 'skipped'
  | 'error';

/** A single recorded click and what it did. */
export interface ActionRecord {
  id: string;
  pageLabel: string;
  depth: number;
  label: string;
  kind: string;
  selector: string;
  outcome: ActionOutcome;
  toUrl?: string;
  downloadFile?: string;
  /** URLs requested while the action settled. */
  network?: string[];
  /** Path (relative to bundle root) of the result-state screenshot. */
  screenshot?: string;
  /** Path (relative to bundle root) of the result-state DOM. */
  dom?: string;
  note?: string;
  /** Clicks (from baseline) taken to reach the state this action ran in. */
  path?: { label: string; kind: string; selector: string }[];
  // ── Phase 2 additions ──
  /** Value typed/selected for fill/select actions. */
  value?: string;
  /** Client-side validation result observed after a fill/submit. */
  validation?: { valid?: boolean; message?: string };
  /** Transient UI state captured around the action. */
  transientState?: 'loading' | 'empty' | 'error' | 'success';
}

/** Exploration result for one starting page. */
export interface ExploreResult {
  pageLabel: string;
  baseUrl: string;
  actions: ActionRecord[];
  /** Distinct states discovered. */
  states: number;
}

// ── Functional substrate (AUDIT.md remediation) ──────────────────────────────

/** A recorded API response, written as a standalone importable fixture. */
export interface ApiFixture {
  method: string;
  pathTemplate: string;
  url: string;
  status: number;
  contentType?: string;
  response?: unknown;
  requestExample?: unknown;
  /** Relative path of the fixture file within api/fixtures/. */
  file: string;
  // ── Phase 1: dynamic/stateful/streaming contract ──
  /** Canonicalized query string used to disambiguate same-path fixtures. */
  querySignature?: string;
  /** Stable hash of the canonical request body (for request-aware matching). */
  requestBodyHash?: string;
  /** Allowlisted response headers (pagination/cursor/rate-limit/content-type). */
  responseHeaders?: Record<string, string>;
  /** True for SSE / chunked-streaming responses. */
  isStream?: boolean;
  /** Buffered transcript of stream events (when isStream). */
  streamTranscript?: string[];
  /** GraphQL operationName, when this is a GraphQL call. */
  graphqlOperation?: string;
  /** How many captured samples were merged into this fixture. */
  variants?: number;
}

/** A route the generated mock server serves. */
export interface MockRoute {
  method: string;
  pathTemplate: string;
  status: number;
  contentType?: string;
  bodyFile: string;
  // ── Phase 1: request-aware matching + stateful + streaming ──
  /** Query params this route variant matches (best-match wins). */
  matchQuery?: Record<string, string>;
  /** Request-body hash this route variant matches. */
  matchBodyHash?: string;
  /** GraphQL operationName this route variant matches. */
  matchOperation?: string;
  /** Allowlisted response headers to echo. */
  responseHeaders?: Record<string, string>;
  /** Replay as an SSE/stream. */
  isStream?: boolean;
  /** Participates in the stateful store as this resource/collection. */
  resource?: string;
  /** CRUD verb this route implements against the stateful store. */
  crud?: 'list' | 'get' | 'create' | 'update' | 'delete';
}

/** A seed record for the mock server's stateful store. */
export interface MockSeedEntity {
  resource: string;
  id?: string;
  data: unknown;
}

/** One API call a behavior fired, linked to its fixture. */
export interface BehaviorApiCall {
  method: string;
  url: string;
  fixture?: string;
}

/** A machine-readable feature behavior (what a control does). */
export interface BehaviorSpec {
  id: string;
  page: string;
  pageUrl: string;
  trigger: { label: string; kind: string; selector: string };
  action: 'click' | 'fill' | 'press' | 'select';
  outcome: ActionOutcome;
  toUrl?: string;
  download?: string;
  api: BehaviorApiCall[];
  screenshot?: string;
  a11y?: string;
  /** Semantic steps to reach the trigger (e.g. open a dropdown first). */
  precondition?: { label: string; kind: string }[];
  // ── Phase 2 additions ──
  /** Value to type/select when action is fill/select. */
  value?: string;
  /** Observed client-side validation behavior (invalid input → message). */
  validation?: { valid?: boolean; message?: string };
  /** Form fields involved (for multi-field form behaviors). */
  formFields?: { name: string; kind: string; inputType?: string; required?: boolean; pattern?: string }[];
}

/** A plain navigation edge (routing, not a feature). */
export interface RouteSpec {
  fromPage: string;
  label: string;
  toUrl: string;
}

/** Features + routes extracted from exploration. */
export interface BehaviorBundle {
  features: BehaviorSpec[];
  routes: RouteSpec[];
}

/** A functional QC task — semantic + portable so it runs against a rebuild. */
export interface QcTask {
  id: string;
  title: string;
  page: string;
  pageUrl: string;
  /** Semantic locator (role + accessible name) — portable across rebuilds. */
  semantic: { role?: string; name: string };
  action: string;
  /** Semantic steps to perform BEFORE the main action (reach a sub-state). */
  pre?: { role?: string; name: string; action: string }[];
  steps: string[];
  expect: {
    kind: ActionOutcome;
    detail?: string;
    api?: string[];
    a11yGolden?: string;
    /** Phase 4 — data-fidelity: captured field values that must render after the action. */
    data?: DataAssertion[];
  };
  /** Phase 2 — value to type/select before asserting (fill/select tasks). */
  value?: string;
}

/** Phase 4 — assert a captured value (from a fixture/DOM) renders in the rebuild. */
export interface DataAssertion {
  /** The literal text expected to appear (from a captured fixture/entity). */
  expectText: string;
  /** Optional semantic/CSS hint of where it should appear. */
  selectorHint?: string;
  /** Provenance, e.g. "fixture:models-GET.json#[0].id" or "entity:model/gpt2". */
  source: string;
}

/** Result of executing one QC task against a target. */
export interface QcRunResult {
  id: string;
  title: string;
  pass: boolean;
  reason: string;
}

/** Deterministic capture: stable clock/locale/timezone, no animation, masking. */
export interface DeterminismConfig {
  enabled: boolean;
  /** ISO timestamp the page clock is frozen to. */
  freezeTimeISO: string;
  timezone: string;
  locale: string;
  /** CSS selectors whose regions are blacked out in screenshots. */
  maskSelectors: string[];
}

/** Which downloaded asset categories to save off the wire. */
export interface AssetTypes {
  fonts: boolean;
  images: boolean;
  svg: boolean;
  css: boolean;
  js: boolean;
}

/** Source-material extraction config (DOM, design tokens, real assets). */
export interface ExtractConfig {
  enabled: boolean;
  dom: boolean;
  tokens: boolean;
  assets: boolean;
  assetTypes: AssetTypes;
  /** Also emit `*.normalized.html` copies with dynamic values placeholdered. */
  normalize: boolean;
  /** Per-asset size cap (bytes). */
  maxAssetBytes: number;
  /** Capture per-state accessibility goldens (AX JSON + ARIA YAML). */
  a11y: boolean;
  // ── Phase 2/3 additions ──
  /** Extract structured listing rows/records from list pages. */
  listings: boolean;
  /** Build a normalized entity/relationship graph from captured data. */
  entities: boolean;
  /** Extract README/markdown content (raw + rendered) from detail pages. */
  readme: boolean;
  /** Harvest CSS custom properties (theme variables) from stylesheets. */
  cssVars: boolean;
  /** Capture per-element interaction states (hover/focus/active/disabled). */
  elementStates: boolean;
  /** Scrub secret-looking substrings out of saved HTML. */
  scrubHtml: boolean;
}

/** Raw per-page design-token tallies (computed-style frequencies). */
export interface PageTokens {
  colors: Record<string, number>;
  backgrounds: Record<string, number>;
  borderColors: Record<string, number>;
  radii: Record<string, number>;
  shadows: Record<string, number>;
  spacing: Record<string, number>;
  fonts: Record<string, number>;
  fontSizes: Record<string, number>;
}

/** A ranked token value. */
export interface TokenValue {
  value: string;
  count: number;
}

/** Aggregated design tokens across captured pages. */
export interface DesignTokens {
  colors: TokenValue[];
  backgrounds: TokenValue[];
  borderColors: TokenValue[];
  radii: TokenValue[];
  shadows: TokenValue[];
  spacing: TokenValue[];
  fontFamilies: TokenValue[];
  fontSizes: TokenValue[];
  pageCount: number;
}

/** One saved asset, recorded in assets/manifest.json. */
export interface AssetManifestEntry {
  url: string;
  file: string;
  contentType: string;
  bytes: number;
  category: string;
  // ── Phase 3: @font-face linkage (for fonts) ──
  /** font-family this file is bound to (from @font-face), when known. */
  fontFamily?: string;
  /** font-weight from the @font-face rule, when known. */
  fontWeight?: string;
  /** font-style from the @font-face rule, when known. */
  fontStyle?: string;
}

/** Network/API capture configuration. */
export interface ApiConfig {
  enabled: boolean;
  /** Restrict captured API calls to the site's own origin/subdomains. */
  sameOriginOnly: boolean;
  /** Per-body size cap (bytes) for parsing/storing JSON bodies. */
  maxBodyBytes: number;
  /** Drive safe interactions (scroll/search/tabs/pagination) to provoke
   *  first-party API calls. Runs AFTER the screenshot so visuals are unaffected. */
  interact: boolean;
  /** Query typed into search boxes during interaction. */
  searchTerm: string;
  // ── Phase 1 additions ──
  /** Capture SSE / chunked-streaming responses (buffered transcript). */
  captureStream: boolean;
  /** Capture WebSocket frames into the contract. */
  captureWebsocket: boolean;
  /** Generate a stateful mock (CRUD store seeded from captured data + request bodies). */
  stateful: boolean;
  /** Redact secret-shaped VALUES (not just known key names) in bodies. */
  redactValueShapes: boolean;
}

/** One captured API call (already filtered to API traffic and redacted). */
export interface ApiCall {
  method: string;
  url: string;
  host: string;
  pathname: string;
  query: Record<string, string | string[]>;
  status: number;
  requestContentType?: string;
  responseContentType?: string;
  /** Redacted (Authorization/Cookie/api-key/etc. removed). */
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  /** Parsed + redacted JSON body, or undefined (non-JSON / too large / absent). */
  requestBody?: unknown;
  responseBody?: unknown;
  /** xhr | fetch | ... (from the HAR resource type, when known). */
  resourceType?: string;
}

/** A captured API request/response body pair (from the bounded sidecar collector). */
export interface ApiBodyEntry {
  requestBody?: string;
  responseBody?: string;
  requestContentType?: string;
  responseContentType?: string;
}

/** A flattened accessibility-tree node (for the a11y diff gate). */
export interface AxNodeFlat {
  role: string;
  name: string;
  depth: number;
}

/** Result of comparing two accessibility trees. */
export interface A11yDiff {
  score: number;
  added: AxNodeFlat[];
  removed: AxNodeFlat[];
  changed: { from: AxNodeFlat; to: AxNodeFlat }[];
}

/** Summary of API capture, surfaced in RunResult + logs. */
export interface ApiSummary {
  hosts: string[];
  /** Distinct (method + templated path) endpoints across all hosts. */
  endpoints: number;
  /** Total captured API calls. */
  calls: number;
}

/** Form-based (username/password) login configuration. */
export interface FormLogin {
  /** URL of the login page. */
  loginUrl: string;
  username: string;
  password: string;
  /** Optional CSS selector overrides; autodetected when omitted. */
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  /** Optional URL/glob to wait for after submit (confirms login success). */
  successUrl?: string;
}

/** How to authenticate to a gated site. Methods are mutually compatible. */
export interface AuthConfig {
  /** Path to a saved Playwright storageState JSON (from `screenshotter login`). */
  storageState?: string;
  /** HTTP Basic credentials. */
  basicAuth?: { username: string; password: string };
  /** Username/password form autofill (run once before capture). */
  formLogin?: FormLogin;
}

/** Structured result of a run, returned by pipeline.run (used by CLI + MCP). */
export interface RunResult {
  outDir: string;
  zipPath?: string;
  captured: number;
  failed: number;
  results: CaptureResult[];
  /** Present when API capture was enabled. */
  api?: ApiSummary;
  /** Number of distinct assets saved (when --extract). */
  assets?: number;
  /** Number of DOM dumps written (when --extract). */
  domPages?: number;
  /** Number of actions recorded (when --full). */
  actions?: number;
  /** Number of files downloaded (when --full). */
  downloads?: number;
  /** Number of a11y goldens captured (when --extract). */
  a11y?: number;
  /** Path to the run manifest (Phase 0). */
  manifestPath?: string;
  /** Path to the bundle index (Phase 4). */
  bundleIndexPath?: string;
}

/** Minimal logging sink so callers control where progress goes (stdout vs stderr). */
export interface Logger {
  info(msg: string): void;
}

/** A single page to capture. `category` drives output-folder clustering. */
export interface PageTarget {
  /** Absolute URL. */
  url: string;
  /** Human label, e.g. "models-index" or "gpt2". */
  label: string;
  /** Cluster/category, e.g. "Models". Falls back to a derived bucket when absent. */
  category?: string;
}

/** Result of capturing one target (screenshot + per-page typography). */
export interface CaptureResult {
  target: PageTarget;
  /** Absolute path to the PNG written, if capture succeeded. */
  screenshotPath?: string;
  ok: boolean;
  error?: string;
  /** Per-page typography extraction, if it succeeded. */
  typography?: PageTypography;
}

/** One sampled text element's computed typography. */
export interface ElementTypeSample {
  /** Role key: h1..h6, p, a, button, code, li, span, ... */
  role: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  color: string;
}

/** Raw typography extracted from one rendered page. */
export interface PageTypography {
  url: string;
  /** font-family string -> occurrence count. */
  families: Record<string, number>;
  /** Per-role samples collected from the page. */
  elements: ElementTypeSample[];
  /** text color (computed) -> occurrence count. */
  textColors: Record<string, number>;
}

/** One row of the aggregated type scale (dominant values for a role). */
export interface TypeScaleRow {
  role: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
}

/** Cross-page aggregation used to render typography.md. */
export interface AggregatedTypography {
  /** Most common body/UI font family, if determinable. */
  bodyFamily?: string;
  /** Most common monospace family (for code), if any. */
  monoFamily?: string;
  /** Families ranked by frequency. */
  families: { family: string; count: number }[];
  /** Type scale: one row per role (h1..h6, body, code, ...). */
  scale: TypeScaleRow[];
  /** Distinct text colors ranked by frequency. */
  textColors: { color: string; count: number }[];
  /** Number of pages that contributed. */
  pageCount: number;
}

/** A site profile: knows how to discover representative pages for a domain. */
export interface Profile {
  name: string;
  /** True if this profile handles the given base URL. */
  matches(url: string): boolean;
  /** Discover page targets (may navigate index pages to find representatives). */
  discover(context: BrowserContext, cfg: RunConfig): Promise<PageTarget[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 0 — capture integrity
// ─────────────────────────────────────────────────────────────────────────────

/** Retry/backoff, politeness, and auth-expiry handling for large live crawls. */
export interface CaptureIntegrityConfig {
  /** Max navigation attempts per page (gotoWithRetry). */
  maxRetries: number;
  /** Per-host politeness delay between navigations (ms). */
  requestDelayMs: number;
  /** Exponential-backoff base on 429/5xx (ms). */
  backoffBaseMs: number;
  /** Detect 401/403/login-redirect mid-crawl. */
  detectAuthExpiry: boolean;
  /** Attempt single-flight re-auth when a session expires mid-crawl. */
  reauth: boolean;
}

export type RouteAuthState = 'authed' | 'anonymous' | 'unknown';

/** Per-route capture outcome recorded in the run manifest. */
export interface RouteCaptureRecord {
  url: string;
  label: string;
  category?: string;
  breakpoint?: string;
  ok: boolean;
  status?: number;
  error?: string;
  authState: RouteAuthState;
  retries?: number;
  /** True if content was truncated / partially captured. */
  truncated?: boolean;
}

/** A machine-readable manifest of what was (and wasn't) captured this run. */
export interface RunManifest {
  site: string;
  startedAtISO: string;
  mode: Mode;
  totals: { captured: number; failed: number; throttled: number; anonymous: number };
  routes: RouteCaptureRecord[];
  notes?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — responsive / visual variants
// ─────────────────────────────────────────────────────────────────────────────

export type ColorScheme = 'light' | 'dark';

/** A named viewport profile to capture. */
export interface Breakpoint {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile?: boolean;
  /** Playwright device descriptor name, when this profile is a device (e.g. 'iPhone 13'). */
  device?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — content & entity extraction
// ─────────────────────────────────────────────────────────────────────────────

/** One extracted row/record from a listing page. */
export interface ListingRow {
  fields: Record<string, string>;
  href?: string;
}

/** Structured listing extraction for one page (a repeated card/row grid). */
export interface ListingExtract {
  page: string;
  pageUrl: string;
  /** Selector of the repeated container/item. */
  container: string;
  rows: ListingRow[];
}

/** A normalized domain entity (model, dataset, org, user, file, …). */
export interface Entity {
  type: string;
  id: string;
  fields: Record<string, unknown>;
  url?: string;
}

/** A directed relationship between two entities. */
export interface EntityRef {
  from: string; // "type/id"
  to: string; // "type/id"
  rel: string; // e.g. "author", "uses-dataset", "in-org"
}

/** The normalized entity/relationship graph — seed data for a stateful twin. */
export interface EntityGraph {
  entities: Entity[];
  relationships: EntityRef[];
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — runnable handoff (scaffold + bundle index)
// ─────────────────────────────────────────────────────────────────────────────

/** All artifacts captured for one route, linked by the bundle index. */
export interface BundleRouteArtifacts {
  route: string;
  label: string;
  category?: string;
  url: string;
  screenshots: string[];
  dom?: string;
  normalizedDom?: string;
  a11yGolden?: string;
  fixtures: string[];
  behaviors: string[];
}

/** Root index of the bundle — the machine-readable spine for a one-shot rebuild. */
export interface BundleIndex {
  site: string;
  generatedFrom: string;
  routes: BundleRouteArtifacts[];
  fixtures: string[];
  mockServer?: string;
  manifest?: string;
  entityGraph?: string;
  scaffold?: string;
}

/** One inferred UI component, mapped to the routes/screenshots it appears in. */
export interface ComponentEntry {
  name: string;
  routes: string[];
  note?: string;
}
