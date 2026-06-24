// Owned by Wave 1 / Agent H (OpenAPI 3.1 builder).
// buildOpenApiByHost: per host, group calls by (method, templated path), infer
// path/query params and merge request/response body schemas across samples into
// an OpenAPI 3.1 document. renderOpenApi: pretty JSON string.
import type { ApiCall, RunConfig } from '../types';
import { inferSchema, mergeSchemas, templatePath } from './schema';
import type { JsonSchema } from './schema';

/** Minimal shape the orchestrator relies on (it counts `paths` operations). */
export interface OpenApiDoc {
  openapi: string;
  info: Record<string, unknown>;
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export function buildOpenApiByHost(
  calls: ApiCall[],
  _cfg: RunConfig,
): Record<string, OpenApiDoc> {
  if (!calls || calls.length === 0) return {};

  // 1. Group by host.
  const byHost = new Map<string, ApiCall[]>();
  for (const call of calls) {
    const host = call.host;
    const arr = byHost.get(host);
    if (arr) arr.push(call);
    else byHost.set(host, [call]);
  }

  const out: Record<string, OpenApiDoc> = {};

  for (const [host, hostCalls] of byHost) {
    const siblings = hostCalls.map((c) => c.pathname);

    // Group by `${METHOD} ${template}`, tracking the template per group.
    interface Group {
      method: string;
      template: string;
      params: string[];
      calls: ApiCall[];
    }
    const groups = new Map<string, Group>();

    for (const call of hostCalls) {
      const { template, params } = templatePath(call.pathname, siblings);
      const method = call.method.toUpperCase();
      const key = `${method} ${template}`;
      let group = groups.get(key);
      if (!group) {
        group = { method, template, params, calls: [] };
        groups.set(key, group);
      }
      group.calls.push(call);
    }

    const paths: Record<string, Record<string, unknown>> = {};

    for (const group of groups.values()) {
      const operation = buildOperation(group.method, group.template, group.params, group.calls);
      const pathItem = paths[group.template] ?? (paths[group.template] = {});
      pathItem[group.method.toLowerCase()] = operation;
    }

    out[host] = {
      openapi: '3.1.0',
      info: {
        title: `${host} (inferred API)`,
        version: '0.0.0',
        description:
          'Inferred from observed network traffic by screenshotter — not authoritative.',
      },
      servers: [{ url: `https://${host}` }],
      paths,
    };
  }

  return out;
}

interface Parameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: JsonSchema;
}

function buildOperation(
  method: string,
  template: string,
  pathParams: string[],
  calls: ApiCall[],
): Record<string, unknown> {
  const operation: Record<string, unknown> = {
    summary: `${method} ${template}`,
  };

  // ── Parameters ──
  const parameters: Parameter[] = [];
  for (const name of pathParams) {
    parameters.push({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    });
  }

  // Union of query keys across the group; first-seen value drives the schema.
  const queryFirstValue = new Map<string, string | string[]>();
  for (const call of calls) {
    const q = call.query ?? {};
    for (const key of Object.keys(q)) {
      if (!queryFirstValue.has(key)) queryFirstValue.set(key, q[key]);
    }
  }
  for (const [name, value] of queryFirstValue) {
    parameters.push({
      name,
      in: 'query',
      required: false,
      schema: queryParamSchema(value),
    });
  }

  if (parameters.length > 0) operation.parameters = parameters;

  // ── GraphQL operation hint (when present on these calls) ──
  const gqlOps = new Set<string>();
  for (const c of calls) {
    const op = graphqlOperationName(c);
    if (op) gqlOps.add(op);
  }
  if (gqlOps.size > 0) {
    operation['x-graphql-operations'] = [...gqlOps].sort();
  }

  // ── Request body ── merge schemas across ALL samples (covers multi-variant
  // endpoints: different shapes for the same method+path are unioned via anyOf),
  // and attach distinct request examples so the rebuild sees real payloads.
  const reqCalls = calls.filter((c) => c.requestBody !== undefined);
  if (reqCalls.length > 0) {
    let schema: JsonSchema | undefined;
    for (const c of reqCalls) {
      const s = inferSchema(c.requestBody);
      schema = schema === undefined ? s : mergeSchemas(schema, s);
    }
    operation.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: schema ?? {},
          example: reqCalls[0].requestBody,
          ...(reqCalls.length > 1 ? { examples: buildExamples(reqCalls.map((c) => c.requestBody)) } : {}),
        },
      },
    };
  }

  // ── Responses ──
  const byStatus = new Map<string, ApiCall[]>();
  for (const call of calls) {
    const key = String(call.status);
    const arr = byStatus.get(key);
    if (arr) arr.push(call);
    else byStatus.set(key, [call]);
  }

  const responses: Record<string, unknown> = {};
  for (const [status, statusCalls] of byStatus) {
    const withBody = statusCalls.filter((c) => c.responseBody !== undefined);
    if (withBody.length > 0) {
      let schema: JsonSchema | undefined;
      for (const c of withBody) {
        const s = inferSchema(c.responseBody);
        schema = schema === undefined ? s : mergeSchemas(schema, s);
      }
      responses[status] = {
        description: statusText(status),
        content: {
          'application/json': {
            schema: schema ?? {},
            example: withBody[0].responseBody,
            ...(withBody.length > 1 ? { examples: buildExamples(withBody.map((c) => c.responseBody)) } : {}),
          },
        },
      };
    } else {
      responses[status] = { description: statusText(status) };
    }
  }
  operation.responses = responses;

  return operation;
}

/** Extract a GraphQL operationName from a call's request body, if any. */
function graphqlOperationName(call: ApiCall): string | undefined {
  if (!/graphql/i.test(call.pathname) && !/graphql/i.test(call.url)) return undefined;
  const b = call.requestBody;
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    const op = (b as Record<string, unknown>).operationName;
    if (typeof op === 'string' && op) return op;
    const q = (b as Record<string, unknown>).query;
    if (typeof q === 'string') {
      const m = q.match(/\b(query|mutation|subscription)\s+([A-Za-z0-9_]+)/);
      if (m) return m[2];
    }
  }
  return undefined;
}

/** Build an OpenAPI `examples` map from up to a few distinct sample bodies. */
function buildExamples(bodies: unknown[]): Record<string, { value: unknown }> {
  const out: Record<string, { value: unknown }> = {};
  const seen = new Set<string>();
  let i = 1;
  for (const body of bodies) {
    let key: string;
    try {
      key = JSON.stringify(body);
    } catch {
      key = String(body);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out[`sample${i++}`] = { value: body };
    if (i > 5) break; // cap example count
  }
  return out;
}

const STATUS_TEXT: Record<string, string> = {
  '200': 'OK',
  '201': 'Created',
  '202': 'Accepted',
  '204': 'No Content',
  '301': 'Moved Permanently',
  '302': 'Found',
  '304': 'Not Modified',
  '400': 'Bad Request',
  '401': 'Unauthorized',
  '403': 'Forbidden',
  '404': 'Not Found',
  '409': 'Conflict',
  '422': 'Unprocessable Entity',
  '429': 'Too Many Requests',
  '500': 'Internal Server Error',
  '502': 'Bad Gateway',
  '503': 'Service Unavailable',
};

function statusText(status: string): string {
  return STATUS_TEXT[status] ?? '';
}

/**
 * Schema for a query parameter from its first-seen value. Query values are
 * strings (or string arrays) on the wire, so we keep them as strings/arrays of
 * strings — numeric-looking values are still typed as string.
 */
function queryParamSchema(value: string | string[]): JsonSchema {
  if (Array.isArray(value)) {
    return { type: 'array', items: { type: 'string' } };
  }
  return { type: 'string' };
}

export function renderOpenApi(doc: OpenApiDoc): string {
  return JSON.stringify(doc, null, 2);
}
