# screenshotter — How-to guide

Task-oriented walkthroughs. For a feature overview see [README.md](./README.md).

- [Setup](#setup)
- [Quickstart](#quickstart)
- [Choosing what to capture](#choosing-what-to-capture)
- [Output: the zip](#output-the-zip)
- [Recipe: authenticated / gated sites](#recipe-authenticated--gated-sites)
- [Recipe: capture API specs](#recipe-capture-api-specs)
- [Recipe: use it from Claude Code](#recipe-use-it-from-claude-code)
- [Full flag reference](#full-flag-reference)
- [Troubleshooting](#troubleshooting)

---

## Setup

```bash
npm install
npx playwright install chromium   # one-time browser download
npm run build                     # compiles TypeScript → dist/
```

Re-run `npm run build` after any change under `src/`.

---

## Quickstart

Interactive (it asks for URL, mode, and optional pages):

```bash
node dist/index.js
```

Or pass everything as flags:

```bash
node dist/index.js https://huggingface.co --mode web
```

→ produces `huggingface-screenshots.zip` in the current directory.

> Tip: `npm link` once, then call `screenshotter …` from anywhere instead of `node dist/index.js …`.

---

## Choosing what to capture

**Mode** — `--mode web` (desktop, 1440×900 @2× retina) or `--mode mobile` (iPhone 13 profile).

**Which pages** — three ways, in priority order:

1. **Explicit list** — exactly the paths/URLs you name:
   ```bash
   node dist/index.js https://example.com -p "/, /pricing, /docs/intro"
   ```
2. **Site profile** — if none given and the site has a built-in profile (e.g. HuggingFace), it captures representative pages across its sections (Models, Datasets, Spaces, Leaderboards, Organizations, Profiles).
3. **Generic crawl** — otherwise a bounded same-domain crawl:
   ```bash
   node dist/index.js https://example.com --max-pages 15 --depth 2
   ```

**Sub-links** — explicit lists and site profiles return a *fixed* seed set; they don't
follow the links inside those pages. Add `--sub-links` to also crawl + capture the
same-origin links inside each discovered page (bounded by `--depth` hops,
`--max-sublinks-per-page`, and a `--max-pages` default that rises to 150). Sub-pages
inherit their parent's category and get the same `--extract`/`--api`/`--full` treatment:
```bash
node dist/index.js https://huggingface.co --sub-links --extract   # seeds + their sub-pages
```

**Speed vs. coverage** — `--concurrency <n>` (parallel pages, default 4), `--max-pages`, `--depth`, `--max-sublinks-per-page`.

---

## Output: the zip

```
<sitename>-screenshots.zip
└── <mode>/                         # e.g. web/ or mobile/
    ├── <category>/NN-<slug>.png    # screenshots clustered by category
    ├── typography.md               # extracted fonts, type scale, colors
    ├── REBUILD-PROMPT.md           # self-contained spec to hand to Claude
    ├── <category>/NN-<slug>.aria.yaml + .a11y.json  # a11y goldens (with --extract)
    ├── api/                        # only when --api is used
    │   ├── fixtures/*.json         # recorded responses as importable seed data
    │   └── mock/server.mjs         # zero-dep runnable mock API (node server.mjs)
    ├── explore/behaviors.json      # features vs routes (machine-readable)
    ├── qc/qc-tasks.{md,json}       # functional QC tasks (with --full)
    ├── explore/                    # only when --full is used
    └── downloads/                  # files clicks triggered (with --full)
        ├── openapi/<host>.json
        ├── api-endpoints.md
        └── network.har
```

Screenshots are full-page, captured after dismissing cookie banners, auto-scrolling
lazy content, and waiting for fonts + network to settle. Use `--out <dir>` to change
the working directory, or `--no-zip` to leave just the folder.

---

## Recipe: authenticated / gated sites

### Option A — log in once, reuse the session (best for SSO / 2FA / "accept terms")

```bash
# 1. Opens a real browser. Log in by hand, then return to the terminal and press Enter.
node dist/index.js login https://app.example.com --out .auth/example.json

# 2. Capture using the saved session.
node dist/index.js https://app.example.com --auth .auth/example.json
```

The saved file is a Playwright `storageState` (cookies + localStorage). `.auth/` is
gitignored — treat these files as **secrets**.

### Option B — HTTP Basic auth

```bash
node dist/index.js https://staging.example.com --basic-auth user:pass
```

### Option C — username/password form login

```bash
node dist/index.js https://app.example.com \
  --login-url https://app.example.com/login \
  --username "$MY_USER" --password "$MY_PASS"
```

Credentials are also read from `SCREENSHOTTER_USERNAME` / `SCREENSHOTTER_PASSWORD`
(preferred over flags, which can leak via shell history). Fields are autodetected;
override with `--user-selector`, `--pass-selector`, `--submit-selector`, and use
`--success-url <glob>` to confirm login succeeded.

---

## Recipe: capture API specs

Add `--api` to record the network while pages load and turn it into specs:

```bash
node dist/index.js https://huggingface.co --api
```

You get an `api/` folder (in the output dir and the zip):

| File | What |
|------|------|
| `openapi/<host>.json` | inferred **OpenAPI 3.1** — templated paths (`/users/{user}`), path/query params, request+response JSON schemas merged across samples, one per API host |
| `api-endpoints.md` | readable catalog: method, path, status, content-types, samples |
| `network.har` | standard HAR 1.2 — import into Postman / Insomnia / Chrome DevTools |

**Interaction (capturing first-party APIs).** Many sites only call their own API on
interaction (search, infinite scroll, tabs). With `--api`, screenshotter drives a
**safe, bounded** interaction pass *after* each screenshot to provoke those calls:
it scrolls, types into search boxes, clicks tabs and "load more"/"next" buttons. It
never clicks links or destructive controls (delete/logout/checkout/…).

```bash
# Tune the search term it types (default "a"); disable interaction entirely.
node dist/index.js https://huggingface.co --api --api-search "bert"
node dist/index.js https://huggingface.co --api --no-interact
```

> Example: on HuggingFace, `--api` + interaction captures first-party endpoints like
> `GET /api/quicksearch` and `GET /models-json` that don't fire on a plain page load.

**Scope & safety:**
- Only XHR/fetch + JSON/GraphQL responses are kept (HTML/CSS/JS/images/fonts/media excluded). `--api-same-origin` restricts to the site's own host; otherwise third-party APIs are captured too, grouped per host.
- **Secrets are redacted everywhere** — `Authorization`/`Cookie`/`Set-Cookie`/api-key headers, token-like body & query values, and tokens in URLs become `[REDACTED]`. `--api-max-body <kb>` caps body size (default 256).
- It's **passive**: you only get endpoints the page actually calls during the visit. The OpenAPI is a best-effort snapshot, not an authoritative spec.

Combine with auth to capture a logged-in app's API:

```bash
node dist/index.js https://app.example.com --auth .auth/example.json --api
```

---

## Recipe: extract real assets, DOM & design tokens

Capture the source material so an agent matches the brand instead of guessing:

```bash
node dist/index.js https://example.com --extract
```

Per run you get (under `<mode>/`): per-page `NN-slug.html` (rendered DOM) +
`NN-slug.normalized.html`, `design-tokens.json` / `design-tokens.md`, and an
`assets/{fonts,images,svg,css}/` tree of the **real downloaded files** with a
`manifest.json`. Add `--assets-js` to include JS bundles.

### Deterministic & normalized fixtures

Capture is deterministic by default (frozen clock, `UTC`/`en-US`, no animations,
seeded random) so re-running yields identical output — ideal for golden/visual
diffs. With `--extract`, each DOM dump also gets a `*.normalized.html` where
dynamic values (UUIDs, timestamps, emails, hashes, tokens) become stable
placeholders, which also keeps secrets out of committed fixtures.

```bash
# tune determinism, or turn it off
node dist/index.js https://example.com --extract --timezone America/New_York
node dist/index.js https://example.com --no-deterministic
# black out a live region in the screenshot
node dist/index.js https://example.com --mask '.ticker, [data-ad]'
```

## Recipe: add a missed/gated page to an existing bundle

Discovery doesn't always find every page (especially gated ones). Capture an exact
URL with your saved session and append it to the bundle — no full re-crawl:

```bash
make login URL=https://huggingface.co                    # once → .auth/huggingface.json
node dist/index.js add https://huggingface.co/settings/tokens \
  --auth .auth/huggingface.json --into output/huggingface
# or: make add URL=https://huggingface.co/settings/tokens INTO=output/huggingface AUTH=.auth/huggingface.json
```

It captures full page artifacts (screenshot + DOM + a11y + API fixtures), appends
them under the right category with continued numbering (never clobbers existing
files), refreshes the mock from the merged fixtures, and rebuilds the zip. Pass
multiple URLs at once; `--no-zip` to skip re-zipping. Note: `REBUILD-PROMPT.md` /
`design-tokens` / `qc` reflect the original run — re-run a full capture to refresh them.

## Recipe: capture every feature with `--full`

Exhaustively click through the app so the rebuild gets real behaviors, not stubs:

```bash
node dist/index.js https://example.com --full --extract --api   # the works
```

This adds an `explore/` tree: per-action result screenshots + DOM, a `graph.json`
state graph (each action's outcome — navigation/modal/download/dom-change — and the
network it fired), an aggregate `interactions.md`, and a `downloads/` folder for any
files clicks triggered. The `REBUILD-PROMPT.md` gains a **Behaviors** section.

It dedupes repeated controls and is bounded by `--full-depth` (2), `--max-actions`
(500), `--max-actions-per-page` (40) + time budgets.

> ⚠ **Aggressive mode mutates data.** `--full` is safe (skips destructive controls).
> `--full --aggressive` clicks ~everything incl. form submits — only on apps you
> own/staging. It always hard-skips logout/payment/delete-account and warns loudly.

```bash
node dist/index.js http://localhost:3000 --full --aggressive   # your own app
```

## Recipe: make the rebuild functional + gate it (qc-tasks)

`--api`/`--full` now emit a runnable backend + a behavior contract + QC tasks so the
rebuild can actually *work*, not just look right:

```bash
node dist/index.js https://example.com --full --extract --api   # emits fixtures/mock/behaviors/qc
# point the rebuild at the recorded backend:
cd output/example/web/api/mock && node server.mjs   # mock API on http://localhost:8787 (CORS)
# generate / run the functional gate:
node dist/index.js qc-tasks output/example                              # write qc/qc-tasks.*
node dist/index.js qc-tasks output/example --run --target http://localhost:3000   # exit 1 on fail
```

`qc-tasks` replays each recorded feature against the target with semantic locators
(role + accessible name), so it grades a *rebuild*, not just the original. `behaviors.json`
lists the features to implement; the mock serves the real data; the prompt makes
functionality a first-class acceptance gate. (Background: `AUDIT.md`.)

Features hidden behind a **dropdown/menu/modal** (e.g. a "Use this model" menu's
*Transformers* / *vLLM* items) are captured with a `precondition` — the shortest
click path that opens them. `qc-tasks --run` replays those pre-steps (open the
menu, then act), and the locator falls back from the captured ARIA role to the
accessible **name**, so a rebuild that picks a different role still passes.

## Recipe: grade a rebuilt UI (a11y-diff gate)

Accessibility trees verify an agent reached the **right UI state** far more reliably
than pixels or raw DOM. Capture goldens with `--extract`, then gate a rebuild:

```bash
node dist/index.js https://example.com --extract           # writes *.aria.yaml goldens
# grade the rebuild (each side may be a URL or a saved golden file):
node dist/index.js a11y-diff \
  output/example/web/home/01-home.aria.yaml http://localhost:3000
#   → score 0.96  PASS (≥0.90)   exit 0
```

- Score is a multiset Dice similarity over `role "name"` nodes (names normalized,
  so dynamic counts/dates don't churn). `--threshold` sets the bar (default 0.9),
  `--exact` demands a perfect match, `--json` emits machine output.
- **Exit code is the gate:** 0 = pass, 1 = below threshold, 2 = error — drop it
  straight into CI / an eval harness.

## Recipe: hand the zip to Claude to rebuild the site

Every bundle contains **`REBUILD-PROMPT.md`** at its root — a detailed spec that
references all the captured artifacts and tells an agent to one-shot a faithful
rebuild. To use it:

```bash
node dist/index.js https://example.com --extract --api   # richest bundle
unzip example-screenshots.zip -d example-capture
# open example-capture/ in Claude Code and say: "Follow web/REBUILD-PROMPT.md"
```

The prompt inlines the real design tokens, lists every page (route + screenshot +
DOM), points at the real fonts/SVGs/images and the OpenAPI specs, and ends with a
definition-of-done checklist. Bias the target framework with
`--prompt-stack react+tailwind`, or skip the file with `--no-prompt`. Richer input
(`--extract`, `--api`) → a more complete prompt.

## Recipe: use it from Claude Code

The repo is also a Claude Code plugin (slash command + MCP server).

```bash
npm install && npm run build && npx playwright install chromium   # build first
claude --plugin-dir /Users/amit/Documents/codebase/screenshotter  # load it
```

Then either run the slash command:

```
/screenshotter:screenshot https://huggingface.co web
```

…or just ask Claude (it calls the `capture_website` MCP tool). The tool accepts
`url`, `mode`, `pages`, `maxPages`, `depth`, `concurrency`, `zip`, `authFile`,
`captureApi`, `apiSameOrigin`, `interact`, `apiSearch`, `extract`, `deterministic`,
`mask`, `freezeTime`, `timezone`, `locale`, `prompt`, `promptStack`, `full`,
`aggressive`, `out`, and returns the zip path + captured/failed counts. After
rebuilding, run `/reload-plugins`.

> The interactive `login` flow is CLI-only (it needs a visible browser); for the
> plugin/MCP, pass a pre-captured session via `authFile`.

---

## Full flag reference

`node dist/index.js [url] [options]`

| Flag | Default | Description |
|------|---------|-------------|
| `[url]` | prompted | website URL (positional) |
| `-m, --mode <web\|mobile>` | `web` | desktop 2× retina, or iPhone 13 |
| `-p, --pages <list>` | — | comma-separated paths/URLs; skips discovery |
| `-o, --out <dir>` | `output/<site>` | working output directory |
| `--max-pages <n>` | `25` (`150` w/ `--sub-links`) | cap on pages captured |
| `--depth <n>` | `2` | crawl depth (generic crawler / sub-link hops) |
| `--sub-links` | off | also follow + capture same-origin links inside discovered pages |
| `--max-sublinks-per-page <n>` | `25` | cap on links followed per page with `--sub-links` |
| `-c, --concurrency <n>` | `4` | pages captured in parallel |
| `--no-zip` | — | skip producing the zip |
| `--auth <file>` | — | reuse a saved session (from `login`) |
| `--basic-auth <user:pass>` | — | HTTP Basic credentials |
| `--login-url <url>` | — | form-login page URL |
| `--username` / `--password` | env | form-login creds (or `SCREENSHOTTER_USERNAME`/`_PASSWORD`) |
| `--user-selector` / `--pass-selector` / `--submit-selector` | auto | override form field selectors |
| `--success-url <glob>` | — | URL to wait for after login |
| `--api` | off | capture network → OpenAPI + catalog + HAR |
| `--api-same-origin` | off | only the site's own host |
| `--api-max-body <kb>` | `256` | per-body size cap |
| `--no-interact` | — | with `--api`, don't drive interactions |
| `--api-search <term>` | `a` | search term typed during interaction |
| `--extract` | off | save rendered DOM + design tokens + real assets |
| `--assets-js` | off | with `--extract`, also save JS bundles |
| `--no-normalize` | — | with `--extract`, skip `*.normalized.html` copies |
| `--no-deterministic` | — | disable clock/timezone/locale/animation freezing |
| `--freeze-time <iso>` | `2024-01-01T00:00:00Z` | timestamp the clock is frozen to |
| `--timezone <tz>` | `UTC` | IANA timezone |
| `--locale <loc>` | `en-US` | capture locale |
| `--mask <selectors>` | — | comma-separated CSS selectors to black out |
| `--no-prompt` | — | skip generating `REBUILD-PROMPT.md` |
| `--prompt-stack <name>` | — | bias the rebuild prompt to a stack (e.g. `react+tailwind`) |
| `--full` | off | recursively click + record + screenshot every state |
| `--aggressive` | off | with `--full`: click ~everything incl. form submits (DANGEROUS) |
| `--full-depth <n>` | `2` | max exploration recursion depth |
| `--max-actions <n>` | `500` | global cap on recorded actions |
| `--max-actions-per-page <n>` | `40` | per-page action cap |

Subcommands:
- `node dist/index.js login <url> [--out <file>] [--mode <web\|mobile>]`
- `node dist/index.js add <url...> [--into <dir>] [--auth <file>] [--mode] [--no-api] [--no-zip]`
- `node dist/index.js a11y-diff <expected> <actual> [--threshold 0.9] [--exact] [--mode] [--json]`
- `node dist/index.js qc-tasks <bundleDir> [--run --target <url>] [--threshold 0.9] [--mode] [--json]`

---

## Troubleshooting

**"No pages found to capture."** The crawler found no same-origin links (or the URL
redirected off-domain). Pass explicit `-p "/path1,/path2"`.

**A run hangs or is slow.** Heavy sites keep sockets open; screenshotter caps the
`networkidle` wait and falls back automatically. Lower `--max-pages`/`--concurrency`
for very large sites.

**Login page / a site returns 403 ("request could not be satisfied").** Some sites
bot-gate their auth path. screenshotter presents a realistic desktop user-agent and
clears `navigator.webdriver` by default, which clears most of these. If a site still
blocks the automated POST, use the interactive `screenshotter login <url>` flow (a
real browser you drive) and reuse the saved session with `--auth`.

**`login` does nothing / errors about display.** The login flow opens a *visible*
browser; it needs a desktop session (won't work over plain SSH/headless). Use
`--basic-auth` or form login for headless/CI.

**Pages render logged-out despite `--auth`.** The saved session expired — re-run
`screenshotter login`.

**`--api` only shows third-party hosts.** The site is server-rendered and didn't call
its own API on load. Interaction is on by default; try a more specific
`--api-search "<term>"`, and make sure you didn't pass `--no-interact`.

**MCP tool / plugin not found.** Build first (`npm run build`) — the MCP server runs
from `dist/`. After changes, run `/reload-plugins` in Claude Code.

**Secrets in the HAR?** They shouldn't be — headers, token-like body/query values,
and URL tokens are redacted. If you spot a gap, it's a bug; the raw recording is
deleted and only the redacted `network.har` is written.
