// Shared redaction helpers (Wave 0 foundation). Used across HAR, catalog, and
// OpenAPI examples so secrets NEVER reach any emitted artifact. Critical because
// a run can carry a live auth session (cookies / Authorization / API keys).

export const REDACTED = '[REDACTED]';

/** Header names that are always redacted regardless of value. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
]);

/** Key/param names whose VALUE is a likely secret. */
const SENSITIVE_NAME_RE =
  /(token|secret|password|passwd|authorization|api[-_]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|session|credential|bearer)/i;

const MAX_DEPTH = 12;

/** True if a header/param/property name should have its value redacted. */
export function isSensitiveName(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.toLowerCase()) || SENSITIVE_NAME_RE.test(name);
}

/** Returns a copy of headers with sensitive values replaced by [REDACTED]. */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = isSensitiveName(k) ? REDACTED : v;
  }
  return out;
}

/** Returns a copy of query params with sensitive values replaced by [REDACTED]. */
export function redactQuery(
  query: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(query)) {
    out[k] = isSensitiveName(k) ? REDACTED : v;
  }
  return out;
}

/**
 * Recursively redacts values of sensitive-named properties anywhere in a parsed
 * JSON body. Non-objects pass through unchanged. Bounded depth as a safety net.
 */
export function redactValueDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactValueDeep(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveName(k) ? REDACTED : redactValueDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

// ── Phase 1: VALUE-SHAPE redaction ──────────────────────────────────────────
// Key-name redaction above can't catch a secret stored in an innocuously-named
// field (e.g. `{ "data": "eyJhbGci..." }`) or embedded in a longer string
// (e.g. an `Authorization: Bearer …` value echoed into a body). These matchers
// look at the VALUE shape and scrub secret-looking substrings, gated by
// cfg.api.redactValueShapes (default ON).

/** JWT: three base64url segments separated by dots, header starts with eyJ. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;
/** `Bearer <token>` / `token <token>` authorization scheme values. */
const BEARER_RE = /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi;
/**
 * Long hex blobs (>=40 chars) — signed tokens / HMACs. The threshold is 40 (not
 * 32) on purpose: 32-char hex and git-style 40-char SHAs are often legitimate
 * identifiers we WANT to keep for data fidelity, so we only flag clearly
 * token-length hex (>=40 with both letters and digits present is checked below).
 */
const HEX_SECRET_RE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{40,}\b/gi;
/**
 * Long base64/base64url blobs (>=40 chars) — opaque tokens/keys. To avoid
 * nuking legitimate long lowercase slugs/words, require entropy markers: either
 * a base64 padding/separator char (+ / = _ -) OR a mix of upper+lower+digit.
 */
const B64_SECRET_RE =
  /\b(?=[A-Za-z0-9+/_=-]*[A-Z])(?=[A-Za-z0-9+/_=-]*[a-z])(?=[A-Za-z0-9+/_=-]*[0-9])[A-Za-z0-9+/_-]{40,}={0,2}\b/g;
/** Provider-style key prefixes (sk-, pk-, ghp_, xoxb-, AKIA…). */
const PREFIXED_KEY_RE =
  /\b((sk|pk|rk|api|key|tok)[_-][A-Za-z0-9]{16,}|gh[posu]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,})\b/g;
/** RFC-5322-ish email (only scrubbed when redactEmails is on). */
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export interface ValueShapeOptions {
  /** Also scrub email addresses (off by default — emails are often legit data). */
  redactEmails?: boolean;
}

/**
 * Scrubs secret-looking substrings inside a single string value. Order matters:
 * the most specific patterns run first so a JWT isn't half-mangled by the
 * generic base64 matcher. Returns the original string when nothing matched.
 */
export function redactSecretsInString(s: string, opts: ValueShapeOptions = {}): string {
  if (typeof s !== 'string' || s.length < 12) return s;
  let out = s;
  out = out.replace(JWT_RE, REDACTED);
  out = out.replace(BEARER_RE, (m) => m.replace(/\s+\S+$/, ' ' + REDACTED));
  out = out.replace(PREFIXED_KEY_RE, REDACTED);
  out = out.replace(HEX_SECRET_RE, REDACTED);
  out = out.replace(B64_SECRET_RE, (m) => (m === REDACTED ? m : REDACTED));
  if (opts.redactEmails) out = out.replace(EMAIL_RE, REDACTED);
  return out;
}

/**
 * Deep value-shape redaction over a parsed JSON body: applies both the existing
 * key-name redaction AND substring secret-scrubbing on every string leaf.
 * Use this (instead of redactValueDeep) when cfg.api.redactValueShapes is on.
 */
export function redactValueShapesDeep(
  value: unknown,
  opts: ValueShapeOptions = {},
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') return redactSecretsInString(value, opts);
  if (Array.isArray(value)) {
    return value.map((v) => redactValueShapesDeep(v, opts, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveName(k)
        ? REDACTED
        : redactValueShapesDeep(v, opts, depth + 1);
    }
    return out;
  }
  return value;
}
