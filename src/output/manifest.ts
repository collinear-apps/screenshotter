// PHASE 0 — capture integrity. OWNED by Lane 0.
// Builds + writes run-manifest.json: a machine-readable record of what was (and
// wasn't) captured this run — per-route ok/error/authState/truncation, plus totals
// and human-readable notes[] summarizing any degradations (throttling, auth
// expiry, retries, truncation).
import { promises as fs } from 'fs';
import path from 'path';
import type { Mode, RouteCaptureRecord, RunManifest } from '../types';

/** Assemble a RunManifest from per-route capture records. */
export function buildManifest(
  site: string,
  mode: Mode,
  startedAtISO: string,
  routes: RouteCaptureRecord[],
): RunManifest {
  const list = Array.isArray(routes) ? routes : [];
  const captured = list.filter((r) => r.ok).length;
  const failed = list.filter((r) => !r.ok).length;
  // "throttled" = routes we backed off / rate-limited on. A 429 status is the
  // canonical signal; retries>0 means we hit a transient (429/5xx/timeout) and
  // recovered, which is also a politeness/degradation signal worth surfacing.
  const throttled = list.filter((r) => r.status === 429 || (r.retries ?? 0) > 0).length;
  const anonymous = list.filter((r) => r.authState === 'anonymous').length;

  const retried = list.filter((r) => (r.retries ?? 0) > 0).length;
  const truncated = list.filter((r) => r.truncated === true).length;
  const serverErrors = list.filter(
    (r) => typeof r.status === 'number' && r.status >= 500,
  ).length;
  const rateLimited = list.filter((r) => r.status === 429).length;

  const notes: string[] = [];
  if (list.length === 0) {
    notes.push('No routes were captured this run.');
  }
  if (failed > 0) {
    notes.push(`${failed} of ${list.length} route(s) failed to capture.`);
  }
  if (anonymous > 0) {
    notes.push(
      `${anonymous} page(s) captured anonymously (no authenticated session detected — ` +
        `session may have expired or the site gated this content).`,
    );
  }
  if (rateLimited > 0) {
    notes.push(`${rateLimited} route(s) hit HTTP 429 (rate limiting) and were backed off.`);
  }
  if (serverErrors > 0) {
    notes.push(`${serverErrors} route(s) returned a 5xx server error.`);
  }
  if (retried > 0) {
    notes.push(`${retried} route(s) required one or more retries before succeeding.`);
  }
  if (truncated > 0) {
    notes.push(
      `${truncated} route(s) were truncated / only partially captured (content may be incomplete).`,
    );
  }

  const manifest: RunManifest = {
    site,
    startedAtISO,
    mode,
    totals: { captured, failed, throttled, anonymous },
    routes: list,
  };
  if (notes.length > 0) manifest.notes = notes;
  return manifest;
}

/** Write the manifest to <outDir>/<mode>/run-manifest.json. Returns the path. */
export async function writeManifest(
  outDir: string,
  mode: Mode,
  manifest: RunManifest,
): Promise<string> {
  const dir = path.join(outDir, mode);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'run-manifest.json');
  await fs.writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
  return file;
}
