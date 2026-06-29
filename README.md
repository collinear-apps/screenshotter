# screenshotter

A reusable CLI that crawls a website, captures **high-quality full-page screenshots**,
extracts an auto-generated **`typography.md`** design snapshot, and bundles everything
into `<sitename>-screenshots.zip`.

Works on any site. Ships with a built-in **HuggingFace** profile that captures
representative pages across Models, Datasets, Spaces, Leaderboards, Organizations,
and Profiles; unknown sites fall back to a bounded same-domain crawl.

> 📖 **New here? See [USAGE.md](./USAGE.md)** — task-oriented walkthroughs for
> capturing, authenticating, capturing API specs, and using it from Claude Code.

## Install

Requires Node ≥ 18. Installing builds the TS and (best-effort) downloads the
Chromium that Playwright drives — no separate build step needed.

**As a global `screenshotter` command** — straight from GitHub:

```bash
npm install -g github:collinear-apps/screenshotter
screenshotter --help
```

…or from a clone:

```bash
git clone https://github.com/collinear-apps/screenshotter && cd screenshotter
npm install            # builds dist/ (prepare) + fetches Chromium (postinstall)
npm link               # puts `screenshotter` on your PATH  (npm unlink -g screenshotter to remove)
screenshotter --help
```

**Without a global command** — run it in-repo (identical):

```bash
git clone https://github.com/collinear-apps/screenshotter && cd screenshotter
npm install
node dist/index.js --help
```

> **Chromium:** `npm install` auto-downloads it. If that's skipped (offline/CI), it
> prints a warning — finish with `npx playwright install chromium` (or `npm run setup`).

> **As a Claude Code plugin:** this repo also ships `.mcp.json` + `.claude-plugin/`, so
> the same package works as the `/screenshot` command / MCP tool inside Claude Code.

See all commands with `screenshotter --help`, a subcommand's flags with
`screenshotter <command> --help`, or the [Commands](#commands) section below.

## Usage

Interactive (asks for URL, mode, and optional pages):

```bash
node dist/index.js
```

Non-interactive with flags:

```bash
node dist/index.js https://huggingface.co --mode web
node dist/index.js https://example.com --mode mobile --max-pages 10
node dist/index.js https://example.com -p "/,/about,/pricing"   # explicit pages
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `[url]` | — | Website URL (positional; prompted if omitted) |
| `-m, --mode <web\|mobile>` | `web` | Desktop (1440×900 @2×) or mobile (iPhone 13) |
| `-p, --pages <list>` | — | Comma-separated paths/URLs; skips auto-discovery |
| `-o, --out <dir>` | `output/<site>` | Output directory |
| `--max-pages <n>` | `25` (`150` with `--sub-links`) | Max pages to capture |
| `--depth <n>` | `2` | Max crawl depth (generic crawler / sub-link hops) |
| `--sub-links` | off | Also follow + capture same-origin links *inside* discovered pages |
| `--max-sublinks-per-page <n>` | `25` | Cap on links followed per page with `--sub-links` |
| `-c, --concurrency <n>` | `4` | Pages captured in parallel |
| `--no-zip` | — | Skip producing the zip |

> After a global install (`npm link` or `npm i -g screenshotter`) the binary is
> `screenshotter`; in-repo it's `node dist/index.js`. Both are interchangeable below.

## Commands

`screenshotter` is one binary with several subcommands. The default (no subcommand)
captures a site; the others support gated sites, grading rebuilds, and appending.

| Command | What it does |
|---------|--------------|
| `screenshotter [url] [flags]` | **Capture** a site → screenshots + `typography.md` (+ extras) → zip |
| `screenshotter login <url>` | Open a browser, log in, **save the session** to `.auth/<site>.json` for `--auth` |
| `screenshotter add <urls...> [--into <dir>] [--auth <f>]` | Capture one or more URLs and **append** them to an existing bundle (no full re-crawl) |
| `screenshotter a11y-diff <expected> <actual> [--threshold]` | **Grade a rebuild's UI state** by comparing accessibility trees (golden vs. live URL) |
| `screenshotter qc-tasks <bundle> [--run --target <url>]` | Generate **functional QC tasks** from a bundle; with `--run`, execute them against a rebuild and exit non-zero on failure |
| `screenshotter verify <bundle> <target> [--threshold]` | **Fidelity gate** — re-captures the rebuild and scores it vs the bundle: pixel diff + a11y diff + functional QC → one score; exit 1 if any route is below threshold |

### Capability flags (compose freely on the capture command)

| Flag | Adds |
|------|------|
| `--extract` | Real assets (fonts/images/CSS/JS) + rendered DOM + design tokens + a11y goldens + CSS vars + listings + entity graph |
| `--a11y` | Capture **only** accessibility goldens (`.aria.yaml` / `.a11y.json`) — skips DOM/tokens/assets (fast, lean) |
| `--api` | Network capture → inferred OpenAPI + endpoint catalog + HAR + **query/body-aware, stateful mock server** |
| `--full` | Recursively click/record/screenshot every state (menus, modals, forms); writes `behaviors.json` |
| `--aggressive` | With `--full`: also submit forms / mutate data (**DANGEROUS** — own/staging sites only) |
| `--sub-links` | Follow same-origin links inside discovered pages (page budget → 150) |
| `--sitemap` / `--paginate` | Seed discovery from `sitemap.xml`/`robots.txt`; mint pagination targets |
| `--breakpoints <list>` | Capture a viewport matrix, e.g. `mobile,tablet,desktop,wide` |
| `--dark` | Also capture a dark color-scheme pass |
| `--auth <file>` | Use a saved session from `login` (capture gated pages) |
| `--scaffold` / `--no-scaffold` | Emit (or skip) a runnable rebuild scaffold + `bundle.json` index (on by default with `--extract`/`--full`) |
| `--max-retries`,`--request-delay` | Capture-integrity: retry/backoff + per-host politeness for large crawls |

### Common command recipes

```bash
# 1. Plain: screenshots + typography
screenshotter https://example.com

# 2. The works (safe): explore + real assets + API + sub-links
screenshotter https://example.com --full --extract --api --sub-links

# 3. Maximal fidelity: + responsive matrix + dark + deeper crawl
screenshotter https://example.com --full --extract --api --sub-links \
  --breakpoints mobile,tablet,desktop,wide --dark --sitemap --paginate --max-pages 150

# 4. Gated site: save a session once, then capture authenticated
screenshotter login https://app.example.com
screenshotter https://app.example.com --full --extract --api --auth .auth/app.json

# 5. Append a single (logged-in) page to an existing bundle
screenshotter add https://app.example.com/settings/billing --into output/app --auth .auth/app.json

# 6. Run the generated mock backend, then grade a rebuild functionally
node output/example/web/api/mock/server.mjs &           # query-aware, stateful mock on :8787
screenshotter qc-tasks output/example --run --target http://localhost:3000   # data-fidelity gate

# 7. Grade a rebuilt UI state against an accessibility golden
screenshotter a11y-diff output/example/web/home.aria.yaml http://localhost:3000 --threshold 0.9

# 8. Closed-loop fidelity gate — re-capture the rebuild and score it vs the bundle
#    (pixel diff + a11y diff + functional QC → one score; writes verify-report.json)
screenshotter verify output/example http://localhost:3000 --threshold 0.9
```

### The fidelity gate (`verify`)

`verify <bundle> <target>` is the closed verification loop: it re-captures every route
of your rebuild with the same deterministic context, then scores it three ways —
**visual** (perceptual pixel diff vs the captured screenshot), **structural**
(accessibility-tree similarity vs the `.aria.yaml` golden), and **functional** (the
generated QC tasks). It writes `verify-report.json` + per-route diff PNGs under
`verify/`, prints a ranked scorecard, and **exits 1 if any route is below
`--threshold`** — so a coding agent can loop "rebuild → verify → fix the worst routes"
until it passes. (Pixel diff compares the shared top-left region; it's strongest on
content-dense pages, with the a11y score covering structural changes pixels can miss.)

### Via `make` (convenience task runner)

```bash
make full URL=https://example.com                       # explore + extract + api
make full URL=https://example.com SUBLINKS=1 AUTH=.auth/example.json
make login URL=https://app.example.com                  # save a session
make add   URL=<pasted-url> INTO=output/example AUTH=.auth/example.json
make qc    BUNDLE=output/example TARGET=http://localhost:3000
make a11y-diff EXPECTED=golden.aria.yaml ACTUAL=http://localhost:3000
make help                                               # list all targets
```

## Output

```
<sitename>-screenshots.zip
└── <mode>/
    ├── <category>/NN-<slug>.png   # screenshots clustered by category
    ├── ...
    └── typography.md              # extracted font families, type scale, colors
```

- **web** screenshots are 2× retina (e.g. 2880px wide); **mobile** uses the iPhone 13 device profile.
- Screenshots are full-page, captured after dismissing cookie banners, auto-scrolling
  lazy content, and waiting for fonts + network to settle.
- `typography.md` aggregates computed styles across all captured pages.

## How discovery works

1. If `--pages` is provided → capture exactly those.
2. Else the first matching **site profile** runs (e.g. HuggingFace).
3. Else a **bounded same-domain BFS crawl** discovers pages (respecting `--max-pages`/`--depth`),
   clustering them by first path segment.

### `--sub-links` (follow links inside discovered pages)

Site profiles (and `--pages`) return a fixed seed set — they don't follow the links
*inside* those pages. `--sub-links` adds a bounded multi-source BFS that does: from
every seed it follows same-origin links up to `--depth` hops, capped at
`--max-sublinks-per-page` per page and a `--max-pages` default of **150**. Sub-pages
inherit their parent's category (so links off the Models index cluster under
`Models`) and get the **same treatment as seeds** — whatever `--extract`/`--api`/`--full`
flags you pass apply to them too. The generic crawler already follows links, so
`--sub-links` there just raises the page budget. Example:

```
node dist/index.js https://huggingface.co --sub-links --extract   # ~150 pages
```

### Adding a site profile

Implement the `Profile` interface (see `src/types.ts`) and register it in
`src/discovery/index.ts` ahead of the generic fallback. See
`src/discovery/profiles/huggingface.ts` for a working example that navigates index
pages to discover representative detail pages dynamically.

## Project layout

```
src/
  cli.ts / prompts.ts / pipeline.ts   # CLI + orchestration
  capture/    browser, prepare (waits/banners/scroll), screenshot
  discovery/  index, crawler, profiles/{huggingface,generic}
  typography/ extract (in-page), aggregate, report (markdown)
  output/     naming (slugs/clustering), zip
  types.ts    shared contracts
```

## Authenticated / gated sites

Some sites require a login before their pages render. screenshotter supports three
auth methods, all usable from the CLI and the MCP tool.

### Saved session (recommended for SSO / interactive logins)

Open a real browser, log in by hand, then reuse the saved session:

```bash
# 1. Opens a browser window. Log in, then return to the terminal and press Enter.
#    The session (cookies + localStorage) is saved as a Playwright storageState JSON.
screenshotter login https://app.example.com --out .auth/example.json --mode web

# 2. Capture using the saved session.
screenshotter https://app.example.com --auth .auth/example.json
```

`--out` defaults to a path under `.auth/`; `--mode web|mobile` matches the device
profile you'll capture with.

#### OAuth / SSO / passwordless logins (no email + password field)

Many apps only offer **"Continue with Google / GitHub / SSO"** (or magic links) — there
is no username/password form to autofill, so `--basic-auth` and form login below do
**not** apply. The saved-session flow above is exactly the answer: run `login`, click
the provider button in the browser it opens, complete the provider flow (2FA / captcha
included), press Enter, and capture with `--auth`.

```bash
screenshotter login https://api.together.ai      # click "Continue with Google/GitHub/SSO", finish, press Enter
screenshotter https://api.together.ai --full --extract --api --auth .auth/together.json
```

It doesn't matter which provider is used — `login` persists the app's resulting
session *after* the redirect. **Popup-based OAuth works too**: the provider popup
shares the browser context, so its cookies and the app's post-login token both land in
the saved session. Two caveats:

- **Expiry** — OAuth/SSO sessions are often short-lived, and auto re-auth (`--reauth`)
  only works for *form* login (it has the credentials); it can't replay an OAuth click.
  So for a long crawl, run `login` right before launching, and re-run it if
  `run-manifest.json` reports `anonymous` routes.
- `.auth/*.json` is a live credential — it's gitignored; never commit or share it.

### HTTP Basic auth

```bash
screenshotter https://staging.example.com --basic-auth user:pass
```

### Form login (username/password)

screenshotter can autofill and submit a login form before capturing:

```bash
screenshotter https://app.example.com \
  --login-url https://app.example.com/login \
  --username "$USER" --password "$PASS"
```

Credentials may also come from the environment via `SCREENSHOTTER_USERNAME` and
`SCREENSHOTTER_PASSWORD` (preferred over passing passwords on the command line).
The username/password fields and submit button are autodetected; override them
when needed with `--user-selector`, `--pass-selector`, and `--submit-selector`,
and use `--success-url <url>` to wait for a post-login URL that confirms success.

### Security note

`.auth/` is gitignored. Saved `storageState` files are **session secrets** —
treat them like passwords, don't commit them, and rotate them when they expire.
Prefer environment variables (`SCREENSHOTTER_USERNAME` / `SCREENSHOTTER_PASSWORD`)
over passing passwords as CLI flags, which can leak via shell history and process
listings.

## Use as a Claude Code plugin

screenshotter ships as a Claude Code plugin with a bundled MCP server, so Claude
can capture screenshots for you directly.

### 1. Build first

```bash
npm install && npm run build && npx playwright install chromium
```

The MCP server runs from `dist/mcp/server.js`, so a build is required before the
plugin will work (and after any source change).

### 2. Load the plugin locally

```bash
claude --plugin-dir /Users/amit/Documents/codebase/screenshotter
```

After rebuilding (`npm run build`), run `/reload-plugins` inside Claude Code to
pick up the new `dist/`.

### 3. Slash command

```
/screenshotter:screenshot https://huggingface.co web
```

Arguments are `<url> [web|mobile] [maxPages]` (mode defaults to `web`, maxPages to
`25`).

### 4. MCP tool

The plugin exposes a single tool, `capture_website`, that Claude can call
directly. Parameters: `url` (required), `mode` (`web`/`mobile`), `pages`,
`maxPages`, `depth`, `concurrency`, `zip`, `authFile` (a saved storageState JSON
from `screenshotter login`), and `out`. It returns the generated zip path, the
output directory, and the captured/failed page counts.

## Capture API specs (`--api`)

While loading each page, screenshotter can record the network and turn the
observed API traffic into specs. Add `--api` (CLI) or `captureApi: true` (MCP):

```bash
node dist/index.js https://example.com --api
```

This writes an `api/` folder (into the output dir and the zip):

```
<mode>/api/
  openapi/<host>.json   # inferred OpenAPI 3.1: templated paths (/users/{user}),
                        # query/path params, request+response JSON schemas merged
                        # across samples — one file per API host
  api-endpoints.md      # readable catalog: method, path, status, content-types, samples
  network.har           # standard HAR 1.2 — import into Postman/Insomnia/DevTools
```

- **What's captured:** XHR/fetch + JSON/GraphQL responses only (HTML/CSS/JS/img/
  font/media are excluded). `--api-same-origin` restricts to the site's own host;
  by default third-party APIs are captured too (grouped per host).
- **Secrets are redacted** in *all* artifacts: `Authorization`/`Cookie`/`Set-Cookie`/
  api-key headers, token-like body/query values, and tokens in URLs become
  `[REDACTED]`. `--api-max-body <kb>` caps body size (default 256).
- **It's passive:** you only get the endpoints the page actually calls during the
  visit. Server-rendered sites may expose little on plain load; their first-party
  APIs often fire on interaction (search, infinite scroll).
- The inferred OpenAPI is a best-effort snapshot of observed traffic, **not an
  authoritative spec**.

## Extract real source material (`--extract`)

Screenshots alone force an agent to *reverse-engineer* fonts/colors. `--extract`
captures the **real** material so it can **match** instead:

```bash
node dist/index.js https://example.com --extract
```

Adds, under `<mode>/`:

```
<category>/NN-slug.html              # rendered DOM (post-JS) per page
<category>/NN-slug.normalized.html   # same, with dynamic values placeholdered
<category>/NN-slug.aria.yaml + .a11y.json  # accessibility goldens (for a11y-diff)
design-tokens.json / design-tokens.md  # computed colors/fonts/spacing/radii/shadows
assets/{fonts,images,svg,css}/…      # the actual downloaded files, deduped
assets/manifest.json                 # url → file, content-type, bytes, category
```

- Real **woff2/woff/ttf**, SVG, raster images, and CSS are saved off the wire
  (deduped across pages, 10MB/asset cap). Add `--assets-js` to also save JS.
- `design-tokens.json` is a machine-readable design snapshot agents can consume.

## Deterministic capture (default on)

Every run freezes the page clock, pins `timezone=UTC` + `locale=en-US`, emulates
reduced-motion + seeds `Math.random`, and disables animations/transitions — so
captures are reproducible and golden/visual diffs compare signal, not noise.

- `--no-deterministic` restores real time/locale/animations.
- `--freeze-time <iso>` / `--timezone <tz>` / `--locale <loc>` to tune it.
- `--mask 'sel,sel'` blacks out dynamic regions (ads, live tickers) in screenshots.
- **Normalization:** with `--extract`, each DOM dump also gets a
  `*.normalized.html` where UUIDs/timestamps/emails/long-hex/tokens become stable
  placeholders (`{{UUID}}`, `{{TIMESTAMP}}`, …) — deterministic fixtures that also
  keep secrets out. Disable with `--no-normalize`.

## Full interaction explorer (`--full`)

`--full` turns screenshotter into an automated UI explorer: it recursively clicks
through the app, **screenshots and records every resulting state**, so a rebuild has
real features instead of dead stubs.

```bash
node dist/index.js https://example.com --full
```

Adds under `<mode>/`:

```
explore/
  <page>/NNN-<action>.png / .html   # result state after each click
  <page>/graph.json                 # state graph: actions + outcomes + network
  interactions.md                   # readable behavioral catalog
downloads/                          # files triggered by clicks + manifest.json
```

For each clickable it records the **outcome** — navigation / modal / download /
DOM-change / no-op — plus the network calls it fired. Repeated controls (e.g. 50
list cards) are deduped to representatives; it's bounded by `--full-depth` (2),
`--max-actions` (500), `--max-actions-per-page` (40), and time budgets. Pages are
explored **in parallel** (`--concurrency`). The `REBUILD-PROMPT.md` gains a
**Behaviors** section listing the real flows.

**Menu/modal-internal controls are captured too.** The explorer detects
disclosures (dropdowns, `aria-haspopup`/`aria-expanded`, `<summary>`, dialogs),
opens them, and explores the controls they reveal — e.g. a "Use this model"
dropdown's *Transformers* / *vLLM* items. Each such feature records the click
**path** that reaches it (the shortest one) as a `precondition` in
`behaviors.json`, which `qc-tasks` replays as pre-steps so the control is both
first-class **and** runnable by the gate.

> With `--api`, request/response bodies are captured via a bounded sidecar (the HAR
> itself omits bodies) so heavy `--full --api` runs stay memory-safe.

### ⚠ Safety

- `--full` alone is **safe**: it skips controls labelled delete/remove/logout/pay/
  checkout/submit/send/… and won't submit mutating forms.
- `--full --aggressive` clicks **~everything incl. form submits and data
  mutations** — it still hard-skips logout/payment/delete-account, but it WILL
  change real data. Use only on apps you own / staging. It prints a loud warning
  (extra if the target isn't localhost). Combine with `--auth` only when you fully
  trust the target — a logged-in session widens the blast radius.

## Make the rebuild *functional* (data + behaviors + QC gate)

A faithful UI is easy to copy; working features are not. So with `--api`/`--full` the
bundle also ships the substrate to make functionality real, and a gate to prove it:

- **`api/fixtures/*.json`** — the real recorded (redacted) responses as importable seed data.
- **`api/mock/server.mjs`** — a **zero-dependency runnable mock API** (CORS) that serves
  those fixtures offline. `cd api/mock && node server.mjs` → the rebuild has a backend.
- **`explore/behaviors.json`** — machine-readable **features** (modals/search/tabs/
  downloads/API-firing actions) separated from plain **routes**, each linked to its fixture.
- **`qc/qc-tasks.{md,json}`** — functional QC tasks generated from those behaviors.

The `qc-tasks` command is the functional gate — it replays each feature against a
candidate using **semantic locators** (role + accessible name, so it ports to a rebuild):

```bash
# generate tasks from a bundle:
screenshotter qc-tasks output/example
# run them against your rebuild (exit 1 if any fail → CI gate):
screenshotter qc-tasks output/example --run --target http://localhost:3000
#   ✓ QC-001 modal: "Show details" …
#   ✗ QC-007 search → /api/quicksearch (control not found)
#   8/9 passed
```

The `REBUILD-PROMPT.md` now makes **functionality a first-class acceptance gate**
(run the mock, implement `behaviors.json`, pass `qc-tasks`) alongside visual fidelity —
not pixels-only. See `AUDIT.md` for the rationale.

## Grade a rebuild — a11y-diff gate

A11y trees are a far sturdier "did the agent reach the right state" signal than
pixels or raw DOM. With `--extract`, screenshotter writes per-state accessibility
**goldens** (`<name>.aria.yaml` + `<name>.a11y.json`, with dynamic names
normalized). The `a11y-diff` subcommand grades a candidate against a golden:

```bash
# each side is a URL (captured live) OR a saved golden file
screenshotter a11y-diff golden.aria.yaml http://localhost:3000
#   → score 0.94  PASS (≥0.90)        exit 0
#   → score 0.71  FAIL (≥0.90)        exit 1   + missing/extra nodes

screenshotter a11y-diff a.aria.yaml b.aria.yaml --threshold 0.95 --json
```

- Similarity is a multiset Dice score over `role "name"` signatures (robust to
  wrapper shifts); `--exact` requires a perfect match; non-zero **exit code** below
  threshold makes it a CI gate. `--json` emits machine output.

## One-shot rebuild prompt

Every bundle includes **`REBUILD-PROMPT.md`** at its root — a self-contained spec
that turns the zip into a template generator: hand the whole zip to Claude (or any
agent) and it has everything to one-shot a faithful rebuild. The prompt:

- inventories every artifact (screenshots, DOM, tokens, real assets, OpenAPI) with
  paths relative to itself (so it works straight out of the unzipped folder);
- inlines the real design system (font families, type scale, colors, spacing,
  radii, shadows) and references `design-tokens.json` for the full set;
- lists every page with its route, screenshot, and DOM reference;
- sets hard requirements (use the real fonts/SVGs, match tokens exactly, mirror the
  DOM, wire data to the captured API) and a definition-of-done checklist.

It scales to what you captured — with `--extract` it cites the real fonts/assets and
DOM; with `--api` it cites the endpoints. Disable with `--no-prompt`, or bias the
output stack with `--prompt-stack react+tailwind`.

```bash
node dist/index.js https://example.com --extract --api   # bundle + REBUILD-PROMPT.md
# then: unzip, open the folder in Claude Code, point it at REBUILD-PROMPT.md
```

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # compile to dist/
```
