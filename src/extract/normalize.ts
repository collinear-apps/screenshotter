// Owned by Wave 1 / Agent J (normalization).
// Replaces dynamic values (UUIDs, timestamps, emails, long hex, tokens) and blanks
// volatile attributes so golden diffs compare signal — and secrets stay out of
// fixtures. normalizeHtml = normalizeText specialized for HTML.
//
// Design notes:
// - Pure & side-effect free. Inputs are coerced with String(...) defensively.
// - CONSERVATIVE: ordinary short numbers/words (prices like $1,299, id=42) must
//   survive untouched. Every numeric rule is word-bounded and length-gated.
// - Order matters: the MOST SPECIFIC patterns run first so a value isn't partly
//   eaten by a looser rule (e.g. UUID/timestamp before the bare-integer rules).
// - Idempotent: running twice == running once. The placeholders ({{...}}) do not
//   themselves match any rule, so a second pass is a no-op.

// --- normalizeText rules (order = specificity, most specific first) ---

// UUID v1–v5: 8-4-4-4-12 lowercase/uppercase hex. Run before HEX so the dashes
// aren't split into separate "long hex" matches.
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// ISO-8601 timestamp: 2024-01-02T03:04:05 with optional fractional seconds and an
// optional Z / ±hh:mm offset. Run before the epoch rules (no digit collision, but
// keeps date-shaped numbers from being mistaken for bare ints).
const ISO_TIMESTAMP_RE =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/g;

// Email addresses.
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

// "Bearer <token>" — keep the scheme word, replace the credential. Run before the
// generic JWT/provider-key rules so the whole token (incl. dots) is consumed.
const BEARER_RE = /Bearer\s+[A-Za-z0-9._\-]+/g;

// JWTs: three base64url segments separated by dots, starting with the standard
// `eyJ` header prefix.
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

// Provider API keys: sk-/pk-/ghp_/xox[baprs]- followed by a long opaque body.
const PROVIDER_KEY_RE = /\b(?:sk-|pk-|ghp_|xox[baprs]-)[A-Za-z0-9_-]{10,}\b/g;

// Long hex strings (>=16 hex chars): hashes, etags, nonces, content digests.
const HEX_RE = /\b[0-9a-f]{16,}\b/gi;

// Epoch-looking integers as standalone tokens. 13-digit (ms) first, then 10-digit
// (s). Word-bounded & exact-length so 4–6 digit ids/prices are never touched. Run
// AFTER date/uuid/hex rules.
const EPOCH_MS_RE = /\b\d{13}\b/g;
const EPOCH_S_RE = /\b\d{10}\b/g;

export function normalizeText(s: string): string {
  let out = String(s);
  out = out.replace(UUID_RE, '{{UUID}}');
  out = out.replace(ISO_TIMESTAMP_RE, '{{TIMESTAMP}}');
  out = out.replace(EMAIL_RE, '{{EMAIL}}');
  out = out.replace(BEARER_RE, 'Bearer {{TOKEN}}');
  out = out.replace(JWT_RE, '{{JWT}}');
  out = out.replace(PROVIDER_KEY_RE, '{{TOKEN}}');
  out = out.replace(HEX_RE, '{{HEX}}');
  out = out.replace(EPOCH_MS_RE, '{{EPOCH}}');
  out = out.replace(EPOCH_S_RE, '{{EPOCH}}');
  return out;
}

// --- normalizeHtml: blank volatile attribute VALUES, then text-normalize ---

// nonce="..." → nonce="" (single or double quoted). Keeps the attribute so the
// HTML shape is stable while the per-response random value is dropped.
const NONCE_ATTR_RE = /(\bnonce\s*=\s*)(["'])[^"']*\2/gi;

// integrity="sha384-..." → integrity="" (subresource-integrity hashes).
const INTEGRITY_ATTR_RE = /(\bintegrity\s*=\s*)(["'])[^"']*\2/gi;

export function normalizeHtml(html: string): string {
  let out = String(html);
  // Blank volatile attribute values first (preserve attr name + quote style).
  out = out.replace(NONCE_ATTR_RE, '$1$2$2');
  out = out.replace(INTEGRITY_ATTR_RE, '$1$2$2');
  // Then apply the generic dynamic-value/secret scrubbing over the whole string.
  out = normalizeText(out);
  return out;
}
