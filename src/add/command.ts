// `add` command: capture specific URL(s) with a logged-in session and append them
// to an existing bundle (or create one), then rebuild the zip. Captures into a temp
// dir first so a failure can never corrupt the existing bundle.
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import pc from 'picocolors';
import type { Mode } from '../types';
import { buildRunConfig } from '../config';
import { siteNameFromUrl } from '../output/naming';
import { createZip } from '../output/zip';
import * as pipeline from '../pipeline';
import { mergeBundle } from './merge';

export interface AddOptions {
  into?: string;
  mode: Mode;
  authFile?: string;
  basicAuth?: string;
  loginUrl?: string;
  username?: string;
  password?: string;
  api: boolean;
  zip: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function runAdd(urls: string[], opts: AddOptions): Promise<number> {
  if (!urls || urls.length === 0) {
    console.error('add: provide at least one URL');
    return 2;
  }

  const siteName = siteNameFromUrl(urls[0]);
  const target = opts.into ?? path.join('output', siteName);
  const targetModeDir = path.join(target, opts.mode);
  const targetExists = await exists(targetModeDir);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'screenshotter-add-'));
  try {
    // Capture the explicit URL(s) into the temp dir using the saved session.
    const cfg = buildRunConfig({
      url: urls[0],
      mode: opts.mode,
      pages: urls,
      out: tmp,
      extract: true,
      api: opts.api,
      prompt: false,
      zip: false,
      authFile: opts.authFile,
      basicAuth: opts.basicAuth,
      loginUrl: opts.loginUrl,
      username: opts.username,
      password: opts.password,
    });

    const result = await pipeline.run(cfg, { info: (m) => console.log(m) });
    if (result.captured === 0) {
      console.error(pc.red('add: nothing captured (page load failed?).'));
      return 1;
    }

    const tmpModeDir = path.join(tmp, opts.mode);
    if (!targetExists) {
      await fs.mkdir(target, { recursive: true });
      await fs.cp(tmpModeDir, targetModeDir, { recursive: true });
      console.log(
        pc.green(`Created bundle ${target} with ${result.captured} page(s).`),
      );
    } else {
      const merged = await mergeBundle(tmpModeDir, targetModeDir);
      console.log(
        pc.green(
          `Added ${merged.pages} page(s)` +
            (opts.api ? `, +${merged.fixtures} fixture(s) (mock refreshed)` : '') +
            ` → ${targetModeDir}`,
        ),
      );
    }

    if (opts.zip) {
      const zipPath = await createZip(target, siteName);
      console.log(pc.green(`Re-zipped → ${zipPath}`));
    }
    console.log(
      pc.dim(
        'Note: REBUILD-PROMPT.md / design-tokens / behaviors / qc reflect the ' +
          'original run — re-run a full capture (or `qc-tasks`) to refresh them.',
      ),
    );
    return 0;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
