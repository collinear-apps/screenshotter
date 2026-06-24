// Owned by Wave 1 / Agent A (fixtures).
// writeFixtures: one importable JSON file per fixture VARIANT, keyed by
// (method, pathTemplate, querySignature, requestBodyHash, graphqlOperation) so a
// search vs. a paginated list vs. a GraphQL op against the SAME path become
// distinct fixtures the stateful mock can best-match. Lifts data out of the
// OpenAPI blob so the rebuild + mock server can use it directly.
import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import type { ApiCall, ApiFixture, RunConfig } from '../types';
import { templatePath } from './schema';
import { redactValueShapesDeep } from './redact';

// ── Canonicalization + stable hashing (shared with the mock + OpenAPI lanes) ──

/** Deterministic JSON string with object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  return canon(value);
}

function canon(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(obj[k])).join(',') + '}';
}

/** Small, stable, dependency-free 32-bit FNV-1a hash → 8-hex string. */
export function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

/**
 * Canonicalize a query Record into a stable signature: keys sorted, array values
 * sorted, sensitive/volatile params dropped so paging cursors/timestamps don't
 * explode the variant count. Returns '' when there are no meaningful params.
 */
export function querySignature(query: Record<string, string | string[]> | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const key of Object.keys(query).sort()) {
    if (VOLATILE_QUERY_RE.test(key)) continue;
    const v = query[key];
    const vs = Array.isArray(v) ? [...v].map(String).sort() : [String(v)];
    parts.push(`${key}=${vs.join(',')}`);
  }
  return parts.join('&');
}

/** Query params that are volatile/noise: cache-busters, timestamps, signatures. */
const VOLATILE_QUERY_RE = /^(_$|_t$|ts$|t$|cb$|v$|timestamp|nonce|sig|signature|rand)/i;

/** Stable hash of a canonical JSON request body (undefined → ''). */
export function requestBodyHash(body: unknown): string {
  if (body === undefined || body === null) return '';
  // GraphQL bodies are matched by operation, not by hash (variables vary); a
  // hash of the whole body would over-fragment. Caller decides; here we hash
  // the canonical body verbatim.
  return stableHash(canonicalJson(body));
}

/** Extract a GraphQL operationName from a request body, if present. */
export function graphqlOperationOf(call: ApiCall): string | undefined {
  if (!/graphql/i.test(call.pathname) && !/graphql/i.test(call.url)) return undefined;
  const body = call.requestBody;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const op = (body as Record<string, unknown>).operationName;
    if (typeof op === 'string' && op.length > 0) return op;
    // Fall back to parsing the first operation name out of the query string.
    const q = (body as Record<string, unknown>).query;
    if (typeof q === 'string') {
      const m = q.match(/\b(query|mutation|subscription)\s+([A-Za-z0-9_]+)/);
      if (m) return m[2];
    }
  }
  return undefined;
}

// ── Volatile-value stabilization (deterministic replays) ─────────────────────
// Captured bodies carry timestamps/ids/counts that differ run-to-run. We leave
// the DATA intact (the twin must render real values) but normalize obviously
// volatile leaf STRINGS so re-captures produce byte-identical fixtures and the
// dedupe/variant merge is stable. Conservative: only well-known shapes.

const ISO_DATE_RE =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/;

/**
 * Stabilize volatile leaf values in a parsed body for deterministic replay.
 * Only rewrites values under volatile-looking KEYS (createdAt/updatedAt/…) so
 * substantive content is untouched. Returns a structurally-identical copy.
 */
export function stabilizeBody(value: unknown, key?: string, depth = 0): unknown {
  if (depth > 12) return value;
  if (Array.isArray(value)) {
    return value.map((v) => stabilizeBody(v, key, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stabilizeBody(v, k, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && key && VOLATILE_KEY_RE.test(key) && ISO_DATE_RE.test(value)) {
    return '2024-01-01T00:00:00.000Z';
  }
  return value;
}

const VOLATILE_KEY_RE =
  /(created|updated|modified|deleted|expires|expiry|timestamp|_at$|date|lastSeen|lastModified)/i;

// ── Allowlisted response headers ─────────────────────────────────────────────
// Only pagination / cursor / rate-limit / content-type headers are echoed by the
// mock — everything else is dropped (avoids leaking server/security headers and
// keeps replays small but functionally faithful for infinite-scroll etc.).
const HEADER_ALLOW_EXACT = new Set([
  'content-type',
  'link',
  'x-total-count',
  'x-total',
  'x-count',
  'x-next',
  'x-prev',
  'etag',
]);
const HEADER_ALLOW_RE = /(cursor|page|ratelimit|rate-limit|x-has-more|next-token)/i;

export function pickResponseHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (HEADER_ALLOW_EXACT.has(lk) || HEADER_ALLOW_RE.test(lk)) out[lk] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ── File naming ──────────────────────────────────────────────────────────────

/** Build a filesystem-safe slug from a path-only template. */
function slugify(method: string, template: string): string {
  const raw = template
    .replace(/\//g, '_')
    .replace(/[{}]/g, '')
    .toLowerCase();
  let slug = raw.replace(/[^a-z0-9._-]+/g, '-');
  // Collapse runs of separators and trim leading/trailing ones.
  slug = slug.replace(/-+/g, '-').replace(/_+/g, '_');
  slug = slug.replace(/^[-_.]+/, '').replace(/[-_.]+$/, '');
  if (slug.length === 0) slug = 'root';
  if (slug.length > 60) slug = slug.slice(0, 60).replace(/[-_.]+$/, '');
  return `${method.toUpperCase()}__${slug}.json`;
}

/** A short discriminator appended to a fixture file when variants share a path. */
function variantSuffix(f: { graphqlOperation?: string; querySignature?: string; requestBodyHash?: string }): string {
  if (f.graphqlOperation) {
    return '-' + f.graphqlOperation.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
  }
  const sig = f.querySignature
    ? stableHash(f.querySignature)
    : f.requestBodyHash || '';
  return sig ? '-' + sig.slice(0, 8) : '';
}

// ── Main ─────────────────────────────────────────────────────────────────────

/** The grouping key that defines a distinct fixture variant. */
function variantKey(
  method: string,
  template: string,
  status: number,
  qsig: string,
  bodyHash: string,
  gqlOp: string | undefined,
): string {
  return [method, template, status, qsig, gqlOp ? `op:${gqlOp}` : bodyHash].join(' ');
}

export async function writeFixtures(
  calls: ApiCall[],
  apiDir: string,
  cfg: RunConfig,
): Promise<ApiFixture[]> {
  // 1. Keep only calls with a defined response body (the useful ones).
  const useful = calls.filter((c) => c.responseBody !== undefined);
  if (useful.length === 0) return [];

  const redactShapes = cfg.api?.redactValueShapes ?? false;

  // 2. Group calls by host so templating sees the right siblings.
  const byHost = new Map<string, ApiCall[]>();
  for (const call of useful) {
    const list = byHost.get(call.host);
    if (list) list.push(call);
    else byHost.set(call.host, [call]);
  }

  // 3. Group into variants keyed by (method, template, status, query, body/op).
  interface Variant {
    fixture: ApiFixture;
    count: number;
  }
  const variants = new Map<string, Variant>();
  const usedFiles = new Set<string>();
  const ordered: ApiFixture[] = [];

  for (const [, hostCalls] of byHost) {
    const siblings = hostCalls.map((c) => c.pathname);
    for (const call of hostCalls) {
      const { template } = templatePath(call.pathname, siblings);
      const method = (call.method || 'GET').toUpperCase();
      const qsig = querySignature(call.query);
      const gqlOp = graphqlOperationOf(call);
      const bodyHash = gqlOp ? '' : requestBodyHash(call.requestBody);
      const key = variantKey(method, template, call.status, qsig, bodyHash, gqlOp);

      const existing = variants.get(key);
      if (existing) {
        existing.count++;
        existing.fixture.variants = existing.count;
        continue;
      }

      const isStream =
        isStreamCall(call) || Array.isArray((call as { streamTranscript?: unknown }).streamTranscript);

      const response = redactShapes
        ? redactValueShapesDeep(stabilizeBody(call.responseBody))
        : stabilizeBody(call.responseBody);
      const requestExample = redactShapes
        ? redactValueShapesDeep(stabilizeBody(call.requestBody))
        : stabilizeBody(call.requestBody);

      const fixture: ApiFixture = {
        method,
        pathTemplate: template,
        url: call.url,
        status: call.status,
        contentType: call.responseContentType,
        response,
        requestExample,
        file: '', // assigned below
        variants: 1,
      };
      if (qsig) fixture.querySignature = qsig;
      if (bodyHash) fixture.requestBodyHash = bodyHash;
      if (gqlOp) fixture.graphqlOperation = gqlOp;
      const respHeaders = pickResponseHeaders(call.responseHeaders);
      if (respHeaders) fixture.responseHeaders = respHeaders;
      const transcript = streamTranscriptOf(call);
      if (transcript) {
        fixture.isStream = true;
        fixture.streamTranscript = redactShapes
          ? transcript.map((f) => String(redactValueShapesDeep(f)))
          : transcript;
      } else if (isStream) {
        fixture.isStream = true;
      }

      variants.set(key, { fixture, count: 1 });
      ordered.push(fixture);
    }
  }

  // 4. Assign unique, filesystem-safe file names (variant discriminator when a
  //    path has >1 variant).
  const byTemplate = new Map<string, ApiFixture[]>();
  for (const f of ordered) {
    const k = `${f.method} ${f.pathTemplate}`;
    const arr = byTemplate.get(k);
    if (arr) arr.push(f);
    else byTemplate.set(k, [f]);
  }
  for (const [, group] of byTemplate) {
    const multi = group.length > 1;
    for (const f of group) {
      let base = slugify(f.method, f.pathTemplate).replace(/\.json$/, '');
      if (multi) base += variantSuffix(f);
      let file = `${base}.json`;
      if (usedFiles.has(file)) {
        let n = 2;
        while (usedFiles.has(`${base}-${n}.json`)) n++;
        file = `${base}-${n}.json`;
      }
      usedFiles.add(file);
      f.file = file;
    }
  }

  // 5. Write each fixture object as pretty JSON.
  await mkdir(apiDir, { recursive: true });
  await Promise.all(
    ordered.map((f) =>
      writeFile(path.join(apiDir, f.file), JSON.stringify(f, null, 2), 'utf8'),
    ),
  );

  return ordered;
}

/** Heuristic: does this call's content-type mark it as an SSE/stream response? */
function isStreamCall(call: ApiCall): boolean {
  const ct = (call.responseContentType ?? '').toLowerCase();
  return /text\/event-stream|application\/x-ndjson|application\/stream\+json/.test(ct);
}

/**
 * Pull a buffered stream transcript off the call, if the body collector attached
 * one. We read it defensively (the ApiCall type doesn't declare it) so this works
 * whether or not the upstream collector populated it.
 */
function streamTranscriptOf(call: ApiCall): string[] | undefined {
  const t = (call as { streamTranscript?: unknown }).streamTranscript;
  if (Array.isArray(t) && t.length > 0 && t.every((x) => typeof x === 'string')) {
    return t as string[];
  }
  return undefined;
}
