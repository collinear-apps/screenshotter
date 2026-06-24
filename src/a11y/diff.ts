// Wave 1 / Agent B — a11y diff + score + gate (pure, side-effect-free).
// flattenAx/flattenAria → ordered AxNodeFlat[]; scoreTrees → similarity + diff;
// gate → pass/fail against a threshold.
import type { A11yDiff, AxNodeFlat } from '../types';

// Defensive bounds so malformed/adversarial input can't blow the stack or memory.
const MAX_DEPTH = 60;
const MAX_NODES = 5000;
// Cap how many surplus nodes we list per side in a diff (the score is exact regardless).
const MAX_DIFF_ITEMS = 200;

/** Coerce an unknown to a trimmed string, tolerating null/undefined/objects. */
function asName(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  return '';
}

/**
 * Roles that are NOT real UI nodes and must be excluded from BOTH flatteners so
 * a `.aria.yaml` golden and a live capture compare apples-to-apples: the synthetic
 * document root, and ARIA-snapshot metadata pseudo-roles ("/url", "/value", …).
 */
function isNonNode(role: string): boolean {
  return role.startsWith('/') || role === 'WebArea' || role === 'RootWebArea';
}

/** Coerce an unknown role to a string (empty when absent). */
function asRole(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/**
 * AX JSON tree → ordered AxNodeFlat[] via pre-order DFS.
 * Tolerates arbitrary/unknown input shapes; returns [] on garbage.
 * Node shape: { role?, name?, value?, children?: [] }.
 */
export function flattenAx(axJson: unknown): AxNodeFlat[] {
  const out: AxNodeFlat[] = [];

  // Some captures wrap the tree, e.g. { nodes: [...] } or { tree: {...} }.
  // Accept the raw root, an array of roots, or a couple of common wrappers.
  let root: unknown = axJson;
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    const obj = root as Record<string, unknown>;
    if (obj.role === undefined && obj.children === undefined) {
      if (Array.isArray(obj.nodes)) root = obj.nodes;
      else if (obj.tree !== undefined) root = obj.tree;
      else if (obj.root !== undefined) root = obj.root;
    }
  }

  const visit = (node: unknown, depth: number): void => {
    if (out.length >= MAX_NODES) return;
    if (depth > MAX_DEPTH) return;
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const child of node) {
        if (out.length >= MAX_NODES) return;
        visit(child, depth);
      }
      return;
    }

    const obj = node as Record<string, unknown>;
    const role = asRole(obj.role);

    // Skip role-less nodes and the synthetic document root (WebArea/RootWebArea),
    // and ARIA-snapshot metadata pseudo-roles like "/url" — they're not real UI
    // nodes and must be excluded consistently so both flatteners agree.
    const skip = role === '' || isNonNode(role);
    if (!skip) {
      out.push({ role, name: asName(obj.name), depth });
    }

    const children = obj.children;
    if (Array.isArray(children)) {
      // If we skipped this node, keep children at the same depth so a missing
      // wrapper doesn't shift the whole subtree.
      const childDepth = skip ? depth : depth + 1;
      for (const child of children) {
        if (out.length >= MAX_NODES) return;
        visit(child, childDepth);
      }
    }
  };

  try {
    visit(root, 0);
  } catch {
    return [];
  }
  return out;
}

/** Unescape a Playwright ARIA-snapshot quoted name (handles \" and \\). */
function unescapeAriaName(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      out += s[i + 1];
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Playwright ARIA snapshot YAML → ordered AxNodeFlat[], parsed line-by-line
 * (no YAML dep). Lenient: never throws; returns [] on failure.
 */
export function flattenAria(yaml: string): AxNodeFlat[] {
  if (typeof yaml !== 'string' || yaml.length === 0) return [];
  const out: AxNodeFlat[] = [];

  try {
    const lines = yaml.split(/\r?\n/);
    for (const rawLine of lines) {
      if (out.length >= MAX_NODES) break;

      // Count leading spaces (tabs treated as 2 spaces, defensively).
      let spaces = 0;
      let idx = 0;
      while (idx < rawLine.length) {
        const c = rawLine[idx];
        if (c === ' ') spaces += 1;
        else if (c === '\t') spaces += 2;
        else break;
        idx++;
      }

      let content = rawLine.slice(idx);
      // Skip blank lines and structural artifacts (document markers, list-only lines).
      if (content === '' || content === '-' || content === '---' || content === '...') {
        continue;
      }

      // Strip a single leading "- " list marker.
      if (content.startsWith('- ')) {
        content = content.slice(2);
      } else if (content.startsWith('-')) {
        // "-" with no following content already handled; "-foo" is unusual but tolerate.
        content = content.slice(1);
      }
      content = content.trim();
      if (content === '') continue;

      const depth = Math.floor(spaces / 2);

      // Extract the quoted name, if any (the first quoted span).
      let name = '';
      let roleEnd = content.length;
      const firstQuote = content.indexOf('"');
      if (firstQuote !== -1) {
        roleEnd = firstQuote;
        // Find the closing unescaped quote.
        let close = -1;
        for (let i = firstQuote + 1; i < content.length; i++) {
          if (content[i] === '"' && content[i - 1] !== '\\') {
            close = i;
            break;
          }
        }
        if (close !== -1) {
          name = unescapeAriaName(content.slice(firstQuote + 1, close));
        } else {
          // Unterminated quote: take the rest as the name.
          name = unescapeAriaName(content.slice(firstQuote + 1));
        }
      }

      // Role = the token before the first of: '"', ':', '[' — whichever comes first.
      const colonIdx = content.indexOf(':');
      const bracketIdx = content.indexOf('[');
      const candidates = [roleEnd];
      if (colonIdx !== -1) candidates.push(colonIdx);
      if (bracketIdx !== -1) candidates.push(bracketIdx);
      const roleCut = Math.min(...candidates);
      const role = content.slice(0, roleCut).trim();

      // Skip lines that yielded no role, and ARIA metadata pseudo-roles like
      // "/url" (kept consistent with flattenAx so goldens & live captures agree).
      if (role === '' || isNonNode(role)) continue;

      out.push({ role, name, depth });
    }
  } catch {
    return [];
  }

  return out;
}

/** Identity signature for a node — depth is intentionally excluded (robust to wrappers). */
function signature(n: AxNodeFlat): string {
  return `${n.role} ${n.name}`;
}

function countSignatures(nodes: AxNodeFlat[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of nodes) {
    const sig = signature(n);
    m.set(sig, (m.get(sig) ?? 0) + 1);
  }
  return m;
}

/**
 * Multiset-aware similarity (Dice coefficient over node signatures) plus the
 * surplus added/removed nodes. `changed` is always [] for the multiset model.
 */
export function scoreTrees(expected: AxNodeFlat[], actual: AxNodeFlat[]): A11yDiff {
  const exp = Array.isArray(expected) ? expected : [];
  const act = Array.isArray(actual) ? actual : [];

  if (exp.length === 0 && act.length === 0) {
    return { score: 1, added: [], removed: [], changed: [] };
  }

  const expCounts = countSignatures(exp);
  const actCounts = countSignatures(act);

  let intersection = 0;
  for (const [sig, expCount] of expCounts) {
    const actCount = actCounts.get(sig) ?? 0;
    intersection += Math.min(expCount, actCount);
  }

  const rawScore = (2 * intersection) / (exp.length + act.length);
  const score = Math.round(rawScore * 1000) / 1000;

  // removed: expected instances beyond what actual has, in expected's order.
  const removed: AxNodeFlat[] = [];
  const removedQuota = new Map<string, number>();
  for (const [sig, expCount] of expCounts) {
    const actCount = actCounts.get(sig) ?? 0;
    if (expCount > actCount) removedQuota.set(sig, expCount - actCount);
  }
  for (const n of exp) {
    if (removed.length >= MAX_DIFF_ITEMS) break;
    const sig = signature(n);
    const remaining = removedQuota.get(sig);
    if (remaining && remaining > 0) {
      removed.push(n);
      removedQuota.set(sig, remaining - 1);
    }
  }

  // added: actual instances beyond what expected has, in actual's order.
  const added: AxNodeFlat[] = [];
  const addedQuota = new Map<string, number>();
  for (const [sig, actCount] of actCounts) {
    const expCount = expCounts.get(sig) ?? 0;
    if (actCount > expCount) addedQuota.set(sig, actCount - expCount);
  }
  for (const n of act) {
    if (added.length >= MAX_DIFF_ITEMS) break;
    const sig = signature(n);
    const remaining = addedQuota.get(sig);
    if (remaining && remaining > 0) {
      added.push(n);
      addedQuota.set(sig, remaining - 1);
    }
  }

  return { score, added, removed, changed: [] };
}

/**
 * Gate the actual tree against the expected one. `exact` requires a perfect
 * match (score == 1); otherwise the score must meet `threshold`.
 */
export function gate(
  expected: AxNodeFlat[],
  actual: AxNodeFlat[],
  threshold: number,
  exact: boolean,
): { pass: boolean; diff: A11yDiff } {
  const diff = scoreTrees(expected, actual);
  const pass = exact ? diff.score >= 1 - 1e-9 : diff.score >= threshold;
  return { pass, diff };
}
