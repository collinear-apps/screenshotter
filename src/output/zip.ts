// Owned by Wave 1 / Agent D (typography + output).
import archiver from 'archiver';
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import type { Mode } from '../types';

/** Creates outDir if missing; clears ONLY the tool's own previous contents. */
export async function ensureCleanOutDir(outDir: string): Promise<void> {
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });
}

/** Writes typography.md at outDir/<mode>/typography.md; returns its path. */
export async function writeTypographyFile(
  outDir: string,
  mode: Mode,
  markdown: string,
): Promise<string> {
  const modeDir = path.join(outDir, mode);
  await fsp.mkdir(modeDir, { recursive: true });
  const filePath = path.join(modeDir, 'typography.md');
  await fsp.writeFile(filePath, markdown, 'utf8');
  return path.resolve(filePath);
}

/** Zips outDir contents into "<siteName>-screenshots.zip" at CWD; returns zip path. */
export async function createZip(outDir: string, siteName: string): Promise<string> {
  const zipPath = path.resolve(process.cwd(), `${siteName}-screenshots.zip`);

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    // Resolve only once the output stream is fully flushed and closed.
    output.on('close', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    output.on('error', fail);
    archive.on('error', fail);
    archive.on('warning', (err) => {
      // Treat ENOENT warnings as non-fatal; surface anything else.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') fail(err);
    });

    archive.pipe(output);
    // `false` => place outDir's contents at the zip root (no wrapping folder).
    archive.directory(outDir, false);
    archive.finalize().catch(fail);
  });

  return zipPath;
}
