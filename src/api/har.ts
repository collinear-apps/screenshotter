// Wave 1 / Agent G — HAR parse + redact.
// parseHar: read the recorded HAR, filter to API calls (xhr/fetch or JSON/GraphQL
// responses; exclude documents/css/js/img/font/media/beacons), honor
// cfg.api.sameOriginOnly, parse JSON bodies within cfg.api.maxBodyBytes, and
// redact headers/query/body via ./redact. writeRedactedHar: emit a valid HAR 1.2
// containing ONLY the filtered + redacted entries.
import { readFile, writeFile, stat } from 'fs/promises';
import type { ApiCall, RunConfig } from '../types';
import type { ApiBodyCollector } from './bodies';
import {
  redactHeaders,
  redactQuery,
  redactValueDeep,
  redactValueShapesDeep,
  isSensitiveName,
  REDACTED,
} from './redact';

/** Never JSON.parse a HAR larger than this (OOM backstop). */
const MAX_HAR_BYTES = 512 * 1024 * 1024;

/** HAR name/value pair (headers, queryString). */
interface HarNameValue {
  name: string;
  value: string;
}

interface HarRequest {
  method?: string;
  url?: string;
  headers?: HarNameValue[];
  queryString?: HarNameValue[];
  postData?: { mimeType?: string; text?: string };
}

interface HarResponse {
  status?: number;
  headers?: HarNameValue[];
  content?: { size?: number; mimeType?: string; text?: string; encoding?: string };
}

interface HarEntry {
  _resourceType?: string;
  request?: HarRequest;
  response?: HarResponse;
}

/** Resource types that are clearly static assets (skip unless JSON). */
const ASSET_RESOURCE_TYPES = new Set([
  'stylesheet',
  'script',
  'image',
  'font',
  'media',
  'websocket',
  'eventsource',
  'manifest',
  'texttrack',
]);

/** File extensions that mark a URL path as a static asset. */
const ASSET_EXT_RE =
  /\.(css|js|mjs|png|jpg|jpeg|gif|svg|webp|ico|woff|woff2|ttf|eot|map|mp4|webm|mp3|wav)$/i;

/** True when a mime/url looks like JSON or GraphQL. */
function looksJson(respMime: string, url: string): boolean {
  return /(^|\/)json|\+json|graphql/i.test(respMime) || /graphql/i.test(url);
}

/**
 * Returns the URL with sensitive query-param VALUES replaced by [REDACTED].
 * `ApiCall.url` is otherwise stored verbatim and would leak tokens passed in the
 * query string (e.g. ?access_token=…) into the emitted HAR.
 */
function redactUrl(parsed: URL): string {
  let touched = false;
  const u = new URL(parsed.toString());
  for (const key of [...u.searchParams.keys()]) {
    if (isSensitiveName(key)) {
      u.searchParams.set(key, REDACTED);
      touched = true;
    }
  }
  return touched ? u.toString() : parsed.toString();
}

/** Convert a HAR [{name,value}] array to a lowercase-keyed Record. */
function headersToRecord(headers: HarNameValue[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(headers)) return out;
  for (const h of headers) {
    if (!h || typeof h.name !== 'string') continue;
    out[h.name.toLowerCase()] = typeof h.value === 'string' ? h.value : '';
  }
  return out;
}

/** Collapse a HAR queryString array into a Record, duplicate names → arrays. */
function queryToRecord(
  qs: HarNameValue[] | undefined,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!Array.isArray(qs)) return out;
  for (const q of qs) {
    if (!q || typeof q.name !== 'string') continue;
    const name = q.name;
    const value = typeof q.value === 'string' ? q.value : '';
    if (name in out) {
      const existing = out[name];
      if (Array.isArray(existing)) existing.push(value);
      else out[name] = [existing, value];
    } else {
      out[name] = value;
    }
  }
  return out;
}

export async function parseHar(
  harPath: string,
  cfg: RunConfig,
  bodies?: ApiBodyCollector,
): Promise<ApiCall[]> {
  // Size guard: never JSON.parse an enormous HAR (backstop against OOM). With
  // bodies omitted from the HAR this should never trigger in practice.
  try {
    const st = await stat(harPath);
    if (st.size > MAX_HAR_BYTES) return [];
  } catch {
    return [];
  }
  let raw: string;
  try {
    raw = await readFile(harPath, 'utf8');
  } catch {
    return [];
  }

  let parsed: { log?: { entries?: HarEntry[] } };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const entries = parsed?.log?.entries;
  if (!Array.isArray(entries)) return [];

  const maxBodyBytes = cfg.api?.maxBodyBytes ?? 0;
  const sameOriginOnly = cfg.api?.sameOriginOnly ?? false;
  const redactShapes = cfg.api?.redactValueShapes ?? false;
  // Choose the body redactor: value-shape (key-name + secret-substring) when on,
  // else the original key-name-only redaction.
  const redactBody = (v: unknown): unknown =>
    redactShapes ? redactValueShapesDeep(v) : redactValueDeep(v);

  let baseHost: string | undefined;
  if (sameOriginOnly) {
    try {
      baseHost = new URL(cfg.url).host;
    } catch {
      baseHost = undefined;
    }
  }

  const calls: ApiCall[] = [];

  for (const entry of entries) {
    try {
      const request = entry?.request;
      const response = entry?.response;
      const url = request?.url;
      if (!url || typeof url !== 'string') continue;

      const resourceType = entry?._resourceType;
      const respMime = response?.content?.mimeType ?? '';
      const isXhrFetch = resourceType === 'xhr' || resourceType === 'fetch';
      const isJson = looksJson(respMime, url);

      // Scheme must be http/https.
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        continue;
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        continue;
      }

      // Skip clear assets by resource type. `document` is an asset only if not JSON.
      if (resourceType === 'document' && !isJson) continue;
      if (typeof resourceType === 'string' && ASSET_RESOURCE_TYPES.has(resourceType)) {
        continue;
      }

      // Skip by asset file extension on the path.
      if (ASSET_EXT_RE.test(parsedUrl.pathname)) continue;

      // Keep only when xhr/fetch or JSON-ish.
      if (!(isXhrFetch || isJson)) continue;

      // Skip aborted/failed requests (no real response → status <= 0). These are
      // common for debounced autocomplete XHRs that get cancelled, and a "-1"
      // status is not a valid OpenAPI response key.
      const status = typeof response?.status === 'number' ? response.status : 0;
      if (status <= 0) continue;

      const host = parsedUrl.host;

      // Same-origin filter.
      if (sameOriginOnly && baseHost) {
        if (host !== baseHost && !host.endsWith('.' + baseHost)) continue;
      }

      const query = redactQuery(queryToRecord(request?.queryString));
      const requestHeaders = redactHeaders(headersToRecord(request?.headers));
      const responseHeaders = redactHeaders(headersToRecord(response?.headers));

      // Bodies are NOT in the HAR (recorded with content:'omit' to avoid OOM);
      // they come from the bounded sidecar collector, keyed by method + URL.
      const method = typeof request?.method === 'string' ? request.method : 'GET';
      const bodyEntry = bodies?.get(method, url);

      const requestContentType =
        bodyEntry?.requestContentType ?? requestHeaders['content-type'];
      const responseContentType =
        respMime || bodyEntry?.responseContentType || undefined;

      let requestBody: unknown;
      if (
        bodyEntry?.requestBody &&
        Buffer.byteLength(bodyEntry.requestBody) <= maxBodyBytes
      ) {
        try {
          requestBody = redactBody(JSON.parse(bodyEntry.requestBody));
        } catch {
          requestBody = undefined;
        }
      }

      let responseBody: unknown;
      if (
        bodyEntry?.responseBody &&
        Buffer.byteLength(bodyEntry.responseBody) <= maxBodyBytes
      ) {
        try {
          responseBody = redactBody(JSON.parse(bodyEntry.responseBody));
        } catch {
          responseBody = undefined;
        }
      }

      const call: ApiCall = {
        method,
        url: redactUrl(parsedUrl),
        host,
        pathname: parsedUrl.pathname,
        query,
        status,
        requestContentType,
        responseContentType,
        requestHeaders,
        responseHeaders,
        requestBody,
        responseBody,
        resourceType: typeof resourceType === 'string' ? resourceType : undefined,
      };

      // Attach a buffered stream transcript (SSE/ndjson/chunked) when the bounded
      // collector captured one for this request. The ApiCall type is frozen, so
      // we attach as an extra property the fixture writer reads defensively. The
      // frames are scrubbed with the same body redactor.
      const transcript = bodies?.getStream(method, url);
      if (transcript && transcript.length > 0) {
        const scrubbed = transcript.map((f) =>
          redactShapes ? String(redactValueShapesDeep(f)) : f,
        );
        (call as { streamTranscript?: string[] }).streamTranscript = scrubbed;
      }

      calls.push(call);
    } catch {
      // One bad entry must not abort the whole parse.
      continue;
    }
  }

  return calls;
}

/** Expand a query Record back into a HAR queryString array. */
function queryToHarArray(
  query: Record<string, string | string[]>,
): HarNameValue[] {
  const out: HarNameValue[] = [];
  for (const [name, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const v of value) out.push({ name, value: String(v) });
    } else {
      out.push({ name, value: String(value) });
    }
  }
  return out;
}

/** Convert a header Record into a HAR header array. */
function recordToHarHeaders(
  headers: Record<string, string>,
): HarNameValue[] {
  return Object.entries(headers).map(([name, value]) => ({
    name,
    value: String(value),
  }));
}

export async function writeRedactedHar(
  calls: ApiCall[],
  outPath: string,
): Promise<void> {
  const entries = calls.map((call) => {
    const request: Record<string, unknown> = {
      method: call.method,
      url: call.url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: recordToHarHeaders(call.requestHeaders),
      queryString: queryToHarArray(call.query),
      headersSize: -1,
      bodySize: -1,
    };
    if (call.requestBody !== undefined) {
      request.postData = {
        mimeType: call.requestContentType || 'application/json',
        text: JSON.stringify(call.requestBody),
      };
    }

    const respText =
      call.responseBody !== undefined ? JSON.stringify(call.responseBody) : '';

    const response = {
      status: call.status,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: recordToHarHeaders(call.responseHeaders),
      content: {
        size: respText ? Buffer.byteLength(respText) : 0,
        mimeType: call.responseContentType || 'application/json',
        text: respText,
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1,
    };

    return {
      startedDateTime: '1970-01-01T00:00:00.000Z',
      time: 0,
      request,
      response,
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
    };
  });

  const har = {
    log: {
      version: '1.2',
      creator: { name: 'screenshotter', version: '0.1.0' },
      entries,
    },
  };

  await writeFile(outPath, JSON.stringify(har, null, 2), 'utf8');
}
