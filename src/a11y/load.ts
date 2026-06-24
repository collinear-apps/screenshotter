// Owned by Wave 1 / Agent C (a11y tree loader).
// loadTree resolves either side of the gate: a live URL (captured via launchSession
// + captureA11y) or a saved golden file (*.a11y.json or *.aria.yaml).
import { readFile } from 'fs/promises';
import type { AxNodeFlat, Mode } from '../types';
import { buildRunConfig } from '../config';
import { launchSession, closeSession } from '../capture/browser';
import { captureA11y } from './capture';
import { flattenAx, flattenAria } from './diff';

/** True when the input should be captured live rather than read from disk. */
function looksLikeUrl(input: string): boolean {
  return /^https?:\/\//i.test(input) || /^file:\/\//i.test(input) || /^www\./i.test(input);
}

/** Capture a live page's accessibility tree and flatten it. */
async function loadFromUrl(input: string, mode: Mode): Promise<AxNodeFlat[]> {
  const cfg = buildRunConfig({ url: input, mode });
  const session = await launchSession(cfg);
  try {
    const page = await session.context.newPage();
    // Use the scheme-normalized URL so bare "www.…" inputs still navigate.
    await page.goto(cfg.url, { waitUntil: 'load', timeout: 45000 });
    // Short settle so late-rendered content lands; never fatal if it times out.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    const cap = await captureA11y(page);
    // Prefer the structured AX JSON; fall back to ARIA YAML if it yields nothing.
    const ax = flattenAx(cap.axJson);
    if (ax.length > 0) return ax;
    return flattenAria(cap.ariaYaml);
  } finally {
    await closeSession(session);
  }
}

/** Read and flatten a saved golden file, dispatching by extension/content. */
async function loadFromFile(input: string): Promise<AxNodeFlat[]> {
  let text: string;
  try {
    text = await readFile(input, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read a11y file "${input}": ${msg}`);
  }

  const lower = input.toLowerCase();
  if (lower.endsWith('.a11y.json')) {
    return flattenAx(JSON.parse(text));
  }
  if (lower.endsWith('.aria.yaml') || lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    return flattenAria(text);
  }

  // Unknown extension: try JSON first, fall back to treating it as YAML.
  try {
    return flattenAx(JSON.parse(text));
  } catch {
    return flattenAria(text);
  }
}

/**
 * Resolve one side of the a11y gate into a flat node list.
 * - URL-shaped input is captured live (Chromium + captureA11y).
 * - Anything else is treated as a path to a saved golden.
 */
export async function loadTree(input: string, mode: Mode): Promise<AxNodeFlat[]> {
  if (looksLikeUrl(input)) {
    try {
      return await loadFromUrl(input, mode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to capture a11y tree from "${input}": ${msg}`);
    }
  }
  return loadFromFile(input);
}
