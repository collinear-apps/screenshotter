// Merge a freshly-captured temp bundle's <mode> tree into an existing bundle's
// <mode> tree: append page artifacts with continued numbering (no clobber), merge
// API fixtures, and refresh the mock from the union. Used by the `add` command.
import { promises as fs } from 'fs';
import path from 'path';
import type { ApiFixture } from '../types';
import { writeMockServer } from '../api/mockserver';

/** Subdirectories under <mode> that are NOT page categories. */
const NON_PAGE_DIRS = new Set(['api', 'explore', 'downloads', 'qc']);

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Next free 1-based index in a category dir (scans `NN-` prefixes). */
async function nextIndex(catDir: string): Promise<number> {
  let max = 0;
  try {
    for (const f of await fs.readdir(catDir)) {
      const m = /^(\d+)-/.exec(f);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch {
    // dir doesn't exist yet → start at 1
  }
  return max + 1;
}

export interface MergeResult {
  pages: number;
  fixtures: number;
}

/**
 * Merge `tmpModeDir` (a temp bundle's <mode> dir) into `targetModeDir` (the
 * existing bundle's <mode> dir). Page files are renumbered to continue the
 * target's per-category sequence so nothing is overwritten.
 */
export async function mergeBundle(
  tmpModeDir: string,
  targetModeDir: string,
): Promise<MergeResult> {
  let pages = 0;

  // 1. Page categories: copy each captured page (a group of files sharing an
  //    `NN-` prefix) into the target category at the NEXT free index.
  const entries = await fs.readdir(tmpModeDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || NON_PAGE_DIRS.has(e.name)) continue;
    const tmpCat = path.join(tmpModeDir, e.name);
    const tgtCat = path.join(targetModeDir, e.name);
    await fs.mkdir(tgtCat, { recursive: true });

    // Group the temp category's files by their leading NN (= one page).
    const byNN = new Map<string, string[]>();
    for (const f of await fs.readdir(tmpCat)) {
      const m = /^(\d+)-/.exec(f);
      if (!m) continue;
      const nn = m[1];
      const group = byNN.get(nn) ?? [];
      group.push(f);
      byNN.set(nn, group);
    }

    // Stable order so multi-page adds renumber deterministically.
    for (const nn of [...byNN.keys()].sort()) {
      const idx = await nextIndex(tgtCat); // re-read each page → accounts for prior copies
      const newNN = String(idx).padStart(2, '0');
      for (const f of byNN.get(nn) as string[]) {
        const rest = f.slice(nn.length + 1); // strip "NN-"
        await fs.copyFile(path.join(tmpCat, f), path.join(tgtCat, `${newNN}-${rest}`));
      }
      pages++;
    }
  }

  // 2. API fixtures: copy new ones in (same path → refreshed with newer data).
  let fixturesAdded = 0;
  const tmpFix = path.join(tmpModeDir, 'api', 'fixtures');
  const tgtFix = path.join(targetModeDir, 'api', 'fixtures');
  if (await exists(tmpFix)) {
    await fs.mkdir(tgtFix, { recursive: true });
    for (const f of await fs.readdir(tmpFix)) {
      await fs.copyFile(path.join(tmpFix, f), path.join(tgtFix, f));
      fixturesAdded++;
    }
  }

  // 3. Refresh the mock from the UNION of fixtures now in the target.
  if (await exists(tgtFix)) {
    const all: ApiFixture[] = [];
    for (const f of await fs.readdir(tgtFix)) {
      if (!f.endsWith('.json')) continue;
      try {
        const obj = JSON.parse(await fs.readFile(path.join(tgtFix, f), 'utf8')) as ApiFixture;
        obj.file = f;
        all.push(obj);
      } catch {
        // skip an unreadable fixture
      }
    }
    if (all.length > 0) {
      await writeMockServer(all, path.join(targetModeDir, 'api', 'mock'));
    }
  }

  return { pages, fixtures: fixturesAdded };
}
