// Owned by Wave 1 / Agent A (a11y capture).
// captureA11y returns the accessibility tree as both an AX JSON tree
// (page.accessibility.snapshot) and an ARIA YAML snapshot (locator.ariaSnapshot),
// with accessible names normalized so dynamic text doesn't churn the gate.
import type { Page } from 'playwright';
import { normalizeText } from '../extract/normalize';

export interface A11yCapture {
  /** page.accessibility.snapshot() tree (normalized names). */
  axJson: unknown;
  /** locator('body').ariaSnapshot() YAML (normalized names). */
  ariaYaml: string;
}

// Defensive recursion bound so a pathological/cyclic-shaped tree can't blow the
// stack. Real accessibility trees are nowhere near this deep.
const MAX_AX_DEPTH = 60;

// `page.accessibility.snapshot()` is the legacy AX-tree API. It was dropped from
// the public .d.ts and removed at runtime in newer Playwright, so we reach it
// through a minimal structural type and tolerate it being undefined.
interface AccessibilityHandle {
  snapshot(options?: { interestingOnly?: boolean }): Promise<unknown>;
}

interface AxNode {
  role: string;
  name?: string;
  children?: AxNode[];
}

// Parse an ARIA-snapshot YAML string into a `{ role, name, children }` tree.
// Used as a fallback for the AX JSON when the legacy accessibility API is gone:
// it yields the same shape (role + accessible name + nesting) from the data the
// ARIA snapshot already exposes. Lines look like:
//   - heading "Models" [level=1]
//   - navigation "Main":
//       - link "Datasets":
//           - /url: /datasets
// Indentation encodes the tree; "- /url: ..." style metadata lines are skipped.
function axTreeFromAriaYaml(yaml: string): AxNode {
  const root: AxNode = { role: 'WebArea', children: [] };
  // stack of [indent, node] for the nearest ancestor at each indent level.
  const stack: Array<{ indent: number; node: AxNode }> = [
    { indent: -1, node: root },
  ];

  const lineRe = /^(\s*)-\s+([A-Za-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?/;

  for (const rawLine of yaml.split('\n')) {
    if (!rawLine.trim()) continue;
    const m = lineRe.exec(rawLine);
    if (!m) continue; // metadata like "- /url: ..." or "- text: ..."
    const indent = m[1].length;
    const role = m[2];
    const name = m[3] != null ? m[3].replace(/\\(.)/g, '$1') : undefined;

    const node: AxNode = { role };
    if (name != null) node.name = name;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].node;
    (parent.children ??= []).push(node);
    stack.push({ indent, node });
  }

  return root;
}

/**
 * Clone an AX snapshot node, normalizing its accessible `name` (and `value` when
 * it's a string) so dynamic text (counts/dates/ids/tokens) becomes placeholders.
 * Recurses into `children`. Other primitive fields are preserved as-is.
 */
function normalizeAxNode(node: unknown, depth = 0): unknown {
  if (node === null || typeof node !== 'object') {
    return node;
  }
  if (depth >= MAX_AX_DEPTH) {
    // Bail out defensively; drop deeper subtree rather than recurse unbounded.
    return Array.isArray(node) ? [] : {};
  }

  if (Array.isArray(node)) {
    return node.map((child) => normalizeAxNode(child, depth + 1));
  }

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(src)) {
    if (key === 'children' && Array.isArray(val)) {
      out.children = val.map((child) => normalizeAxNode(child, depth + 1));
    } else if ((key === 'name' || key === 'value') && typeof val === 'string') {
      out[key] = normalizeText(val);
    } else {
      out[key] = val;
    }
  }

  return out;
}

/**
 * Capture the page's accessibility tree in two complementary forms, with all
 * accessible names normalized. Each representation is computed independently so a
 * failure in one doesn't drop the other.
 */
export async function captureA11y(page: Page): Promise<A11yCapture> {
  // ARIA YAML first: it doubles as the source for the AX-tree fallback below.
  // rawYaml stays un-normalized for that parse; ariaYaml is the normalized form.
  let rawYaml = '';
  let ariaYaml = '';
  try {
    let yaml: string;
    try {
      yaml = await page.locator('body').ariaSnapshot();
    } catch {
      yaml = await page.locator(':root').ariaSnapshot().catch(() => '');
    }
    rawYaml = yaml;
    ariaYaml = normalizeText(yaml);
  } catch {
    rawYaml = '';
    ariaYaml = '';
  }

  let axJson: unknown = {};
  try {
    const accessibility = (page as unknown as { accessibility?: AccessibilityHandle })
      .accessibility;
    if (accessibility && typeof accessibility.snapshot === 'function') {
      // Legacy API present (older Playwright): use it directly.
      const ax = await accessibility.snapshot({ interestingOnly: true });
      axJson = ax == null ? {} : normalizeAxNode(ax);
    } else if (rawYaml) {
      // Modern Playwright removed page.accessibility — derive the same
      // { role, name, children } tree from the ARIA snapshot instead.
      axJson = normalizeAxNode(axTreeFromAriaYaml(rawYaml));
    } else {
      axJson = {};
    }
  } catch {
    axJson = {};
  }

  return { axJson, ariaYaml };
}
