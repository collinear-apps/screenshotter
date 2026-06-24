// Owned by Wave 1 / Agent D (typography + output).
import type { Mode } from '../types';

const SLUG_MAX = 60;

/** Ensures a URL string has a scheme so `new URL` can parse it. */
function withScheme(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

/** "https://huggingface.co" -> "huggingface" (first hostname label). */
export function siteNameFromUrl(url: string): string {
  let host: string;
  try {
    host = new URL(withScheme(url)).hostname;
  } catch {
    host = url;
  }
  host = host.replace(/^www\./i, '');
  const firstLabel = host.split('.')[0] ?? '';
  return sanitizeSegment(firstLabel);
}

/** Lowercases + replaces unsafe chars so a string is filesystem-safe. */
export function sanitizeSegment(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'page';
}

/** A short, stable slug derived from a URL's path (for the filename tail). */
export function slugForUrl(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(withScheme(url)).pathname;
  } catch {
    pathname = url;
  }

  const segments = pathname
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0)
    .map((seg) => sanitizeSegment(seg))
    .filter((seg) => seg.length > 0 && seg !== 'page');

  let slug = segments.length === 0 ? 'home' : segments.join('-');
  if (slug.length > SLUG_MAX) {
    slug = slug.slice(0, SLUG_MAX).replace(/-+$/g, '');
  }
  return slug.length > 0 ? slug : 'home';
}

/**
 * Relative path of a screenshot within outDir, clustered by category:
 *   e.g. "web/models/01-models-gpt2.png"
 * `index` is the 1-based position WITHIN its category (caller assigns it).
 */
export function screenshotRelPath(
  mode: Mode,
  category: string,
  index: number,
  url: string,
): string {
  return `${mode}/${sanitizeSegment(category)}/${String(index).padStart(2, '0')}-${slugForUrl(url)}.png`;
}
