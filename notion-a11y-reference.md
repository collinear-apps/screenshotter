# Notion a11y reference — extracted from `app-screenshots.zip`

Source: `https://app.notion.com/p/Python-getting-started-caa562e9604543519360ad1fa6620b09`
**Scope caveat:** this is the **logged-out public page reader**. It does NOT contain the authenticated app (sidebar, editor floating toolbar, slash menu, database views, settings). Treat this as the a11y spec for the **public page-render surface only**. For full-app parity you need a second capture while signed in.

---

## 1. Landmark / role structure (the ARIA spine to replicate)

From `*.aria.yaml` + `*.a11y.json` (Playwright accessibility tree):

```
link "Skip to content" (→ #main)        ← skip link, first focusable
banner (role=banner)                      ← the top "almost there, sign up" bar
  text  "You're almost there — sign up to start building in Notion today."
  button "Sign up or login"
  button "🐍 Python getting started" [disabled]   ← page-title button, disabled in public view
  button "Comments"        [expanded] when panel open
  button "More actions"    [expanded] when menu open
main (role=main, id=main)
  group [disabled]          ← the whole page body is a disabled group (read-only public)
    img     "Page icon": 🐍
    heading "Python getting started" [level=1]
    note (role=note)         ← callout block = role="note"
      img "Callout icon": 👉🏼
      text ...
    text ...                 ← paragraphs are role=text
    figure                   ← code blocks = role="figure", name = code contents
    heading "..." [level=4]  ← H2/H3 in the doc render as level=4
    link "..." [disabled]    ← inline links carry /url, disabled in public view
status (role=status)         ← aria-live polite region (toasts)
alert  (role=alert)          ← aria-live assertive region
```

### Role mapping — Notion block → ARIA role (use these exact mappings)
| Notion block | ARIA role | Notes |
|---|---|---|
| Page body wrapper | `group` | `[disabled]` in read-only/public |
| Page title | `heading level=1` + an `img "Page icon"` sibling | |
| Paragraph | `text` | not `paragraph` |
| Callout | `note` | with child `img "Callout icon"` |
| Code block | `figure` | accessible name = the code text |
| Heading (any sub-level) | `heading level=4` | Notion flattens H2/H3 to level 4 |
| Inline link | `link` + `/url` | |
| Toggle / collapsible | `button [expanded]` | expanded state toggles |
| Toasts | `status` (polite) + `alert` (assertive) | always present, empty until used |

### Required landmarks & global a11y affordances
- **Skip link** `"Skip to content"` → `#main`, must be the first focusable element.
- `role="banner"` topbar, `role="main"` with `id="main"`.
- Persistent `role="status"` and `role="alert"` live regions for notifications.
- Buttons that open panels/menus expose `aria-expanded` (`[expanded]` in the tree): Comments, More actions.
- Accessible names come from visible text or `aria-label`; icons use `role="img"` + a name ("Page icon", "Callout icon").

---

## 2. Interactive state styling (focus/hover/active) — from `element-states.json`

The single most important parity detail is the **focus ring**. Notion's button focus state:

```css
/* :focus-visible on a topbar button */
box-shadow:
  rgb(248,248,247) 0 0 0 2px,     /* inner spacer ring (page bg) */
  rgb(35,131,226)  0 0 0 4px,     /* the blue focus ring  #2383E2 */
  rgba(255,255,255,0.25) 0 0 0 6px;
outline: 2px solid transparent;    /* transparent outline for forced-colors mode */
```

| State | Delta |
|---|---|
| hover (button) | bg → `rgba(42,28,0,0.07)` |
| active (button) | bg → `rgba(42,28,0,~0.11–0.14)` |
| focus (button) | the 3-layer blue box-shadow above + transparent 2px outline |
| disabled | no style delta; just `[disabled]` in a11y tree + non-focusable |

Focus accent color = **`#2383E2`** (rgb 35,131,226). Use it for every focus ring.

---

## 3. Design tokens (from `design-tokens.md` / `typography.md`)

| Token | Value |
|---|---|
| Primary text | `rgb(44,44,43)` `#2C2C2B` |
| Red / danger | `rgb(235,87,87)` `#EB5757` |
| Secondary/muted text | `rgb(125,122,117)`, `rgb(142,139,134)` |
| Link/pink accent | `rgb(153,0,85)` |
| Orange (callout) | `rgb(238,153,0)` |
| Focus blue | `rgb(35,131,226)` `#2383E2` |
| Hover bg | `rgba(135,131,120,0.15)` |
| Page bg | `rgb(255,255,255)` / `rgb(249,248,247)` |
| Body font | `ui-sans-serif` |
| Mono font | `SFMono-Regular` |
| Base font size | `16px` (body), `13.6px` (small/caption, weight 700) |
| Radii | `4px`, `6px` (most common) |

### Type scale
| Role | Size | Weight | Line-height |
|---|---|---|---|
| h1 | 40px | 700 | 48px |
| h4 | 20px | 600 | 26px |
| body / link | 16px | 400 | 24px |
| caption span | 13.6px | 700 | 20.4px |

---

## 4. Behaviors captured (from `interactions.md` / `behaviors.json`)

| Trigger | Role | Outcome |
|---|---|---|
| Comments | button | opens modal/panel, button → `aria-expanded` |
| More actions | button | opens menu (`menuitem`s, e.g. Cookie settings, Report page) |
| See all | button | DOM update (loads comment list) |
| Cookie settings | menuitem | DOM update |
| Report page | menuitem | destructive (skipped in capture) |

"More actions" menu items are exposed as `role="menuitem"`.

---

## 5. Other useful artifacts in the bundle (not a11y, but reusable)
| File | Use |
|---|---|
| `web/screenshots/p/*.normalized.html` | cleaned DOM you can diff your clone against |
| `web/css-vars.json` (72KB) | full extracted CSS custom-property set |
| `web/api/mock/server.mjs` + `routes.json` | runnable mock of Notion's API |
| `web/entity-graph.json` | seed data (the page's content graph) |
| `web/api/openapi/app.notion.com.json` | inferred OpenAPI for the real endpoints |
| `web/REBUILD-PROMPT.md` | the generator's own rebuild instructions |
| `web/qc/qc-tasks.{json,md}` | QC checklist tasks for parity |

---

## 6. How to use this for the Angular port's a11y gate
1. Encode the **role spine in §1** as the expected Playwright `toMatchAriaSnapshot` for the page-reader view — it's framework-agnostic, so it validates the Angular DOM directly.
2. Replicate the **focus ring in §2** (`#2383E2` 3-layer box-shadow) on every focusable control — this is the most visible a11y parity item.
3. Wire `@axe-core/playwright` and assert zero violations on the rendered page.
4. **Get a signed-in capture** to extend this to sidebar / editor toolbar / slash menu / DB views, which are the hard a11y surfaces and are absent here.
```
