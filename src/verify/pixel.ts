// VERIFY GATE — perceptual pixel diff between a captured golden and the rebuild.
// Full-page screenshots differ in height (content length varies), so we compare the
// common top-left region and report the share of differing pixels. Never throws.
import { promises as fs } from 'fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export interface PixelDiffResult {
  /** 0..1 — 1 minus the share of differing pixels in the compared region. */
  score: number;
  /** Share of differing pixels (0..1). */
  mismatch: number;
  width: number;
  height: number;
  /** Where the diff PNG was written, if requested. */
  diffPath?: string;
}

/** Copy the top-left w×h region of a PNG into a fresh same-size PNG. */
function cropTo(src: PNG, w: number, h: number): PNG {
  if (src.width === w && src.height === h) return src;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (src.width * y + x) << 2;
      const di = (w * y + x) << 2;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

/**
 * Compare two PNG files (golden vs. the rebuild's screenshot). Crops both to the
 * shared top-left region, runs pixelmatch, and optionally writes a diff PNG.
 * Returns null when either image can't be read.
 */
export async function pixelDiff(
  goldenPath: string,
  actualPath: string,
  diffPath?: string,
  threshold = 0.1,
): Promise<PixelDiffResult | null> {
  let g: PNG;
  let a: PNG;
  try {
    g = PNG.sync.read(await fs.readFile(goldenPath));
    a = PNG.sync.read(await fs.readFile(actualPath));
  } catch {
    return null;
  }
  const w = Math.min(g.width, a.width);
  const h = Math.min(g.height, a.height);
  if (w <= 0 || h <= 0) return null;

  const gc = cropTo(g, w, h);
  const ac = cropTo(a, w, h);
  const diff = new PNG({ width: w, height: h });
  const differing = pixelmatch(gc.data, ac.data, diff.data, w, h, { threshold });
  const total = w * h;
  const mismatch = total > 0 ? differing / total : 1;

  if (diffPath) {
    try {
      await fs.mkdir(diffPath.replace(/\/[^/]+$/, ''), { recursive: true });
      await fs.writeFile(diffPath, PNG.sync.write(diff));
    } catch {
      /* diff PNG is best-effort */
    }
  }
  return { score: 1 - mismatch, mismatch, width: w, height: h, diffPath };
}
