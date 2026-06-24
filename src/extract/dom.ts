// Owned by Wave 1 / Agent J (DOM dump) + Lane 2 (Phase 2: scrub + README).
// captureDom returns the rendered HTML of the current page (post-JS).
// Kept a thin wrapper over Playwright's page.content() so it's easy to swap
// (e.g. for a serialized outerHTML or a sanitized snapshot) later.
import type { Page } from 'playwright';
import type { ExtractConfig } from '../types';

/**
 * Secret-shaped substrings to scrub from saved HTML when cfg.extract.scrubHtml.
 * These match VALUE shapes (not key names) so embedded tokens/keys that leaked
 * into server-rendered HTML / inline JSON never land in the bundle.
 * Conservative on purpose — only high-confidence token shapes are replaced.
 */
const SECRET_PATTERNS: { re: RegExp; label: string }[] = [
  // JWTs: three base64url segments.
  { re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, label: 'JWT' },
  // Common provider key prefixes (hf_, sk-, ghp_, github_pat_, AKIA…, xox…, AIza…).
  { re: /\bhf_[A-Za-z0-9]{20,}/g, label: 'HF_TOKEN' },
  { re: /\bsk-[A-Za-z0-9-_]{20,}/g, label: 'API_KEY' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, label: 'GITHUB_TOKEN' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, label: 'GITHUB_PAT' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'AWS_KEY' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g, label: 'GOOGLE_KEY' },
  { re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g, label: 'SLACK_TOKEN' },
  // Bearer tokens in inline strings.
  { re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g, label: 'BEARER' },
  // "key"/"token"/"secret"/"password" : "longvalue" in inline JSON.
  {
    re: /("(?:api[_-]?key|access[_-]?token|secret|client[_-]?secret|password|refresh[_-]?token)"\s*:\s*")[^"]{8,}(")/gi,
    label: 'SECRET',
  },
];

/**
 * Replace secret-shaped substrings with a redaction placeholder. Pure string op,
 * never throws. Returns the input unchanged when nothing matches.
 */
export function scrubSecretsFromHtml(html: string): string {
  let out = html;
  for (const { re, label } of SECRET_PATTERNS) {
    // The SECRET JSON pattern has capture groups (key + closing quote) to preserve
    // structure; others are whole-match replacements.
    if (label === 'SECRET') {
      out = out.replace(re, `$1[REDACTED_${label}]$2`);
    } else {
      out = out.replace(re, `[REDACTED_${label}]`);
    }
  }
  return out;
}

/**
 * Returns the rendered HTML of the current page. When `cfg.extract.scrubHtml` is
 * on, secret-shaped substrings are redacted before the HTML is returned/saved.
 * The optional `cfg` keeps existing one-arg callers working unchanged.
 */
export async function captureDom(page: Page, cfg?: ExtractConfig): Promise<string> {
  const html = await page.content();
  if (cfg?.scrubHtml) return scrubSecretsFromHtml(html);
  return html;
}

/** Raw + rendered README/markdown extracted from a detail page. */
export interface ReadmeExtract {
  /** Plain-text content of the README/markdown region. */
  text: string;
  /** The rendered HTML of the README region (inner HTML, scrubbed if enabled). */
  html: string;
  /** CSS selector the region was found at (provenance). */
  selector: string;
}

/**
 * Extract a README / rendered-markdown region from a detail page (model/dataset/
 * repo pages). Looks for the conventional containers sites use to render markdown
 * (`.markdown`, `[class*="prose"]`, `article`, `#readme`, …) and returns the raw
 * text + rendered inner HTML of the largest such region. Returns null when no
 * markdown region is found. Best-effort; never throws.
 */
export async function extractReadme(
  page: Page,
  cfg?: ExtractConfig,
): Promise<ReadmeExtract | null> {
  let found: { text: string; html: string; selector: string } | null = null;
  try {
    found = await page.evaluate(() => {
      const SELECTORS = [
        '#readme',
        '[data-target="readme"]',
        '.markdown-body',
        '.markdown',
        'article .prose',
        '[class*="prose" i]',
        '[class*="markdown" i]',
        'article',
        'main article',
        '.model-card',
        '.dataset-card',
      ];
      const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
      let best: { text: string; html: string; selector: string; score: number } | null = null;
      for (const sel of SELECTORS) {
        let nodes: Element[] = [];
        try {
          nodes = Array.from(document.querySelectorAll(sel));
        } catch {
          continue;
        }
        for (const node of nodes) {
          const he = node as HTMLElement;
          const r = he.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const text = collapse(he.innerText || he.textContent || '');
          // A README region should have meaningful prose + structure.
          const headings = he.querySelectorAll('h1,h2,h3,h4,h5,h6,pre,code,ul,ol').length;
          if (text.length < 120) continue;
          const score = text.length + headings * 200;
          if (!best || score > best.score) {
            best = { text, html: he.innerHTML, selector: sel, score };
          }
        }
        if (best) break; // first selector tier that yields a region wins
      }
      if (!best) return null;
      // Cap sizes so a huge page doesn't bloat the sidecar.
      const MAX_TEXT = 200_000;
      const MAX_HTML = 500_000;
      return {
        text: best.text.length > MAX_TEXT ? best.text.slice(0, MAX_TEXT) : best.text,
        html: best.html.length > MAX_HTML ? best.html.slice(0, MAX_HTML) : best.html,
        selector: best.selector,
      };
    });
  } catch {
    return null;
  }
  if (!found) return null;
  const html = cfg?.scrubHtml ? scrubSecretsFromHtml(found.html) : found.html;
  const text = cfg?.scrubHtml ? scrubSecretsFromHtml(found.text) : found.text;
  return { text, html, selector: found.selector };
}
