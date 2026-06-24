# Audit — why rebuilds get the UI but not the functionality

**Symptom:** handing the bundle to a strong coding agent (Opus 4.8) produced a
visually-OK rebuild with **non-working features** (dead buttons, no real data,
flows not implemented).

**One-line diagnosis:** the bundle optimizes hard for *appearance reproduction*
(DOM + screenshots + tokens + assets ≈ copy-paste) but ships *functionality* as
**unstructured homework** — the data is locked inside OpenAPI examples / HAR, the
behaviors are prose buried in navigation noise, there is **no runnable substrate**
(no fixtures, no mock server, no scaffold, no functional gate), and the prompt
**actively de-prioritizes** wiring it up.

This was verified against a real `output/huggingface` bundle (see evidence inline).

---

## Why the agent built UI and skipped function

An agent optimizes for what is (a) emphasized and (b) cheap. The bundle makes UI
both; it makes functionality neither.

### 1. The prompt ranks pixels first, data/behavior last
`REBUILD-PROMPT.md` requirement order:
1. **"Pixel-match the screenshots … treat each PNG as the acceptance target"** (loudest)
6. *"Wire data to the observed API … build a typed client; seed mocks/fixtures from the response examples"* (last, vague, **offloaded to the agent**)
- "How to build" then says *"make the captured viewport pixel-faithful first."*

So the only **acceptance target** stated is visual. "Functionality" is described as
work the agent must invent infra for — with no ready artifacts — so it gets dropped.

### 2. Functionality has nowhere to run (the biggest gap)
The bundle has **no `fixtures/`, no mock server, no `package.json`/scaffold**
(confirmed: those dirs/files don't exist). The real response bodies exist only as
`example` blobs inside `api/openapi/<host>.json` and inside `network.har`. To make
a feature work the agent would have to: dig examples out of OpenAPI → invent a data
layer → stand up a mock → wire it. Nothing hands any of that over, so it doesn't
happen. **Data the UI needs is present but not runnable.**

### 3. The behavior signal is real but drowned in noise
`interactions.md` (113 actions) is **~70 navigations** — "Clicking *Datasets* →
/datasets" repeated on every page. The genuinely functional events (state/data
changes) are rare and look identical in weight, e.g. the one good line:
`"Models" updates the view (DOM change); fires API: /models, /api/event`.
The prompt's **Behaviors** section is likewise dominated by trivial routing, so the
"features" don't stand out as things to implement. Routing ≠ features, but we don't
separate them.

### 4. The API contract is lossy/noisy
OpenAPI does carry real schemas+examples for most first-party endpoints (good), but
path-templating degraded them: `GET /api/{api}` over-collapses many distinct
endpoints into one, and `/api/spaces/.../{Boogu-Image}` is mis-parameterized. A
noisy contract is harder to wire than a clean one.

### 5. The static DOM ≠ app logic
We capture the post-load **HTML snapshot** — enough to clone markup (UI), not the
client-side state/handlers behind it. The behavior bundle is the only bridge to
that logic, and per (3) it's weak.

### 6. The gate only grades appearance
`a11y-diff` compares static a11y trees. There is **no functional gate** — nothing
replays a flow and checks it worked — so even a careful agent gets no signal that
features are missing.

### 7. Capture under-collects functional signal
Unauthenticated HF → gated/first-party data endpoints are thin; list endpoints are
sampled (a couple rows), so even with mocks the content would be sparse.

---

## Optimizations (prioritized) — changes to screenshotter

### P0 — make functionality *runnable*, not described (highest leverage)
- **Emit ready-to-use fixtures.** New `api/fixtures/<METHOD>__<templated-path>.json`
  = the captured (redacted, deduped) response bodies, one file per endpoint —
  out of the OpenAPI blob, into importable seed data. Source already exists (the
  body sidecar feeds OpenAPI examples today).
- **Generate a runnable mock server.** From OpenAPI + fixtures, emit a tiny
  self-contained mock (e.g. `mock/server.mjs` Express, or MSW handlers) that serves
  the recorded responses offline. **This is the single biggest unlock** — features
  get a real API to talk to without live/auth/CORS.
- **Emit a scaffold.** `package.json` + a recommended stack + the mock wired + an
  `npm run dev`, so the agent fills *components*, not *infrastructure*. (Tie to the
  existing `--prompt-stack`.)

### P1 — sharpen the behavior contract + reweight the prompt
- **Machine-readable `behaviors.json`** per feature: `{ page, trigger, selector,
  action, outcome, apiCalls:[{method,url,fixtureRef}], beforeState, afterState }`,
  **filtered to non-trivial behaviors** (drop same-origin nav links → put routing in
  a separate "routes" list). Derives from existing `graph.json` + the body sidecar.
- **Reweight `REBUILD-PROMPT.md`:** make *"wire data + implement behaviors"* a
  first-class requirement co-equal with visual fidelity; add a concrete
  **Functional acceptance** checklist (e.g. "search calls `/api/quicksearch` and
  renders results from the fixture"); stop presenting pixel-match as the sole
  acceptance target.
- **Fix path templating** (`/api/{api}` over-collapse, mis-named params) so the API
  contract is clean and directly wireable.

### P2 — force + capture more functional signal
- **Functional gate** (new `flow-diff`/`verify`): replay each recorded action path
  against the rebuilt app and assert the resulting a11y/state matches the golden —
  the functional analogue of `a11y-diff`, so "it works" becomes gradeable in CI.
- **Richer first-party capture:** run authenticated (`--auth`) + deeper interaction
  so gated/data endpoints are present; raise per-endpoint body samples for list
  endpoints so rebuilt lists have enough rows.
- **Link actions ↔ payloads:** in `graph.json`, attach the actual request/response
  body refs that each action fired (we have URLs; add the fixtureRef).

---

## Suggested sequencing
1. **P0** (fixtures + mock server + scaffold) — turns the zip from "UI kit" into a
   "runnable app skeleton with real data." Most of the missing functionality is a
   wiring problem that disappears once there's something to wire to.
2. **P1** (behaviors.json + prompt reweight + templating fix) — tells the agent
   *what* to wire and *makes it a requirement*.
3. **P2** (functional gate + richer capture) — proves it and feeds it better data.

Net: today the bundle answers "what should it look like." After P0–P1 it also
answers "what should it *do*, with what data, verified how."
