// API capture orchestration (Wave 0 foundation). Runs AFTER the browser context
// is closed (so Playwright has flushed the recorded HAR), parses + redacts the
// HAR, and emits: network.har (redacted), api-endpoints.md, openapi/<host>.json.
import { promises as fs } from 'fs';
import path from 'path';
import pc from 'picocolors';
import type {
  ApiFixture,
  ApiSummary,
  Logger,
  MockSeedEntity,
  RunConfig,
} from '../types';
import { parseHar, writeRedactedHar } from './har';
import type { ApiBodyCollector } from './bodies';
import { writeFixtures } from './fixtures';
import { writeMockServer } from './mockserver';

/** Result of processing the API artifacts. */
export interface ApiProcessResult {
  summary?: ApiSummary;
  fixtures: ApiFixture[];
}
import { renderApiCatalog } from './catalog';
import { buildOpenApiByHost, renderOpenApi } from './openapi';

/** Temp path (under outDir) where Playwright records the raw HAR before redaction. */
export function harTempPath(outDir: string): string {
  return path.join(outDir, '.tmp-network.har');
}

/** Filesystem-safe filename for a host (e.g. "api.example.com" → "api.example.com"). */
function safeHost(host: string): string {
  return host.replace(/[^a-z0-9._-]+/gi, '_') || 'host';
}

/** Counts HTTP operations across all per-host OpenAPI docs (= distinct endpoints). */
function countOperations(byHost: Record<string, unknown>): number {
  const METHODS = new Set([
    'get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace',
  ]);
  let n = 0;
  for (const doc of Object.values(byHost)) {
    const paths = (doc as { paths?: Record<string, Record<string, unknown>> })?.paths;
    if (!paths) continue;
    for (const ops of Object.values(paths)) {
      for (const method of Object.keys(ops)) {
        if (METHODS.has(method.toLowerCase())) n++;
      }
    }
  }
  return n;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses the recorded HAR and writes the three API artifacts into
 * `outDir/<mode>/api/`. Deletes the temp raw HAR so it never reaches the zip.
 * Returns an ApiSummary, or undefined if there was nothing to process.
 */
export async function processApiArtifacts(
  harPath: string,
  cfg: RunConfig,
  logger: Logger,
  bodies?: ApiBodyCollector,
  /** Entity-graph-derived seeds for the stateful mock store (Phase 1). When
   *  omitted/empty the mock falls back to serving recorded fixture bodies. */
  seeds: MockSeedEntity[] = [],
): Promise<ApiProcessResult> {
  if (!(await fileExists(harPath))) {
    logger.info(pc.yellow('API capture: no HAR was recorded (no traffic?).'));
    return { fixtures: [] };
  }

  try {
    const calls = await parseHar(harPath, cfg, bodies);

    const apiDir = path.join(cfg.outDir, cfg.mode, 'api');
    await fs.mkdir(apiDir, { recursive: true });

    // 1. Redacted HAR (standard HAR 1.2, API entries only).
    await writeRedactedHar(calls, path.join(apiDir, 'network.har'));

    // 2. Markdown endpoint catalog.
    await fs.writeFile(
      path.join(apiDir, 'api-endpoints.md'),
      renderApiCatalog(calls, cfg.siteName),
      'utf8',
    );

    // 3. OpenAPI per host.
    const byHost = buildOpenApiByHost(calls, cfg);
    const openapiDir = path.join(apiDir, 'openapi');
    await fs.mkdir(openapiDir, { recursive: true });
    for (const [host, doc] of Object.entries(byHost)) {
      await fs.writeFile(
        path.join(openapiDir, `${safeHost(host)}.json`),
        renderOpenApi(doc),
        'utf8',
      );
    }

    // 4. Importable fixtures + a runnable zero-dep mock server (the data substrate).
    let fixtures: ApiFixture[] = [];
    try {
      fixtures = await writeFixtures(calls, path.join(apiDir, 'fixtures'), cfg);
      if (fixtures.length > 0) {
        // Seed the stateful store only when the stateful mock is enabled
        // (default ON with --api). When disabled, the mock still serves recorded
        // bodies but won't persist mutations across requests.
        const mockSeeds = cfg.api?.stateful !== false ? seeds : [];
        await writeMockServer(fixtures, path.join(apiDir, 'mock'), mockSeeds);
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger.info(pc.yellow(`Fixtures/mock failed: ${m}`));
    }

    const hosts = Object.keys(byHost).sort();
    const summary: ApiSummary = {
      hosts,
      endpoints: countOperations(byHost),
      calls: calls.length,
    };

    logger.info(
      pc.green(
        `API: ${summary.calls} call(s), ${summary.endpoints} endpoint(s) across ` +
          `${hosts.length} host(s), ${fixtures.length} fixture(s) → ${path.join(cfg.mode, 'api')}/`,
      ),
    );
    return { summary, fixtures };
  } finally {
    // Always remove the unredacted raw HAR (contains live secrets).
    await fs.rm(harPath, { force: true }).catch(() => {});
  }
}
