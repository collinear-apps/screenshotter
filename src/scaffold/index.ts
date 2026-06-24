// PHASE 4 — runnable handoff. OWNED by Lane 4.
// Emits a runnable frontend scaffold into the bundle so the rebuild starts from a
// compiling Vite+React+TS skeleton already wired to the mock API:
//   - package.json (vite + react + ts, tiny + generic)
//   - src/routes.ts — a router spine enumerating every captured route
//   - src/tokens.css — CSS variables from the captured design tokens
//   - src/apiClient.ts — fetch wrapper reading import.meta.env.VITE_API_BASE_URL,
//     with a per-host → mock-base resolver (hosts.json)
//   - .env.example (VITE_API_BASE_URL=http://localhost:8787)
//   - hosts.json — every captured API host → the single mock base
// Everything is GUARDED behind cfg.scaffold by the caller; this module just writes.
import { promises as fs } from 'fs';
import path from 'path';
import type { BundleIndex, DesignTokens, RunConfig } from '../types';

export interface ScaffoldInput {
  /** Absolute <outDir>/<mode> directory the scaffold is written under. */
  bundleDir: string;
  mode: string;
  cfg: RunConfig;
  index: BundleIndex;
  /** Hosts observed during API capture (for the host → mock-base map). */
  apiHosts: string[];
  /** Aggregated design tokens, when extraction ran (drives tokens.css). */
  tokens?: DesignTokens;
}

export interface ScaffoldResult {
  /** Relative paths (within <outDir>/<mode>) of files written. */
  files: string[];
}

/** Default local mock base the scaffold points at (matches the generated mock server). */
const MOCK_BASE = 'http://localhost:8787';

/** Strip a leading `var(` token value down to its raw value for CSS emission. */
function cssVarSafe(value: string): string {
  return (value ?? '').replace(/\r?\n/g, ' ').replace(/;/g, ' ').trim();
}

/** A stable, lower-kebab CSS-var name for a ranked token at index i. */
function tokenVarLines(prefix: string, values: { value: string }[] | undefined, cap: number): string[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  return values
    .slice(0, cap)
    .map((v, i) => `  --${prefix}-${i + 1}: ${cssVarSafe(v.value)};`)
    .filter((line) => !/:\s*;$/.test(line));
}

/** Build src/tokens.css from the captured design tokens (or a minimal default). */
function renderTokensCss(tokens?: DesignTokens): string {
  const L: string[] = [];
  L.push('/* Design tokens — generated from real computed styles by screenshotter. */');
  L.push('/* Map these to your framework theme (Tailwind, CSS, etc.). */');
  L.push(':root {');
  if (tokens) {
    L.push(...tokenVarLines('color', tokens.colors, 16));
    L.push(...tokenVarLines('bg', tokens.backgrounds, 12));
    L.push(...tokenVarLines('border', tokens.borderColors, 8));
    L.push(...tokenVarLines('radius', tokens.radii, 8));
    L.push(...tokenVarLines('shadow', tokens.shadows, 8));
    L.push(...tokenVarLines('space', tokens.spacing, 12));
    L.push(...tokenVarLines('font', tokens.fontFamilies, 6));
    L.push(...tokenVarLines('text', tokens.fontSizes, 12));
  }
  if (L[L.length - 1] === ':root {') {
    L.push('  --color-1: #000;');
  }
  L.push('}');
  L.push('');
  return L.join('\n');
}

/** Build the router spine: one entry per captured route. */
function renderRoutes(index: BundleIndex): string {
  const routes = Array.isArray(index.routes) ? index.routes : [];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const r of routes) {
    const route = r.route || '/';
    if (seen.has(route)) continue;
    seen.add(route);
    const label = JSON.stringify(r.label ?? route);
    const fixtures = JSON.stringify(r.fixtures ?? []);
    entries.push(
      `  { path: ${JSON.stringify(route)}, label: ${label}, screenshot: ${JSON.stringify(
        r.screenshots?.[0] ?? '',
      )}, fixtures: ${fixtures} },`,
    );
  }
  const L: string[] = [];
  L.push('// Router spine — every route captured by screenshotter. Wire each to a real');
  L.push('// page component and render data from the mock (see apiClient.ts).');
  L.push('export interface RouteDef {');
  L.push('  path: string;');
  L.push('  label: string;');
  L.push('  /** Visual target (relative to the bundle root). */');
  L.push('  screenshot: string;');
  L.push('  /** Fixtures that back this route (relative to the bundle root). */');
  L.push('  fixtures: string[];');
  L.push('}');
  L.push('');
  L.push('export const routes: RouteDef[] = [');
  L.push(...entries);
  L.push('];');
  L.push('');
  return L.join('\n');
}

/** hosts.json: every captured API host → the single mock base (multi-host wiring). */
function renderHostsJson(apiHosts: string[], primaryHost: string): string {
  const hosts = new Set<string>();
  if (primaryHost) hosts.add(primaryHost);
  for (const h of Array.isArray(apiHosts) ? apiHosts : []) {
    if (h) hosts.add(h);
  }
  const map: Record<string, string> = {};
  for (const h of hosts) map[h] = MOCK_BASE;
  return JSON.stringify(
    {
      mockBase: MOCK_BASE,
      // Each captured host is rewritten to the local mock base. The rebuild's API
      // client resolves an upstream host to its mock base via this map.
      hosts: map,
    },
    null,
    2,
  );
}

/** API client: reads VITE_API_BASE_URL, resolves per-host bases from hosts.json. */
function renderApiClient(): string {
  return `// Generic API client for the rebuild. All upstream hosts are rewritten to the
// local mock (see hosts.json + .env). Override the base via VITE_API_BASE_URL.
import hostsConfig from '../hosts.json';

const ENV_BASE =
  (import.meta as any).env?.VITE_API_BASE_URL ?? hostsConfig.mockBase;

/** Resolve the mock base for an upstream host (falls back to the default base). */
export function baseForHost(host: string): string {
  const map = (hostsConfig.hosts ?? {}) as Record<string, string>;
  return map[host] ?? ENV_BASE;
}

/**
 * Fetch JSON from the mock. Pass an upstream pathname (e.g. "/api/models") or a
 * full upstream URL; the host is rewritten to its mock base automatically.
 */
export async function apiGet<T = unknown>(pathOrUrl: string, init?: RequestInit): Promise<T> {
  let url = pathOrUrl;
  try {
    const u = new URL(pathOrUrl);
    url = baseForHost(u.host) + u.pathname + u.search;
  } catch {
    url = ENV_BASE.replace(/\\/$/, '') + (pathOrUrl.startsWith('/') ? '' : '/') + pathOrUrl;
  }
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(\`API \${res.status} for \${url}\`);
  return (await res.json()) as T;
}
`;
}

/** Minimal index.html for Vite. */
function renderIndexHtml(site: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${site} (rebuild)</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

/** Minimal React entry that lists the captured routes (a working starting point). */
function renderMain(): string {
  return `import React from 'react';
import { createRoot } from 'react-dom/client';
import { routes } from './routes';
import './tokens.css';

function App(): JSX.Element {
  return (
    <main style={{ fontFamily: 'var(--font-1, system-ui)', padding: 24 }}>
      <h1>Rebuild scaffold</h1>
      <p>Routes captured by screenshotter. Replace each with a real page.</p>
      <ul>
        {routes.map((r) => (
          <li key={r.path}>
            <code>{r.path}</code> — {r.label}
          </li>
        ))}
      </ul>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
`;
}

function renderPackageJson(site: string): string {
  return JSON.stringify(
    {
      name: `${site.replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'rebuild'}-twin`,
      private: true,
      version: '0.0.0',
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'tsc && vite build',
        preview: 'vite preview',
        // Convenience: boot the recorded mock API alongside the dev server.
        mock: 'node ../api/mock/server.mjs',
      },
      dependencies: {
        react: '^18.2.0',
        'react-dom': '^18.2.0',
      },
      devDependencies: {
        '@types/react': '^18.2.0',
        '@types/react-dom': '^18.2.0',
        '@vitejs/plugin-react': '^4.2.0',
        typescript: '^5.4.0',
        vite: '^5.2.0',
      },
    },
    null,
    2,
  );
}

function renderViteConfig(): string {
  return `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({ plugins: [react()] });
`;
}

function renderTsConfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        useDefineForClassFields: true,
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        resolveJsonModule: true,
        strict: true,
        jsx: 'react-jsx',
        noEmit: true,
        skipLibCheck: true,
      },
      include: ['src', 'hosts.json'],
    },
    null,
    2,
  );
}

/**
 * Emit the runnable frontend scaffold + env/host-map under <bundleDir>/scaffold/.
 * Returns the list of files written (relative to <bundleDir> = <outDir>/<mode>).
 * Caller guards on cfg.scaffold; this function performs the writes.
 */
export async function emitScaffold(input: ScaffoldInput): Promise<ScaffoldResult> {
  const { bundleDir, cfg, index, apiHosts, tokens } = input;
  const root = path.join(bundleDir, 'scaffold');
  const srcDir = path.join(root, 'src');
  await fs.mkdir(srcDir, { recursive: true });

  let primaryHost = '';
  try {
    primaryHost = new URL(cfg.url).host;
  } catch {
    primaryHost = '';
  }
  const site = cfg.siteName || 'rebuild';

  // (relPath within scaffold/, contents)
  const files: Array<[string, string]> = [
    ['package.json', renderPackageJson(site)],
    ['vite.config.ts', renderViteConfig()],
    ['tsconfig.json', renderTsConfig()],
    ['index.html', renderIndexHtml(site)],
    ['.env.example', `VITE_API_BASE_URL=${MOCK_BASE}\n`],
    ['hosts.json', renderHostsJson(apiHosts, primaryHost)],
    [path.join('src', 'routes.ts'), renderRoutes(index)],
    [path.join('src', 'tokens.css'), renderTokensCss(tokens)],
    [path.join('src', 'apiClient.ts'), renderApiClient()],
    [path.join('src', 'main.tsx'), renderMain()],
  ];

  const written: string[] = [];
  for (const [rel, contents] of files) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents, 'utf8');
    written.push(path.join('scaffold', rel).split(path.sep).join('/'));
  }

  return { files: written };
}
