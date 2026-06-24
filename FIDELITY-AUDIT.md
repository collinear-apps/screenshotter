# Fidelity audit — toward a one-shot 1:1 *functional* twin

> **Status (implemented):** All 5 phases were built in parallel and integrated.
> Verified end-to-end on a local JSON-API test site: query-aware + stateful mock
> (no-query/POST fallback fixed), entity-graph normalization, **data-fidelity QC gate
> (2/2 pass — captured values must render)**, breakpoint×dark variant capture,
> run-manifest, runnable scaffold + bundle.json. Build + `tsc` green; plain runs
> unchanged. New flags: `--breakpoints`, `--dark`, `--sitemap`, `--paginate`,
> `--max-retries`, `--request-delay`, `--websocket`, `--no-stream`,
> `--no-stateful-mock`, `--no-redact-values`, `--no-scaffold`, `--no-reauth`.
> Remaining polish (lower-priority majors/minors) is still tracked below.

---


**North star:** scrape an entire app → a zip that lets Claude Code rebuild a **1:1
functional twin** (real working features, not mocks) in **one shot**. Concrete target:
a working huggingface.co twin (browse/search models & datasets, model cards, dataset
viewer, "Use this model"/inference, auth, listings, pagination).

This audit graded the current system against that goal across 7 dimensions, with every
major/blocker finding verified against the source. Result: **48 confirmed gaps —
10 blockers, 32 major, 6 minor.**

## Bottom line

Today the tool produces a **faithful static look-alike, not a working twin.** The
capture side is strong (deterministic screenshots, real assets, DOM, tokens, inferred
OpenAPI, the `--full` explorer, a11y/QC gates). The break is on the **data + rebuild
contract**:

- The mock server routes on **method+path only** (`src/api/mockserver.ts`,
  `src/api/fixtures.ts`), so **search, pagination, sort, and filters all return one
  identical body** — the most basic HF browsing is dead.
- **"Functional done" is defined as "a request fired / the DOM changed"**
  (`src/qc/run.ts` dom-change branch) — never "the captured model's fields actually
  render in the right place." A twin that fetches the mock and shows **placeholder or
  wrong data passes every gate.** This is the single largest hole between "looks like
  HF" and "is a 1:1 data-faithful HF."
- Captured **request bodies already exist** in every fixture (`requestExample` via
  `src/api/har.ts` / `src/api/bodies.ts`) but **nothing downstream uses them** — the
  mock has no write path, so POST/login/"Use this model"/create flows are dead despite
  the raw material being in the bundle.
- The handoff says *"point your app at it"* with **no API-base/env/host-map wiring
  contract** (`src/prompt/generate.ts`), so multi-host HF (`huggingface.co`,
  `api-inference.*`, `datasets-server.*`) is un-wireable one-shot.
- A large run isn't trustworthy yet: **no rate-limit backoff** and **no 401/403
  session-expiry detection** mean a 150-page HF run will get throttled and/or silently
  degrade to logged-out captures, with **no manifest** saying what was/wasn't captured.

Close those and the existing strengths become a working twin.

## The 10 blockers (and where they live)

| # | Blocker | Evidence |
|---|---------|----------|
| 1 | Mock ignores query params & request bodies — search/pagination/filter all return one fixture | `src/api/mockserver.ts`, `src/api/fixtures.ts` |
| 2 | No data-fidelity oracle — QC asserts "request fired", never "captured fields rendered" | `src/qc/run.ts`, `src/qc/generate.ts` |
| 3 | No stateful mock — `requestExample` captured but discarded; create/like/follow/auth writes dead | `src/api/mockserver.ts` + `fixtures.ts:requestExample` |
| 4 | SSE / streaming dropped entirely — HF inference + dataset-viewer streaming have no contract | `src/api/har.ts`, `src/api/bodies.ts` |
| 5 | No frontend scaffold emitted — agent must invent router/client/tokens/proxy/env | `src/prompt/generate.ts` |
| 6 | No API-base / per-host wiring contract — "point your app at it" is hand-waved | `src/prompt/generate.ts` |
| 7 | No structured listing-row extraction — list content survives only as 1 screenshot + 1 HTML blob | `src/extract/dom.ts`, `src/api/bodies.ts` |
| 8 | Text inputs never enumerated/filled — form field schemas, types, validation uncaptured | `src/explore/clickables.ts`, `src/explore/engine.ts` |
| 9 | No rate-limit/backoff/retry/politeness — HF 429/403-blocks a 150-page run mid-crawl | `src/capture/browser.ts`, `src/pipeline.ts` |
| 10 | No session-expiry (401/403) detection mid-crawl — auth silently degrades to anonymous | `src/pipeline.ts`, `src/auth/*` |

Plus 32 majors clustered under: WebSocket/error-shape/header/GraphQL contract gaps;
pagination & infinite-scroll never minting capture targets; explore-discovered
navigations not expanding the page set; README/markdown + dataset-rows + entity-graph
not extracted; `<select>`/upload/drag/hover/keyboard unmodeled; loading/empty/error not
first-class behaviors; no screenshot→component mapping; light-mode-only + 2 breakpoints
+ dropped CSS custom properties + unlinked `@font-face`; value-blind secret redaction;
shared BrowserContext cross-talk under concurrency; no coverage manifest.

## HF-specific feature classes entirely unmodeled (critic finding)

These are load-bearing for an HF twin and fall through the cracks between dimensions:

- **File-tree / raw-file browsing** (`Files and versions`, `resolve/`, `tree/`, `blob/`)
  — repo file browsing + raw file serving is core HF and wholly uncaptured.
- **Markdown README rendering pipeline** — GFM + code highlighting + sanitized HTML +
  relative link/image rewrite to `resolve/` URLs; captured as raw data at best, with no
  rendering contract, so the card body will look visibly different.
- **Dataset viewer** — parquet/row pagination API + rows never captured.
- **Inference / "Use this model"** — request+response payloads neither captured (SSE
  dropped) nor seeded, so the most-demoed feature is dead even on the happy path.

## Sequenced roadmap

Ordered so each phase unlocks the next (capture-side trust → data contract → content →
coverage/visual → runnable gated handoff).

### Phase 0 — Capture integrity
*A long HF run yields a complete, authenticated, reproducible, non-leaking corpus that
declares its own gaps.*
- `gotoWithRetry` + per-host `requestDelayMs` (backoff/politeness) — `capture/browser.ts`, `pipeline.ts`
- 401/403 + login-redirect detection with single-flight re-auth — `pipeline.ts`, `auth/*`
- Server-data normalization (timestamps/counts/IDs/order) + **value-shape** secret
  redaction + scrub raw HTML — `determinism.ts`, `api/redact.ts`
- `run-manifest.json` with per-route ok/error/authState/truncation flags — `output/*`

### Phase 1 — Query/body-aware, stateful, streaming data contract
*Mock behaves like a real backend: distinct per query/body, mutations reflect, streams replay.*
- Fixture keying by **query signature + request-body hash** (multi-fixture per endpoint) — `api/fixtures.ts`
- Mock parses `searchParams`/body, best-variant match — `api/mockserver.ts`
- **Stateful store seeded from `requestExample`**; POST-then-GET works — `api/mockserver.ts`
- SSE/stream replay; status-aware (4xx/5xx) fixtures; response-header allowlist
  (pagination/cursor/rate-limit); GraphQL `operationName` keying; WebSocket transcript — `api/*`

### Phase 2 — Live interaction & content capture
*Actuate surfaces and extract content/entities so listings, forms, and detail pages have real data.*
- Fill all input kinds with validation capture; loading/error/empty as first-class
  outcomes; actuate `<select>` — `explore/clickables.ts`, `explore/engine.ts`
- Behavior enrichment: debounce/filter/sort, infinite-scroll/load-more, hover-reveal,
  persisted (localStorage) state — `explore/*`
- Extract **structured listing rows**, SSR islands, README (raw + rendered), build an
  **entity/relationship graph** — `extract/dom.ts`, new `extract/entities.ts`
- HF specifics: file-tree + representative raw files, dataset rows/parquet, inference
  request/response (canned safe input)

### Phase 3 — Coverage breadth & visual variants
*Capture the whole route map and visual axes so the twin isn't a hollow slice.*
- `sitemap.xml`/`robots.txt` ingestion; pagination/explore-nav/auth-gated seeds feed
  `captureOne` — `discovery/crawler.ts`, `discovery/profiles/*`
- Breakpoint matrix (tablet/desktop/wide + mobile) in one run; dark/color-scheme pass — `capture/browser.ts`, `pipeline.ts`
- CSSOM/custom-property harvest, element-state capture (hover/focus/active/disabled),
  `@font-face`↔woff2 linkage, favicons/og-image — `extract/*`

### Phase 4 — Runnable handoff & data-fidelity gate
*A runnable, navigable, self-verifying handoff so a hollow data layer fails the gate.*
- Emit a **frontend scaffold** (router, design tokens, API client, mock proxy,
  `.env.example` with `API_BASE_URL`, per-host→mockBase map) — new `src/scaffold/*`
- Root **`bundle.json` index** linking every route → screenshot → DOM → a11y golden →
  fixtures → behaviors; component inventory — `output/*`
- **Data-fidelity oracle**: extract salient fixture field values, map to DOM regions,
  assert they render in the rebuild; + coverage QC (route + row-count) — `qc/generate.ts`, `qc/run.ts`
- REBUILD-PROMPT: ordered build procedure, secrets placeholder/env-substitution scheme,
  one verify script that runs all gates — `prompt/generate.ts`

## Quick wins (do alongside Phase 0–1)
- Value-shape secret redaction + scrub raw HTML — `api/redact.ts`
- `.env.example` + per-host→mock map (replace "point your app at it") — `prompt/generate.ts`
- Auth-gated discovery seeds in the HF profile (behind `cfg.auth`, before the maxPages
  slice) — `discovery/profiles/huggingface.ts`
- Favicon / og-image / manifest-icon head-meta extraction — `extract/assets.ts`
- Hash-route preservation in crawler `normalize()` — `discovery/crawler.ts`
- localStorage/client-state delta capture in the explorer — `explore/engine.ts`
