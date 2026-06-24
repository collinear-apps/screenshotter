// Bounded API request/response body collector. The HAR is now recorded with
// `content: 'omit'` (no embedded bodies) to avoid OOM under heavy --full runs; this
// captures JSON/GraphQL bodies separately, with hard memory caps, so OpenAPI schema
// inference still has real body samples. Keyed by `${METHOD} ${url-no-hash}`.
//
// Phase 1 additions (kept OOM-safe + bounded):
//  - SSE / chunked / ndjson responses: buffer a bounded transcript of frames so
//    the mock can replay them (stream fidelity for chat/search-as-you-type).
//  - WebSocket frames (when cfg.api.captureWebsocket): record a bounded transcript
//    keyed by the socket URL.
import type { BrowserContext } from 'playwright';
import type { ApiBodyEntry, RunConfig } from '../types';

export interface ApiBodyCollector {
  /** Look up captured bodies for a request. */
  get(method: string, url: string): ApiBodyEntry | undefined;
  /** Look up a buffered stream transcript for a request (SSE/ndjson/chunked). */
  getStream(method: string, url: string): string[] | undefined;
  /** All recorded websocket transcripts, keyed by socket URL. */
  websocketFrames(): Record<string, string[]>;
  /** Number of body entries stored. */
  count(): number;
  /** Await in-flight body reads. MUST be called before context.close(). */
  drain(): Promise<void>;
}

const MAX_ENTRIES = 600;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const MAX_STREAMS = 80;
const MAX_FRAMES_PER_STREAM = 200;
const MAX_FRAME_BYTES = 16 * 1024;
const MAX_WS_SOCKETS = 40;
/** Cap on how long we wait for a stream body before giving up (keeps drain bounded). */
const STREAM_READ_TIMEOUT_MS = 10000;

/** Resolve to the promise's value, or undefined if it doesn't settle in `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(undefined);
      }
    }, ms);
    p.then(
      (v) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(undefined);
        }
      },
    );
  });
}

/** Key a request by method + URL with the hash stripped (query kept). */
function keyOf(method: string, url: string): string {
  let u = url;
  const h = u.indexOf('#');
  if (h !== -1) u = u.slice(0, h);
  return `${method.toUpperCase()} ${u}`;
}

function isJsonish(contentType: string | undefined, url: string): boolean {
  const ct = (contentType ?? '').toLowerCase();
  return /(^|\/)json|\+json|graphql/.test(ct) || /graphql/i.test(url);
}

/** True for SSE / ndjson / streamed-JSON content types. */
function isStreamish(contentType: string | undefined): boolean {
  const ct = (contentType ?? '').toLowerCase();
  return /text\/event-stream|application\/x-ndjson|application\/stream\+json/.test(ct);
}

/**
 * Split a buffered SSE/ndjson payload into bounded transcript frames. For SSE we
 * keep each event block; for ndjson each line. Empty frames are dropped.
 */
function framesFromStreamText(text: string, contentType: string | undefined): string[] {
  const ct = (contentType ?? '').toLowerCase();
  let raw: string[];
  if (/text\/event-stream/.test(ct)) {
    raw = text.split(/\n\n+/);
  } else {
    raw = text.split(/\r?\n/);
  }
  const out: string[] = [];
  for (let frame of raw) {
    frame = frame.trim();
    if (!frame) continue;
    if (frame.length > MAX_FRAME_BYTES) frame = frame.slice(0, MAX_FRAME_BYTES);
    out.push(frame);
    if (out.length >= MAX_FRAMES_PER_STREAM) break;
  }
  return out;
}

export function createApiBodyCollector(
  context: BrowserContext,
  cfg: RunConfig,
): ApiBodyCollector {
  const maxBody = cfg.api?.maxBodyBytes ?? 256 * 1024;
  const captureStream = cfg.api?.captureStream !== false;
  const captureWs = cfg.api?.captureWebsocket === true;
  const map = new Map<string, ApiBodyEntry>();
  const streams = new Map<string, string[]>();
  const wsFrames = new Map<string, string[]>();
  const pending: Promise<void>[] = [];
  let totalBytes = 0;
  let full = false;

  const store = async (response: import('playwright').Response): Promise<void> => {
    try {
      if (full) return;
      const req = response.request();
      const method = req.method();
      const url = response.url();
      if (!/^https?:/i.test(url)) return;

      const respCt = response.headers()['content-type'];
      const reqCt = req.headers()['content-type'];
      const respIsJson = isJsonish(respCt, url);
      const respIsStream = captureStream && isStreamish(respCt);
      const reqPost = req.postData() ?? undefined;
      const reqIsJson = reqPost !== undefined && isJsonish(reqCt, url);
      if (!respIsJson && !reqIsJson && !respIsStream) return;

      // Declared-size pre-check to avoid pulling huge bodies. Streams rarely
      // declare a content-length, so skip the check for them.
      if (!respIsStream) {
        const len = Number(response.headers()['content-length'] ?? '0');
        if (Number.isFinite(len) && len > maxBody) return;
      }

      // ── Streaming transcript capture (bounded) ──
      // response.text() resolves only when the body finishes; a long-lived SSE
      // could otherwise block drain() at context-close. Race it with a timeout
      // so we either get the (already-closed) transcript or skip it.
      if (respIsStream && streams.size < MAX_STREAMS) {
        try {
          const text = await withTimeout(response.text(), STREAM_READ_TIMEOUT_MS);
          if (text !== undefined && text.length <= maxBody) {
            const frames = framesFromStreamText(text, respCt);
            if (frames.length > 0) {
              const key = keyOf(method, url);
              if (!streams.has(key)) streams.set(key, frames);
            }
          }
        } catch {
          /* live stream not fully buffered — skip */
        }
        // A stream response has no reusable JSON body; done.
        return;
      }

      let responseBody: string | undefined;
      if (respIsJson) {
        try {
          const text = await response.text();
          if (text.length <= maxBody) responseBody = text;
        } catch {
          /* streamed/redirect/no body — skip */
        }
      }
      let requestBody: string | undefined;
      if (reqIsJson && reqPost !== undefined && reqPost.length <= maxBody) {
        requestBody = reqPost;
      }
      if (responseBody === undefined && requestBody === undefined) return;

      const addedBytes = (responseBody?.length ?? 0) + (requestBody?.length ?? 0);
      if (map.size >= MAX_ENTRIES || totalBytes + addedBytes > MAX_TOTAL_BYTES) {
        if (!full) {
          full = true;
          // eslint-disable-next-line no-console
          console.error(
            `API body capture cap reached (${map.size} bodies / ` +
              `${Math.round(totalBytes / 1024 / 1024)}MB) — further bodies skipped.`,
          );
        }
        return;
      }

      const key = keyOf(method, url);
      if (!map.has(key)) {
        map.set(key, {
          requestBody,
          responseBody,
          requestContentType: reqCt,
          responseContentType: respCt,
        });
        totalBytes += addedBytes;
      }
    } catch {
      // never throw from a response handler
    }
  };

  context.on('response', (response) => {
    pending.push(store(response));
  });

  // ── WebSocket frame capture (bounded), gated by config ──
  // The 'websocket' event lives on Page (not BrowserContext), so we hook every
  // page the context opens and attach a per-socket bounded recorder.
  if (captureWs) {
    const attachWs = (ws: import('playwright').WebSocket): void => {
      try {
        const url = ws.url();
        if (wsFrames.size >= MAX_WS_SOCKETS && !wsFrames.has(url)) return;
        const frames = wsFrames.get(url) ?? [];
        if (!wsFrames.has(url)) wsFrames.set(url, frames);
        const record = (dir: 'recv' | 'send', payload: string | Buffer): void => {
          if (frames.length >= MAX_FRAMES_PER_STREAM) return;
          let text = typeof payload === 'string' ? payload : '[binary]';
          if (text.length > MAX_FRAME_BYTES) text = text.slice(0, MAX_FRAME_BYTES);
          frames.push(`${dir}: ${text}`);
        };
        ws.on('framereceived', (data) => record('recv', data.payload));
        ws.on('framesent', (data) => record('send', data.payload));
      } catch {
        /* never throw from a ws handler */
      }
    };
    context.on('page', (page) => {
      try {
        page.on('websocket', attachWs);
      } catch {
        /* ignore */
      }
    });
    // Cover any pages already open when the collector was created.
    for (const page of context.pages()) {
      try {
        page.on('websocket', attachWs);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    get(method: string, url: string): ApiBodyEntry | undefined {
      return map.get(keyOf(method, url));
    },
    getStream(method: string, url: string): string[] | undefined {
      return streams.get(keyOf(method, url));
    },
    websocketFrames(): Record<string, string[]> {
      const out: Record<string, string[]> = {};
      for (const [k, v] of wsFrames) out[k] = v;
      return out;
    },
    count(): number {
      return map.size;
    },
    async drain(): Promise<void> {
      await Promise.allSettled(pending);
    },
  };
}
