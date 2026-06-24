// Wave 1 / Agent G — endpoint catalog.
// renderApiCatalog: group calls by host then method+path; render a readable
// Markdown catalog with status, content-types, and a (already-redacted)
// request/response sample per endpoint.
import type { ApiCall } from '../types';

const MAX_BODY_CHARS = 1500;

/** Pretty-print an (already-redacted) JSON body, truncated to ~1500 chars. */
function formatBody(body: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(body, null, 2);
  } catch {
    text = String(body);
  }
  if (typeof text !== 'string') text = String(text);
  if (text.length > MAX_BODY_CHARS) {
    text = text.slice(0, MAX_BODY_CHARS) + '\n… (truncated)';
  }
  return text;
}

/** True for SSE / ndjson / streamed-JSON content types. */
function isStreamCt(ct: string | undefined): boolean {
  return /text\/event-stream|application\/x-ndjson|application\/stream\+json/i.test(ct ?? '');
}

/** Extract a GraphQL operationName from a call's request body, if any. */
function graphqlOp(call: ApiCall): string | undefined {
  if (!/graphql/i.test(call.pathname)) return undefined;
  const b = call.requestBody;
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    const op = (b as Record<string, unknown>).operationName;
    if (typeof op === 'string' && op) return op;
  }
  return undefined;
}

/** Distinct, sorted, joined values from a list (drops empties). */
function distinctSorted(values: Array<string | undefined>): string {
  const set = new Set<string>();
  for (const v of values) {
    if (v) set.add(v);
  }
  return [...set].sort().join(', ');
}

export function renderApiCatalog(calls: ApiCall[], siteName: string): string {
  const lines: string[] = [];
  lines.push(`# API endpoints — ${siteName}`);
  lines.push('');

  if (!Array.isArray(calls) || calls.length === 0) {
    lines.push('_No API calls captured._');
    lines.push('');
    return lines.join('\n');
  }

  // Group by host, then by `${method} ${pathname}`.
  const byHost = new Map<string, Map<string, ApiCall[]>>();
  for (const call of calls) {
    const host = call.host || '(unknown host)';
    let endpoints = byHost.get(host);
    if (!endpoints) {
      endpoints = new Map<string, ApiCall[]>();
      byHost.set(host, endpoints);
    }
    const key = `${call.method} ${call.pathname}`;
    let group = endpoints.get(key);
    if (!group) {
      group = [];
      endpoints.set(key, group);
    }
    group.push(call);
  }

  const distinctEndpoints = new Set<string>();
  for (const call of calls) {
    distinctEndpoints.add(`${call.host} ${call.method} ${call.pathname}`);
  }

  lines.push(
    `${calls.length} call${calls.length === 1 ? '' : 's'}, ` +
      `${distinctEndpoints.size} distinct method+path, ` +
      `${byHost.size} host${byHost.size === 1 ? '' : 's'}.`,
  );
  lines.push('');

  const hosts = [...byHost.keys()].sort();
  for (const host of hosts) {
    lines.push(`## ${host}`);
    lines.push('');

    const endpoints = byHost.get(host)!;
    const keys = [...endpoints.keys()].sort();
    for (const key of keys) {
      const group = endpoints.get(key)!;
      const first = group[0];

      lines.push(`### ${first.method} ${first.pathname}`);
      lines.push('');

      const statuses = distinctSorted(group.map((c) => String(c.status)));
      lines.push(`- Status: ${statuses || '(none)'}`);

      const reqCt = distinctSorted(group.map((c) => c.requestContentType));
      if (reqCt) lines.push(`- Request content-type: ${reqCt}`);

      const respCt = distinctSorted(group.map((c) => c.responseContentType));
      if (respCt) lines.push(`- Response content-type: ${respCt}`);

      // Distinct query-parameter keys observed across the group (helps the
      // rebuild see which params drive different responses).
      const queryKeys = new Set<string>();
      for (const c of group) for (const k of Object.keys(c.query ?? {})) queryKeys.add(k);
      if (queryKeys.size > 0) {
        lines.push(`- Query params: ${[...queryKeys].sort().join(', ')}`);
      }

      // GraphQL operation names, when this is a GraphQL endpoint.
      const ops = distinctSorted(group.map((c) => graphqlOp(c)));
      if (ops) lines.push(`- GraphQL operations: ${ops}`);

      // Streaming flag (SSE / ndjson / chunked).
      if (group.some((c) => isStreamCt(c.responseContentType))) {
        lines.push('- Streaming: yes (SSE/chunked — transcript captured in fixtures)');
      }

      // Number of distinct request/response variants merged here.
      if (group.length > 1) {
        lines.push(`- Samples: ${group.length} captured call(s)`);
      }

      lines.push('');

      // Sample bodies from the first call that has each.
      const reqSample = group.find((c) => c.requestBody !== undefined);
      if (reqSample) {
        lines.push('Request body sample:');
        lines.push('');
        lines.push('```json');
        lines.push(formatBody(reqSample.requestBody));
        lines.push('```');
        lines.push('');
      }

      const respSample = group.find((c) => c.responseBody !== undefined);
      if (respSample) {
        lines.push('Response body sample:');
        lines.push('');
        lines.push('```json');
        lines.push(formatBody(respSample.responseBody));
        lines.push('```');
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}
