// PHASE 2 — content/entity extraction. OWNED by Lane 2.
// Normalizes captured API JSON bodies + listing rows into an entity/relationship
// graph (models, datasets, orgs, users, files…) that a stateful twin can re-serve.
import type {
  ApiFixture,
  Entity,
  EntityGraph,
  EntityRef,
  ListingExtract,
  ListingRow,
} from '../types';

export interface EntityInput {
  fixtures: ApiFixture[];
  listings: ListingExtract[];
  /** Base URL, used to derive entity ids/types from paths. */
  baseUrl: string;
}

/** Plural/singular path segment → canonical entity type. */
const TYPE_MAP: Record<string, string> = {
  models: 'model',
  model: 'model',
  datasets: 'dataset',
  dataset: 'dataset',
  orgs: 'org',
  org: 'org',
  organizations: 'org',
  organization: 'org',
  users: 'user',
  user: 'user',
  members: 'user',
  files: 'file',
  file: 'file',
  blob: 'file',
  resolve: 'file',
  spaces: 'space',
  space: 'space',
  collections: 'collection',
  collection: 'collection',
  papers: 'paper',
  paper: 'paper',
};

const ID_KEYS = ['id', '_id', 'name', 'slug', 'fullName', 'full_name', 'modelId', 'login'];
const MAX_ENTITIES = 5000;

/** Stable "type/id" key for an entity reference. */
function refKey(type: string, id: string): string {
  return `${type}/${id}`;
}

/** Map a raw path segment to a canonical entity type, if recognized. */
function typeForSegment(seg: string): string | undefined {
  return TYPE_MAP[seg.toLowerCase()];
}

/** Derive {type,id} from a templated/concrete path, e.g. /api/models/gpt2 → model/gpt2. */
function typeIdFromPath(pathname: string): { type: string; id?: string } | undefined {
  const segs = pathname.split('/').filter((s) => s && !s.startsWith('{') && s !== 'api');
  for (let i = 0; i < segs.length; i++) {
    const type = typeForSegment(segs[i]);
    if (type) {
      // The next non-placeholder segment is the id (e.g. models/<id>).
      const id = segs[i + 1] && !TYPE_MAP[segs[i + 1].toLowerCase()] ? segs[i + 1] : undefined;
      return { type, id };
    }
  }
  return undefined;
}

/** Pull a usable id out of a record object. */
function idFromRecord(rec: Record<string, unknown>, fallback?: string): string | undefined {
  for (const k of ID_KEYS) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return fallback;
}

/** A small set of scalar/array fields worth keeping as entity fields. */
function pickFields(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const [k, v] of Object.entries(rec)) {
    if (kept >= 40) break;
    if (v === null) continue;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      out[k] = v;
      kept++;
    } else if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) {
      out[k] = v.slice(0, 50);
      kept++;
    }
  }
  return out;
}

/** Common keys that point at a related author/org/dataset. */
const REL_KEYS: { keys: string[]; rel: string; toType: string }[] = [
  { keys: ['author', 'owner', 'createdBy', 'created_by', 'user', 'login'], rel: 'author', toType: 'user' },
  { keys: ['org', 'organization', 'namespace'], rel: 'in-org', toType: 'org' },
  { keys: ['dataset', 'datasets', 'trainedOn', 'trained_on'], rel: 'uses-dataset', toType: 'dataset' },
];

/**
 * Build a normalized entity/relationship graph from captured API JSON + listing
 * rows. Pure, defensive, never throws. Dedupes entities by type/id; merges fields.
 */
export function buildEntityGraph(input: EntityInput): EntityGraph {
  const entities = new Map<string, Entity>();
  const relSet = new Set<string>();
  const relationships: EntityRef[] = [];

  const fixtures = Array.isArray(input?.fixtures) ? input.fixtures : [];
  const listings = Array.isArray(input?.listings) ? input.listings : [];

  const upsert = (type: string, id: string, fields: Record<string, unknown>, url?: string): void => {
    if (entities.size >= MAX_ENTITIES && !entities.has(refKey(type, id))) return;
    const key = refKey(type, id);
    const existing = entities.get(key);
    if (existing) {
      Object.assign(existing.fields, fields);
      if (!existing.url && url) existing.url = url;
    } else {
      entities.set(key, { type, id, fields, ...(url ? { url } : {}) });
    }
  };

  const addRel = (from: string, to: string, rel: string): void => {
    const k = `${from}|${rel}|${to}`;
    if (relSet.has(k)) return;
    relSet.add(k);
    relationships.push({ from, to, rel });
  };

  // Add relationships from a record's known author/org/dataset keys.
  const linkRecord = (fromType: string, fromId: string, rec: Record<string, unknown>): void => {
    for (const { keys, rel, toType } of REL_KEYS) {
      for (const k of keys) {
        const v = rec[k];
        if (typeof v === 'string' && v.trim()) {
          const toId = v.trim();
          upsert(toType, toId, {});
          addRel(refKey(fromType, fromId), refKey(toType, toId), rel);
          break;
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
          const toId = idFromRecord(v as Record<string, unknown>);
          if (toId) {
            upsert(toType, toId, pickFields(v as Record<string, unknown>));
            addRel(refKey(fromType, fromId), refKey(toType, toId), rel);
            break;
          }
        } else if (Array.isArray(v)) {
          for (const item of v.slice(0, 20)) {
            if (typeof item === 'string' && item.trim()) {
              upsert(toType, item.trim(), {});
              addRel(refKey(fromType, fromId), refKey(toType, item.trim()), rel);
            } else if (item && typeof item === 'object') {
              const toId = idFromRecord(item as Record<string, unknown>);
              if (toId) {
                upsert(toType, toId, pickFields(item as Record<string, unknown>));
                addRel(refKey(fromType, fromId), refKey(toType, toId), rel);
              }
            }
          }
          break;
        }
      }
    }
  };

  // Ingest one JSON value (object or array) for a given inferred type.
  const ingestValue = (type: string, value: unknown, fallbackId?: string, url?: string): void => {
    if (Array.isArray(value)) {
      value.slice(0, 500).forEach((item, i) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          ingestValue(type, item, `${fallbackId ?? type}-${i}`);
        }
      });
      return;
    }
    if (!value || typeof value !== 'object') return;
    const rec = value as Record<string, unknown>;
    const id = idFromRecord(rec, fallbackId);
    if (!id) return;
    upsert(type, id, pickFields(rec), url);
    linkRecord(type, id, rec);
  };

  // ── 1. Fixtures: derive entity type from the path, ingest the response body. ──
  for (const fx of fixtures) {
    if (!fx) continue;
    const path = fx.pathTemplate || '';
    const ti = typeIdFromPath(path);
    if (!ti) continue;
    const body = fx.response;
    if (body == null) continue;
    // If the body wraps the collection (e.g. { items: [...] } / { data: [...] }),
    // descend into the first array-valued field.
    let target: unknown = body;
    if (!Array.isArray(body) && body && typeof body === 'object') {
      const rec = body as Record<string, unknown>;
      const arrKey = Object.keys(rec).find((k) => Array.isArray(rec[k]));
      if (arrKey && !idFromRecord(rec)) target = rec[arrKey];
    }
    ingestValue(ti.type, target, ti.id, fx.url);
  }

  // ── 2. Listing rows: each row is an entity of the page's inferred type. ──
  for (const listing of listings) {
    if (!listing || !Array.isArray(listing.rows)) continue;
    const ti = pathTypeFromUrl(listing.pageUrl) || inferTypeFromLabel(listing.page);
    const type = ti || 'item';
    listing.rows.forEach((row: ListingRow, i: number) => {
      const fields: Record<string, unknown> = { ...(row.fields || {}) };
      // Prefer an id from the row href's last path segment, else title, else index.
      let id: string | undefined;
      if (row.href) {
        try {
          const segs = new URL(row.href).pathname.split('/').filter(Boolean);
          id = segs[segs.length - 1];
        } catch {
          /* ignore */
        }
      }
      if (!id) id = (row.fields?.title || row.fields?.link || '').slice(0, 80) || undefined;
      if (!id) id = `${listing.page}-${i}`;
      upsert(type, id, fields, row.href);
    });
  }

  return { entities: Array.from(entities.values()), relationships };
}

/** Infer an entity type from a listing page URL's path. */
function pathTypeFromUrl(url: string): string | undefined {
  try {
    const ti = typeIdFromPath(new URL(url).pathname);
    return ti?.type;
  } catch {
    return undefined;
  }
}

/** Infer an entity type from a page label like "models-index" or "datasets". */
function inferTypeFromLabel(label: string): string | undefined {
  const l = (label || '').toLowerCase();
  for (const seg of Object.keys(TYPE_MAP)) {
    if (l.includes(seg)) return TYPE_MAP[seg];
  }
  return undefined;
}
