// CLI entry: commander flags + interactive prompts → RunConfig → pipeline.run.
// Also provides the `login` subcommand for interactive session capture.
import path from 'path';
import pc from 'picocolors';
import { Command } from 'commander';
import type { Logger, Mode } from './types';
import { promptForMissing, parsePagesList } from './prompts';
import { buildRunConfig, normalizeBaseUrl } from './config';
import { siteNameFromUrl } from './output/naming';
import { captureLogin } from './auth/login';
import { runA11yDiff } from './a11y/command';
import { runQc } from './qc/command';
import { runVerifyCommand } from './verify/command';
import { runAdd } from './add/command';
import * as pipeline from './pipeline';

interface CaptureOptions {
  mode?: string;
  pages?: string;
  out?: string;
  maxPages?: string;
  depth?: string;
  subLinks?: boolean;
  maxSublinksPerPage?: string;
  concurrency?: string;
  zip: boolean;
  auth?: string;
  basicAuth?: string;
  loginUrl?: string;
  username?: string;
  password?: string;
  userSelector?: string;
  passSelector?: string;
  submitSelector?: string;
  successUrl?: string;
  api?: boolean;
  apiSameOrigin?: boolean;
  apiMaxBody?: string;
  interact: boolean;
  apiSearch?: string;
  extract?: boolean;
  assetsJs?: boolean;
  normalize: boolean;
  deterministic: boolean;
  freezeTime?: string;
  timezone?: string;
  locale?: string;
  mask?: string;
  prompt: boolean;
  promptStack?: string;
  full?: boolean;
  aggressive?: boolean;
  fullDepth?: string;
  maxActions?: string;
  maxActionsPerPage?: string;
  // Phase 0
  maxRetries?: string;
  requestDelay?: string;
  reauth: boolean;
  authExpiry: boolean;
  // Phase 1
  stream: boolean;
  websocket?: boolean;
  statefulMock: boolean;
  redactValues: boolean;
  // Phase 3
  breakpoints?: string;
  dark?: boolean;
  sitemap?: boolean;
  paginate?: boolean;
  // Phase 4
  scaffold?: boolean;
}

interface LoginOptions {
  out?: string;
  mode?: string;
}

/** Parses an integer flag, falling back to `fallback` on NaN/empty. */
function intOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** Validates a mode string, throwing a friendly error otherwise. */
function asMode(value: string | undefined, fallback?: Mode): Mode | undefined {
  if (value === undefined) return fallback;
  const m = value.trim().toLowerCase();
  if (m !== 'web' && m !== 'mobile') {
    throw new Error(`Invalid mode "${value}". Expected "web" or "mobile".`);
  }
  return m;
}

/** Default logger → stdout (human-facing CLI output). */
const stdoutLogger: Logger = { info: (msg: string) => console.log(msg) };

export async function main(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name('screenshotter')
    .description(
      'Capture full-page screenshots of a website plus an extracted typography.md, bundled into a zip.',
    );

  // ── `login` subcommand: interactive session capture ──
  program
    .command('login <url>')
    .description('Open a browser to log in, then save the session for reuse via --auth')
    .option('-o, --out <file>', 'where to save the session JSON (default .auth/<site>.json)')
    .option('-m, --mode <mode>', 'web | mobile', 'web')
    .action(async (url: string, opts: LoginOptions) => {
      const mode = asMode(opts.mode, 'web')!;
      const normalized = normalizeBaseUrl(url);
      const outFile = opts.out ?? path.join('.auth', `${siteNameFromUrl(normalized)}.json`);
      const saved = await captureLogin(normalized, outFile, mode);
      console.log(`Session saved → ${saved}`);
      console.log(`Reuse it with:  screenshotter ${normalized} --auth ${saved}`);
    });

  // ── `a11y-diff` subcommand: accessibility-tree grading gate ──
  program
    .command('a11y-diff <expected> <actual>')
    .description(
      'Grade UI state by comparing accessibility trees. Each side is a URL ' +
        '(captured live) or a saved golden (*.a11y.json / *.aria.yaml). Exits 1 below threshold.',
    )
    .option('-t, --threshold <n>', 'pass threshold 0..1', '0.9')
    .option('--exact', 'require an exact match (score = 1)')
    .option('-m, --mode <mode>', 'web | mobile (for live capture)', 'web')
    .option('--json', 'emit machine-readable JSON')
    .action(
      async (
        expected: string,
        actual: string,
        opts: { threshold?: string; exact?: boolean; mode?: string; json?: boolean },
      ) => {
        const mode = asMode(opts.mode, 'web')!;
        const threshold = Number(opts.threshold);
        const code = await runA11yDiff(expected, actual, {
          threshold: Number.isFinite(threshold) ? threshold : 0.9,
          exact: Boolean(opts.exact),
          mode,
          json: Boolean(opts.json),
        });
        process.exit(code);
      },
    );

  // ── `qc-tasks` subcommand: generate / run functional QC tasks ──
  program
    .command('qc-tasks <bundle>')
    .description(
      'Generate functional QC tasks from a captured bundle. With --run --target, ' +
        'replay them against a rebuilt app and gate (exit 1 on failure).',
    )
    .option('--run', 'execute the tasks against --target')
    .option('-t, --target <url>', 'URL of the app to validate (with --run)')
    .option('--threshold <n>', 'a11y similarity threshold for dom-change checks', '0.9')
    .option('-m, --mode <mode>', 'web | mobile (for --run capture)', 'web')
    .option('--json', 'machine-readable output')
    .action(
      async (
        bundle: string,
        opts: {
          run?: boolean;
          target?: string;
          threshold?: string;
          mode?: string;
          json?: boolean;
        },
      ) => {
        const mode = asMode(opts.mode, 'web')!;
        const t = Number(opts.threshold);
        const code = await runQc(bundle, {
          run: Boolean(opts.run),
          target: opts.target,
          threshold: Number.isFinite(t) ? t : 0.9,
          mode,
          json: Boolean(opts.json),
        });
        process.exit(code);
      },
    );

  // ── `verify` subcommand: score a rebuild against the captured bundle ──
  program
    .command('verify <bundle> <target>')
    .description(
      'Score a rebuilt app against a captured bundle: pixel diff + a11y diff + ' +
        'functional QC → one fidelity score. Exit 1 when below --threshold.',
    )
    .option('--threshold <n>', 'minimum fidelity score to pass (0..1)', '0.9')
    .option('-m, --mode <mode>', 'web | mobile (must match the capture mode)', 'web')
    .option('--mask <selectors>', 'comma-separated CSS selectors to ignore in the pixel diff')
    .option('--max-routes <n>', 'cap routes verified (re-capture is the slow part)')
    .option('--json', 'machine-readable output')
    .action(
      async (
        bundle: string,
        target: string,
        opts: { threshold?: string; mode?: string; mask?: string; maxRoutes?: string; json?: boolean },
      ) => {
        const mode = asMode(opts.mode, 'web')!;
        const t = Number(opts.threshold);
        const code = await runVerifyCommand(bundle, normalizeBaseUrl(target), {
          threshold: Number.isFinite(t) ? t : 0.9,
          mode,
          mask: opts.mask,
          maxRoutes: opts.maxRoutes ? Number(opts.maxRoutes) : undefined,
          json: Boolean(opts.json),
        });
        process.exit(code);
      },
    );

  // ── `add` subcommand: capture specific URL(s) into an existing bundle ──
  program
    .command('add <urls...>')
    .description(
      'Capture specific URL(s) with a logged-in session (--auth) and append them ' +
        'to an existing bundle + zip (no full re-crawl).',
    )
    .option('--into <dir>', 'bundle directory to append to (default output/<site>)')
    .option('-m, --mode <mode>', 'web | mobile', 'web')
    .option('--auth <file>', 'saved session (storageState JSON) from `login`')
    .option('--basic-auth <user:pass>', 'HTTP Basic credentials')
    .option('--login-url <url>', 'form-login page URL')
    .option('--username <user>', 'form-login username (or env)')
    .option('--password <pass>', 'form-login password (or env)')
    .option('--no-api', 'skip API capture for the added page(s)')
    .option('--no-zip', 'do not rebuild the zip')
    .action(
      async (
        urls: string[],
        opts: {
          into?: string;
          mode?: string;
          auth?: string;
          basicAuth?: string;
          loginUrl?: string;
          username?: string;
          password?: string;
          api: boolean;
          zip: boolean;
        },
      ) => {
        const mode = asMode(opts.mode, 'web')!;
        const code = await runAdd(urls, {
          into: opts.into,
          mode,
          authFile: opts.auth,
          basicAuth: opts.basicAuth,
          loginUrl: opts.loginUrl,
          username: opts.username,
          password: opts.password,
          api: opts.api,
          zip: opts.zip,
        });
        process.exit(code);
      },
    );

  // ── default command: capture ──
  program
    .argument('[url]', 'website URL to capture')
    .option('-m, --mode <mode>', 'capture mode: web | mobile')
    .option('-p, --pages <list>', 'comma-separated paths or absolute URLs to capture')
    .option('-o, --out <dir>', 'override output directory')
    .option('--max-pages <n>', 'maximum number of pages to capture (default: 25, or 150 with --sub-links)')
    .option('--depth <n>', 'maximum crawl depth for discovery', '2')
    .option('--sub-links', 'follow same-origin links inside discovered pages and capture them too')
    .option('--max-sublinks-per-page <n>', 'cap links followed per page with --sub-links', '25')
    .option('-c, --concurrency <n>', 'number of pages captured concurrently', '4')
    .option('--no-zip', 'skip producing the final zip')
    // auth
    .option('--auth <file>', 'path to a saved session (storageState JSON) from `screenshotter login`')
    .option('--basic-auth <user:pass>', 'HTTP Basic credentials')
    .option('--login-url <url>', 'login page URL for username/password autofill')
    .option('--username <user>', 'form login username (or env SCREENSHOTTER_USERNAME)')
    .option('--password <pass>', 'form login password (or env SCREENSHOTTER_PASSWORD)')
    .option('--user-selector <sel>', 'override the username field CSS selector')
    .option('--pass-selector <sel>', 'override the password field CSS selector')
    .option('--submit-selector <sel>', 'override the submit button CSS selector')
    .option('--success-url <url>', 'URL/glob to wait for after login (confirms success)')
    // api capture
    .option('--api', 'capture network/API traffic → OpenAPI + endpoint catalog + HAR')
    .option('--api-same-origin', 'only capture API calls to the site\'s own origin/subdomains')
    .option('--api-max-body <kb>', 'per-body size cap in KB for API capture', '256')
    .option('--no-interact', 'with --api, do NOT drive interactions (scroll/search/tabs/pagination)')
    .option('--api-search <term>', 'search term typed during interaction', 'a')
    // extraction (DOM + design tokens + real assets)
    .option('--extract', 'capture rendered DOM + design tokens + real downloaded assets')
    .option('--assets-js', 'with --extract, also save JavaScript bundles')
    .option('--no-normalize', 'with --extract, do NOT emit normalized DOM copies')
    // determinism (default on)
    .option('--no-deterministic', 'disable deterministic capture (clock/locale/timezone/animations)')
    .option('--freeze-time <iso>', 'ISO timestamp to freeze the page clock to')
    .option('--timezone <tz>', 'IANA timezone for capture (default UTC)')
    .option('--locale <loc>', 'locale for capture (default en-US)')
    .option('--mask <selectors>', 'comma-separated CSS selectors to black out in screenshots')
    // rebuild prompt (give-the-zip-to-Claude spec)
    .option('--no-prompt', 'do NOT generate REBUILD-PROMPT.md in the bundle')
    .option('--prompt-stack <name>', 'target stack hint for the rebuild prompt (e.g. react+tailwind)')
    // full interaction explorer
    .option('--full', 'exhaustively click through the app: record + screenshot every state')
    .option('--aggressive', 'with --full: click ~everything incl. form submits/mutations (DANGEROUS)')
    .option('--full-depth <n>', 'max recursion depth for --full', '2')
    .option('--max-actions <n>', 'global cap on recorded actions for --full', '500')
    .option('--max-actions-per-page <n>', 'per-page action cap for --full', '40')
    // Phase 0 — capture integrity
    .option('--max-retries <n>', 'navigation retry attempts per page', '3')
    .option('--request-delay <ms>', 'per-host politeness delay between navigations (ms)', '0')
    .option('--no-reauth', 'do NOT re-authenticate when a session expires mid-crawl')
    .option('--no-auth-expiry', 'do NOT detect 401/403/login-redirect mid-crawl')
    // Phase 1 — dynamic data contract
    .option('--no-stream', 'with --api, do NOT capture SSE/streaming responses')
    .option('--websocket', 'with --api, capture WebSocket frames into the contract')
    .option('--no-stateful-mock', 'with --api, generate a static (non-stateful) mock')
    .option('--no-redact-values', 'do NOT redact secret-shaped VALUES (only key names)')
    // Phase 3 — responsive / visual variants
    .option('--breakpoints <list>', 'comma-separated breakpoints to capture (mobile,tablet,desktop,wide)')
    .option('--dark', 'also capture a dark color-scheme pass')
    .option('--sitemap', 'ingest sitemap.xml / robots.txt to seed discovery')
    .option('--paginate', 'mint pagination / load-more targets during discovery')
    // Phase 4 — runnable handoff (default on with --extract/--full)
    .option('--no-scaffold', 'do NOT emit the frontend scaffold + bundle index')
    .allowExcessArguments(false)
    .action(async (urlArg: string | undefined, options: CaptureOptions) => {
      const modeInput = asMode(options.mode);

      // Fill missing url/mode/pages interactively when possible.
      const filled = await promptForMissing({
        url: urlArg,
        mode: modeInput,
        pages: parsePagesList(options.pages),
      });

      const cfg = buildRunConfig({
        url: filled.url,
        mode: filled.mode,
        pages: filled.pages,
        out: options.out,
        // Leave undefined when not passed so the flag-dependent default applies
        // (25 normally, 150 with --sub-links).
        maxPages: options.maxPages !== undefined ? intOr(options.maxPages, 25) : undefined,
        depth: intOr(options.depth, 2),
        subLinks: options.subLinks ?? false,
        maxSubLinksPerPage: intOr(options.maxSublinksPerPage, 25),
        concurrency: intOr(options.concurrency, 4),
        zip: options.zip,
        authFile: options.auth,
        basicAuth: options.basicAuth,
        loginUrl: options.loginUrl,
        username: options.username,
        password: options.password,
        usernameSelector: options.userSelector,
        passwordSelector: options.passSelector,
        submitSelector: options.submitSelector,
        successUrl: options.successUrl,
        api: options.api,
        apiSameOrigin: options.apiSameOrigin,
        apiMaxBodyKb: options.apiMaxBody ? intOr(options.apiMaxBody, 256) : undefined,
        apiInteract: options.interact,
        apiSearch: options.apiSearch,
        extract: options.extract,
        assetsJs: options.assetsJs,
        normalize: options.normalize,
        deterministic: options.deterministic,
        freezeTime: options.freezeTime,
        timezone: options.timezone,
        locale: options.locale,
        mask: options.mask,
        prompt: options.prompt,
        promptStack: options.promptStack,
        full: options.full,
        aggressive: options.aggressive,
        fullDepth: options.fullDepth ? intOr(options.fullDepth, 2) : undefined,
        maxActions: options.maxActions ? intOr(options.maxActions, 500) : undefined,
        maxActionsPerPage: options.maxActionsPerPage
          ? intOr(options.maxActionsPerPage, 40)
          : undefined,
        // Phase 0
        maxRetries: options.maxRetries ? intOr(options.maxRetries, 3) : undefined,
        requestDelayMs: options.requestDelay ? intOr(options.requestDelay, 0) : undefined,
        reauth: options.reauth,
        detectAuthExpiry: options.authExpiry,
        // Phase 1
        captureStream: options.stream,
        captureWebsocket: options.websocket,
        stateful: options.statefulMock,
        redactValueShapes: options.redactValues,
        // Phase 3
        breakpoints: options.breakpoints,
        dark: options.dark,
        sitemap: options.sitemap,
        paginate: options.paginate,
        // Phase 4 — only force OFF explicitly; otherwise config defaults it on with extract/full.
        scaffold: options.scaffold === false ? false : undefined,
      });

      // Loud warning when aggressive exploration is enabled (it mutates real data).
      if (cfg.explore?.enabled && cfg.explore.aggressive) {
        const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(
          (() => {
            try {
              return new URL(cfg.url).hostname;
            } catch {
              return '';
            }
          })(),
        );
        console.error(
          pc.bold(pc.red('\n⚠  AGGRESSIVE --full: will click EVERYTHING incl. form ')) +
            pc.bold(pc.red('submits and data mutations (skips only logout/payment).')),
        );
        if (!local) {
          console.error(
            pc.yellow(
              '   Target is NOT localhost — this can permanently change real data. ' +
                'Use only on apps you own / staging.',
            ),
          );
        }
      }

      await pipeline.run(cfg, stdoutLogger);
    });

  await program.parseAsync(argv);
}
