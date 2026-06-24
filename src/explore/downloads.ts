// OWNED by Wave 1 / Agent B (downloads sink).
// createDownloadSink: attach to each explorer page; on 'download' save the file to
// <mode>/downloads/ (deduped) and track it for per-action correlation.
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import type { Download, Page } from 'playwright';
import type { RunConfig } from '../types';
import { sanitizeSegment } from '../output/naming';

export interface DownloadSink {
  /** Attach the 'download' listener to a page the explorer creates. */
  attach(page: Page): void;
  /** Number of files saved so far. */
  count(): number;
  /** Bundle-root-relative path of the most recently saved file (for action records). */
  lastSaved(): string | undefined;
  /** Write <mode>/downloads/downloads-manifest.json. */
  writeManifest(): Promise<void>;
}

/** Hard ceiling for a single saved download (bytes). */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/** One recorded download in the manifest. */
interface DownloadEntry {
  url: string;
  /** Bundle-root-relative path, e.g. "web/downloads/report-ab12.csv". */
  file: string;
  suggested: string;
  bytes: number;
}

/** Short, filesystem-safe filename slug that preserves the extension. */
function pickFilename(suggested: string, url: string): string {
  const raw = suggested || 'download';
  const ext = path.extname(raw);
  const stem = ext ? raw.slice(0, -ext.length) : raw;
  const cleanStem = sanitizeSegment(stem);
  // sanitize the extension too (it may carry odd chars / casing).
  const cleanExt = ext ? '.' + sanitizeSegment(ext.replace(/^\./, '')) : '';
  // short content-addressed prefix to dedupe identical names across actions.
  const sha = crypto.createHash('sha1').update(url + '|' + raw).digest('hex').slice(0, 4);
  const base = cleanStem && cleanStem !== 'page' ? cleanStem : 'download';
  return `${base}-${sha}${cleanExt}`;
}

export function createDownloadSink(cfg: RunConfig, outDir: string): DownloadSink {
  const dir = path.join(outDir, cfg.mode, 'downloads');
  const entries: DownloadEntry[] = [];
  let lastSavedRel: string | undefined;

  const handle = async (d: Download): Promise<void> => {
    try {
      const url = d.url();
      const suggested = d.suggestedFilename() || 'download';
      const filename = pickFilename(suggested, url);
      const dest = path.join(dir, filename);

      await fs.mkdir(dir, { recursive: true });
      await d.saveAs(dest);

      let bytes = 0;
      try {
        const st = await fs.stat(dest);
        bytes = st.size;
      } catch {
        bytes = 0;
      }

      if (bytes > MAX_DOWNLOAD_BYTES) {
        // Too large — drop it and skip recording.
        await fs.rm(dest, { force: true }).catch(() => {});
        return;
      }

      const rel = `${cfg.mode}/downloads/${filename}`;
      entries.push({ url, file: rel, suggested, bytes });
      lastSavedRel = rel;
    } catch {
      // Best-effort: never throw out of a download handler.
    }
  };

  return {
    attach(page: Page): void {
      page.on('download', (d) => {
        // fire-and-forget; the handler is fully self-contained / guarded.
        void handle(d);
      });
    },
    count(): number {
      return entries.length;
    },
    lastSaved(): string | undefined {
      return lastSavedRel;
    },
    async writeManifest(): Promise<void> {
      await fs.mkdir(dir, { recursive: true });
      const manifest = { count: entries.length, files: entries };
      await fs.writeFile(
        path.join(dir, 'downloads-manifest.json'),
        JSON.stringify(manifest, null, 2),
      );
    },
  };
}
