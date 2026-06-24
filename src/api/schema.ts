// Owned by Wave 1 / Agent H (JSON-schema inference + path templating).
// inferSchema: JSON value → JSON Schema. mergeSchemas: union two schemas across
// samples (merge object props; required = intersection of present keys; merge
// array item schemas). templatePath: collapse id-like path segments to {param}.

/** Loose JSON Schema shape (OpenAPI 3.1-compatible). */
export type JsonSchema = Record<string, unknown>;

/** Max recursion depth for inference; beyond this we emit `{}`. */
const MAX_DEPTH = 8;
/** Max array elements sampled when inferring item schema. */
const ARRAY_SAMPLE = 20;

/** JSON value → JSON Schema (OpenAPI 3.1 dialect). */
export function inferSchema(value: unknown): JsonSchema {
  return inferSchemaAt(value, 0);
}

function inferSchemaAt(value: unknown, depth: number): JsonSchema {
  if (depth >= MAX_DEPTH) return {};

  if (value === null) return { type: 'null' };

  const t = typeof value;
  if (t === 'boolean') return { type: 'boolean' };
  if (t === 'number') {
    return { type: Number.isInteger(value as number) ? 'integer' : 'number' };
  }
  if (t === 'string') return { type: 'string' };

  if (Array.isArray(value)) {
    if (value.length === 0) return { type: 'array', items: {} };
    let items: JsonSchema | undefined;
    const sample = value.slice(0, ARRAY_SAMPLE);
    for (const el of sample) {
      const elSchema = inferSchemaAt(el, depth + 1);
      items = items === undefined ? elSchema : mergeSchemas(items, elSchema);
    }
    return { type: 'array', items: items ?? {} };
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const key of Object.keys(obj)) {
      properties[key] = inferSchemaAt(obj[key], depth + 1);
      required.push(key);
    }
    return { type: 'object', properties, required };
  }

  // Unknown (undefined, function, symbol, bigint) — treat as unconstrained.
  return {};
}

function isEmptySchema(s: JsonSchema): boolean {
  return s !== null && typeof s === 'object' && Object.keys(s).length === 0;
}

/** Collect the branch list from a schema, expanding any nested anyOf. */
function anyOfBranches(s: JsonSchema): JsonSchema[] {
  if (Array.isArray((s as { anyOf?: unknown }).anyOf)) {
    const branches = (s as { anyOf: JsonSchema[] }).anyOf;
    const out: JsonSchema[] = [];
    for (const b of branches) out.push(...anyOfBranches(b));
    return out;
  }
  return [s];
}

/** Stable key for dedupe of anyOf branches. */
function schemaKey(s: JsonSchema): string {
  return canonicalString(s);
}

function canonicalString(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalString(v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalString(obj[k])).join(',') +
    '}'
  );
}

function combineAnyOf(a: JsonSchema, b: JsonSchema): JsonSchema {
  const branches = [...anyOfBranches(a), ...anyOfBranches(b)];
  const seen = new Set<string>();
  const deduped: JsonSchema[] = [];
  for (const br of branches) {
    if (isEmptySchema(br)) continue; // empty contributes nothing to a union
    const key = schemaKey(br);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(br);
  }
  if (deduped.length === 0) return {};
  if (deduped.length === 1) return deduped[0];
  return { anyOf: deduped };
}

/** Merge two schemas describing samples of the same field. */
export function mergeSchemas(a: JsonSchema, b: JsonSchema): JsonSchema {
  if (isEmptySchema(a)) return b;
  if (isEmptySchema(b)) return a;

  const aAnyOf = Array.isArray((a as { anyOf?: unknown }).anyOf);
  const bAnyOf = Array.isArray((b as { anyOf?: unknown }).anyOf);
  if (aAnyOf || bAnyOf) {
    return combineAnyOf(a, b);
  }

  const aType = a.type;
  const bType = b.type;

  if (aType === 'object' && bType === 'object') {
    return mergeObjectSchemas(a, b);
  }

  if (aType === 'array' && bType === 'array') {
    const aItems = (a.items as JsonSchema | undefined) ?? {};
    const bItems = (b.items as JsonSchema | undefined) ?? {};
    return { type: 'array', items: mergeSchemas(aItems, bItems) };
  }

  // Scalar handling (and any same-typed schemas without special structure).
  if (
    typeof aType === 'string' &&
    typeof bType === 'string' &&
    aType === bType
  ) {
    return { type: aType };
  }

  // integer + number → number (numeric widening, either order).
  const numeric = new Set([aType, bType]);
  if (numeric.has('integer') && numeric.has('number') && numeric.size === 2) {
    return { type: 'number' };
  }

  // Differing types → anyOf union.
  return combineAnyOf(a, b);
}

function mergeObjectSchemas(a: JsonSchema, b: JsonSchema): JsonSchema {
  const aProps = (a.properties as Record<string, JsonSchema> | undefined) ?? {};
  const bProps = (b.properties as Record<string, JsonSchema> | undefined) ?? {};
  const merged: Record<string, JsonSchema> = {};

  const allKeys = new Set([...Object.keys(aProps), ...Object.keys(bProps)]);
  for (const key of allKeys) {
    const av = aProps[key];
    const bv = bProps[key];
    if (av !== undefined && bv !== undefined) {
      merged[key] = mergeSchemas(av, bv);
    } else {
      merged[key] = (av ?? bv) as JsonSchema;
    }
  }

  const aReq = Array.isArray(a.required) ? (a.required as string[]) : [];
  const bReq = new Set(Array.isArray(b.required) ? (b.required as string[]) : []);
  const required = aReq.filter((k) => bReq.has(k));

  return { type: 'object', properties: merged, required };
}

// ── Path templating ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{12,}$/i;
const NUM_RE = /^\d+$/;

function splitSegments(pathname: string): string[] {
  // Drop leading/trailing slashes; keep interior empties out.
  return pathname.split('/').filter((s) => s.length > 0);
}

function singularize(word: string): string {
  if (word.length > 1 && /s$/i.test(word)) return word.slice(0, -1);
  return word;
}

function looksLikeId(seg: string): boolean {
  return NUM_RE.test(seg) || UUID_RE.test(seg) || HEX_RE.test(seg);
}

/**
 * A varying segment is only treated as a path PARAM when its value looks like an
 * identifier (has a digit, or is long), NOT a route name. This prevents distinct
 * endpoints like /api/models, /api/datasets, /api/users from collapsing into a
 * bogus /api/{api}: short alphabetic words are route names, not ids.
 */
function looksLikeIdValue(seg: string): boolean {
  return looksLikeId(seg) || /\d/.test(seg) || seg.length >= 16;
}

/**
 * Returns a templated path (e.g. "/models/gpt2" → "/models/{id}") and the names
 * of any path params discovered, given sibling pathnames for the same host.
 */
export function templatePath(
  pathname: string,
  siblings: string[],
): { template: string; params: string[] } {
  const segs = splitSegments(pathname);
  const n = segs.length;

  // Siblings with the same segment count, used for variance detection.
  const sameCount = siblings
    .map(splitSegments)
    .filter((s) => s.length === n);

  // A segment "varies" if, among siblings sharing the same count AND identical
  // values in every OTHER segment position, more than one distinct value appears
  // at this position.
  const variesAt = (idx: number): boolean => {
    const matching = sameCount.filter((other) => {
      for (let j = 0; j < n; j++) {
        if (j === idx) continue;
        if (other[j] !== segs[j]) return false;
      }
      return true;
    });
    if (matching.length < 2) return false;
    const distinct = new Set(matching.map((m) => m[idx]));
    return distinct.size > 1;
  };

  const usedNames = new Set<string>();
  const params: string[] = [];
  const outSegs: string[] = [];
  const isParamAt: boolean[] = [];

  for (let i = 0; i < n; i++) {
    const seg = segs[i];
    // Always-id (numeric/uuid/hex), or varies across siblings AND looks like an
    // identifier value (not a route-name word).
    const isParam = looksLikeId(seg) || (variesAt(i) && looksLikeIdValue(seg));
    isParamAt[i] = isParam;
    if (!isParam) {
      outSegs.push(seg);
      continue;
    }

    // Derive name from the preceding STATIC (non-param) segment.
    let base = 'id';
    for (let p = i - 1; p >= 0; p--) {
      if (isParamAt[p]) continue; // skip earlier params
      base = singularize(segs[p]) || 'id';
      break;
    }
    if (!base) base = 'id';

    let name = base;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = base + String(suffix);
      suffix++;
    }
    usedNames.add(name);
    params.push(name);
    outSegs.push('{' + name + '}');
  }

  const template = '/' + outSegs.join('/');
  return { template, params };
}
