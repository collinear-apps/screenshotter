// Generates REBUILD-PROMPT.md — a self-contained spec placed at the root of the
// capture bundle. Hand the whole zip (this file + screenshots + DOM + tokens +
// real assets + OpenAPI) to Claude to one-shot a faithful rebuild. All paths in
// the prompt are RELATIVE TO THIS FILE (the <mode>/ dir), matching the zip layout.
import type { ApiSummary, DesignTokens, Mode, TokenValue } from '../types';

export interface PromptPageInfo {
  label: string;
  url: string;
  category?: string;
  /** Path to the screenshot, relative to the bundle root (this file's dir). */
  screenshot: string;
  /** Path to the rendered DOM dump, relative to the bundle root (if captured). */
  dom?: string;
}

export interface PromptInput {
  siteName: string;
  url: string;
  mode: Mode;
  viewport: string;
  pages: PromptPageInfo[];
  tokens?: DesignTokens;
  hasTypography: boolean;
  apiSummary?: ApiSummary;
  apiHosts?: string[];
  assetCount?: number;
  domCount: number;
  /** Optional target-stack hint. */
  stack?: string;
  /** Optional pre-rendered "Behaviors / interactions" markdown (from --full). */
  behaviors?: string;
  /** Number of API fixtures emitted (api/fixtures/) — a runnable mock exists if > 0. */
  fixtures?: number;
  /** Number of functional QC tasks emitted (qc/qc-tasks.*). */
  qcTasks?: number;
  /** Phase 4 — true when a runnable scaffold was emitted (scaffold/). */
  hasScaffold?: boolean;
  /** Phase 4 — true when bundle.json (the machine-readable spine) exists. */
  hasBundleIndex?: boolean;
  /** Phase 4 — the local mock base the scaffold/.env points at. */
  mockBase?: string;
}

/** "value (count)" list, capped, as markdown bullets. */
function bullets(values: TokenValue[] | undefined, cap: number): string {
  if (!values || values.length === 0) return '_none captured_';
  return values
    .slice(0, cap)
    .map((v) => `- \`${v.value}\` (${v.count})`)
    .join('\n');
}

export function renderRebuildPrompt(input: PromptInput): string {
  const {
    siteName,
    url,
    mode,
    viewport,
    pages,
    tokens,
    hasTypography,
    apiSummary,
    apiHosts,
    assetCount,
    domCount,
    stack,
    behaviors,
    fixtures,
    qcTasks,
    hasScaffold,
    hasBundleIndex,
    mockBase,
  } = input;

  const hasAssets = (assetCount ?? 0) > 0;
  const hasDom = domCount > 0;
  const hasApi = Boolean(apiSummary && apiSummary.calls > 0);
  const hasMock = (fixtures ?? 0) > 0;
  const hasQc = (qcTasks ?? 0) > 0;
  const MOCK_BASE = mockBase ?? 'http://localhost:8787';
  const hosts = apiHosts ?? apiSummary?.hosts ?? [];
  const stackLine = stack
    ? `Build it with **${stack}**.`
    : 'Use a modern stack (React + Tailwind is a good default; plain HTML/CSS is fine if simpler). Map the design tokens to CSS variables / the Tailwind theme.';

  const L: string[] = [];

  L.push(`# Rebuild prompt — ${siteName}`);
  L.push('');
  L.push(
    `You are a senior frontend engineer. Using ONLY the real artifacts in this ` +
      `bundle, rebuild **${siteName}** (${url}) as a faithful, production-quality ` +
      `front end. This file sits at the root of the capture; **every path below is ` +
      `relative to this file**. Captured at: **${viewport}**.`,
  );
  L.push('');
  L.push(
    `> This bundle was produced by \`screenshotter\`. It contains the rendered ` +
      `pixels, the real DOM, the actual brand assets (fonts/SVG/images/CSS), the ` +
      `computed design tokens, and the observed API. **Match these — do not ` +
      `reverse-engineer or invent substitutes.**`,
  );
  L.push('');

  // ── What's in the bundle ──
  L.push('## What is in this bundle');
  L.push('');
  L.push('| Artifact | Where | Use it for |');
  L.push('|----------|-------|------------|');
  L.push('| Screenshots (full-page PNG) | `<category>/NN-*.png` | the visual target to match |');
  if (hasDom) {
    L.push('| Rendered DOM | `<category>/NN-*.html` | exact structure, classes, copy |');
    L.push('| Normalized DOM | `<category>/NN-*.normalized.html` | diff-stable structure (dynamic values placeholdered) |');
    L.push('| Accessibility goldens | `<category>/NN-*.aria.yaml` / `.a11y.json` | the target UI state — grade your rebuild with `screenshotter a11y-diff` |');
  }
  if (hasTypography) L.push('| Typography report | `typography.md` | font families + type scale |');
  if (tokens) {
    L.push('| Design tokens (machine-readable) | `design-tokens.json` | exact colors/spacing/radii/shadows/fonts |');
    L.push('| Design tokens (readable) | `design-tokens.md` | the same, human-friendly |');
  }
  if (hasAssets) {
    L.push('| Real assets | `assets/{fonts,images,svg,css}/` | the ACTUAL downloaded files |');
    L.push('| Asset manifest | `assets/manifest.json` | url → file mapping + content-types |');
  }
  if (hasApi) {
    L.push('| OpenAPI specs | `api/openapi/<host>.json` | inferred endpoints + schemas |');
    L.push('| Endpoint catalog | `api/api-endpoints.md` | readable API list + samples |');
    L.push('| Network HAR | `api/network.har` | full request/response records (redacted) |');
  }
  if (hasMock) {
    L.push('| API fixtures | `api/fixtures/*.json` | the real recorded responses, as importable seed data |');
    L.push('| **Runnable mock API** | `api/mock/server.mjs` | `node server.mjs` → serves the fixtures offline (CORS). Your data layer. |');
  }
  if (behaviors && behaviors.trim()) {
    L.push('| Behavior contract | `explore/behaviors.json` | machine-readable features (what each control does) + routes |');
  }
  if (hasQc) {
    L.push('| Functional QC tasks | `qc/qc-tasks.md` / `.json` | the features + DATA-FIDELITY checks your rebuild must pass |');
  }
  if (hasBundleIndex) {
    L.push('| **Bundle index** | `bundle.json` / `index.md` | the machine-readable spine: every route → its screenshot/DOM/a11y/fixtures/behaviors. START HERE. |');
  }
  if (hasScaffold) {
    L.push('| **Runnable scaffold** | `scaffold/` | a Vite+React+TS skeleton already wired to the mock (routes, tokens.css, apiClient, .env, hosts.json) — `cd scaffold && npm i && npm run dev` |');
  }
  L.push('');

  // ── Hard requirements ── (functionality AND fidelity are BOTH acceptance gates)
  L.push('## Non-negotiable requirements');
  L.push('');
  L.push(
    'This rebuild is judged on **function as much as looks**. A pixel-perfect UI ' +
      'with dead buttons is a FAIL. Two equal acceptance gates:',
  );
  L.push('');
  L.push('**A. Functionality**');
  if (hasMock) {
    L.push('- **Run the mock API** (`cd api/mock && node server.mjs`) and point your app at it (it serves the real recorded responses with CORS). Do NOT stub data inline — use the fixtures.');
  } else if (hasApi) {
    L.push('- **Wire data to the observed API** (`api/openapi/`, `api/fixtures/`). Build a typed client + a mock seeded from the fixtures so the UI renders offline.');
  }
  if (behaviors && behaviors.trim()) {
    L.push('- **Implement every behavior** in `explore/behaviors.json` (modals, search, tabs, filters, downloads — see the Behaviors section). These are the features.');
  }
  if (hasQc) {
    L.push('- **Pass the QC tasks** in `qc/qc-tasks.md`. Validate with `screenshotter qc-tasks <bundle> --run --target <your-dev-url>` — it must report all passing.');
  }
  L.push('');
  L.push('**B. Fidelity**');
  L.push('- **Match the screenshots** at the captured viewport (per-route visual target).');
  if (hasAssets) {
    L.push('- **Use the real fonts/SVGs/images** from `assets/` (self-hosted; no CDN substitutes); `assets/manifest.json` maps files to URLs.');
  }
  if (tokens) {
    L.push('- **Apply the design tokens exactly** (`design-tokens.json`) as CSS variables/theme — don\'t eyeball colors.');
  }
  if (hasDom) {
    L.push('- **Mirror the DOM** (`*.html`) for structure, semantics, and exact copy (`*.normalized.html` is diff-stable); match the a11y goldens (`*.aria.yaml`).');
  }
  L.push('');

  // ── Design system ──
  if (tokens) {
    L.push('## Design system (from real computed styles)');
    L.push('');
    L.push(`_Aggregated across ${tokens.pageCount} page(s). Full data in \`design-tokens.json\`._`);
    L.push('');
    L.push('### Font families');
    L.push(bullets(tokens.fontFamilies, 8));
    L.push('');
    L.push('### Type scale (font sizes)');
    L.push(bullets(tokens.fontSizes, 12));
    L.push('');
    L.push('### Colors (text)');
    L.push(bullets(tokens.colors, 16));
    L.push('');
    L.push('### Backgrounds');
    L.push(bullets(tokens.backgrounds, 12));
    L.push('');
    L.push('### Spacing scale');
    L.push(bullets(tokens.spacing, 12));
    L.push('');
    L.push('### Border radii');
    L.push(bullets(tokens.radii, 8));
    L.push('');
    L.push('### Shadows');
    L.push(bullets(tokens.shadows, 8));
    L.push('');
  }

  // ── Pages ──
  L.push('## Pages / routes to build');
  L.push('');
  L.push('| # | Page | Route (suggested) | Screenshot | DOM |');
  L.push('|---|------|-------------------|-----------|-----|');
  pages.forEach((p, i) => {
    let route = '/';
    try {
      route = new URL(p.url).pathname || '/';
    } catch {
      /* keep default */
    }
    L.push(
      `| ${i + 1} | ${p.label}${p.category ? ` (${p.category})` : ''} | \`${route}\` | \`${p.screenshot}\` | ${p.dom ? `\`${p.dom}\`` : '—'} |`,
    );
  });
  L.push('');

  // ── DATA WIRING (explicit: base URL + per-host map + run-the-mock steps) ──
  if (hasApi || hasMock) {
    L.push('## Data wiring (READ THIS — do not invent data)');
    L.push('');
    if (hasApi) {
      L.push(
        `Observed **${apiSummary!.calls} call(s)** across **${apiSummary!.endpoints} endpoint(s)** on host(s): ` +
          `${hosts.map((h) => `\`${h}\``).join(', ')}.`,
      );
      L.push('');
    }
    L.push('All upstream hosts are served by ONE local mock. Wire your app to it via a single base URL:');
    L.push('');
    L.push('```');
    L.push(`API_BASE_URL=${MOCK_BASE}   # see scaffold/.env.example (VITE_API_BASE_URL)`);
    L.push('```');
    L.push('');
    if (hosts.length > 0) {
      L.push('**Per-host map** — every captured host rewrites to the mock base (see `scaffold/hosts.json`):');
      L.push('');
      L.push('| Upstream host | Mock base |');
      L.push('|---------------|-----------|');
      for (const h of hosts) L.push(`| \`${h}\` | \`${MOCK_BASE}\` |`);
      L.push('');
      L.push('Your API client must resolve a request\'s upstream host to the mock base via this map (a multi-host app like huggingface.co + api-inference.* + datasets-server.* otherwise breaks).');
      L.push('');
    }
    if (hasMock) {
      L.push('**Run the mock** (serves the real recorded responses with CORS):');
      L.push('');
      L.push('```');
      L.push('cd api/mock && node server.mjs       # listens on ' + MOCK_BASE);
      L.push('```');
      L.push('');
      L.push('Seed/fixture data lives in `api/fixtures/*.json`. Do NOT stub data inline — import or serve these. Build a typed client + map every UI list/detail to a fixture (see `bundle.json` for the route → fixtures linkage).');
    } else if (hasApi) {
      L.push('Build the data layer from `api/openapi/<host>.json` (schemas) + `api/api-endpoints.md` (samples). Generate a typed client and seed it from the recorded examples so the UI renders offline.');
    }
    L.push('');
    L.push('Secrets in the HAR/fixtures are already redacted to `<REDACTED_*>` placeholders. Treat any `<REDACTED_*>` token as an environment variable (e.g. `<REDACTED_API_KEY>` → read `process.env.API_KEY` / `import.meta.env.VITE_API_KEY`). Never hard-code a placeholder as a literal value.');
    L.push('');
  }

  // ── Behaviors (from --full exploration) ──
  if (behaviors && behaviors.trim()) {
    L.push('## Behaviors / interactions');
    L.push('');
    L.push(
      'Recorded by clicking through the app (`--full`). Implement these flows — ' +
        'they are the real features. Result-state screenshots and per-action details ' +
        'live in `explore/`.',
    );
    L.push('');
    L.push(behaviors.trim());
    L.push('');
  }

  // ── Ordered build procedure ──
  L.push('## Build procedure (in this order)');
  L.push('');
  let step = 1;
  if (hasScaffold) {
    L.push(`${step++}. **Start from the scaffold.** \`cd scaffold && npm install\`, then \`cp .env.example .env\`. It already enumerates every route (\`src/routes.ts\`), the design tokens (\`src/tokens.css\`), the API client (\`src/apiClient.ts\`), and the per-host map (\`hosts.json\`).`);
  } else {
    L.push(`${step++}. **Initialize the project.** ${stackLine} Set \`API_BASE_URL=${MOCK_BASE}\` in an \`.env\`.`);
  }
  if (hasMock) {
    L.push(`${step++}. **Run the mock API.** \`cd api/mock && node server.mjs\` (serves \`${MOCK_BASE}\`). Keep it running.`);
  }
  if (hasBundleIndex) {
    L.push(`${step++}. **Implement routes from \`bundle.json\`.** For each route entry, build the page to match its \`screenshot\`/\`dom\`, and render data from its linked \`fixtures\`.`);
  } else {
    L.push(`${step++}. **Implement each route** in the Pages table above, matching its screenshot + DOM.`);
  }
  if (hasApi || hasMock) {
    L.push(`${step++}. **Wire data.** Point the API client at \`API_BASE_URL\`; resolve every upstream host through the per-host map. Render real records — no inline stubs, no lorem-ipsum.`);
  }
  if (behaviors && behaviors.trim()) {
    L.push(`${step++}. **Implement behaviors** from \`explore/behaviors.json\` (search/filter/tabs/modals/downloads).`);
  }
  L.push(`${step++}. **Run the gates** (see "Verify" below) and fix until green.`);
  L.push('');
  L.push('Guidance:');
  L.push('- Componentize by repeated sections (header, nav, cards, footer) inferred from the DOM.');
  L.push('- Screenshots are full-page; build responsive but make the captured viewport pixel-faithful first.');
  if (hasAssets) L.push('- Self-host every asset from `assets/` — no external CDNs.');
  L.push('- Keep copy/text verbatim from the DOM.');
  L.push('');

  // ── Verify (single script: qc-tasks + a11y-diff) ──
  if (hasQc || hasDom) {
    L.push('## Verify (run before declaring done)');
    L.push('');
    L.push('One pass over both functional + structural gates against your running dev server:');
    L.push('');
    L.push('```sh');
    L.push('# 1. Functional + DATA-FIDELITY gate — every QC task must pass.');
    if (hasQc) {
      L.push(`screenshotter qc-tasks . --run --target <your-dev-url>`);
    }
    if (hasDom) {
      L.push('# 2. Structural gate — each route\'s a11y tree must match its golden.');
      L.push('for g in **/*.aria.yaml; do screenshotter a11y-diff "$g" <your-dev-url>; done');
    }
    L.push('```');
    L.push('');
    L.push('The QC gate includes **data-fidelity** checks: captured field values (from `api/fixtures/`) must actually render — a route that loads but shows placeholder/empty data is a FAIL. It also checks **coverage**: every route renders and listings show at least the captured row count.');
    L.push('');
  }

  // ── Definition of done ──
  L.push('## Definition of done');
  L.push('');
  L.push('- [ ] Every route above renders and visually matches its screenshot at the captured viewport.');
  if (tokens) L.push('- [ ] Colors, fonts, spacing, radii, and shadows match the tokens (no eyeballed values).');
  if (hasAssets) L.push('- [ ] Real fonts/SVGs/images are used and self-hosted.');
  if (hasApi) L.push('- [ ] Data is wired to the API shapes with working fixtures.');
  if (hasMock || hasApi) L.push('- [ ] **Real captured values render** (data-fidelity QC tasks pass — no placeholder/empty data).');
  if (hasQc) L.push('- [ ] Every route renders and listings show at least the captured row count (coverage tasks pass).');
  if (behaviors && behaviors.trim()) {
    L.push('- [ ] The recorded behaviors/interactions work (no dead buttons or stubs).');
  }
  if (hasDom) {
    L.push('- [ ] Each route\'s accessibility tree matches the golden — `screenshotter a11y-diff <golden>.aria.yaml <your-url>` passes.');
  }
  L.push('- [ ] No placeholder lorem-ipsum where real copy exists in the DOM.');
  L.push('');

  return L.join('\n');
}
