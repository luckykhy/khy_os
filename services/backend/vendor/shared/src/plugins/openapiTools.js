/**
 * OpenAPI → tool projection (single source of truth).
 *
 * A Coze/ChatGPT-lineage plugin is an OpenAPI-3 document: every `path + method`
 * is one callable operation, and each operation becomes one tool the workflow
 * `toolCall` node and the chat Agent can invoke. This module is the ONE place
 * that turns an OpenAPI doc into:
 *   - a flat list of operations (listOperations),
 *   - a JSON-Schema parameter object per operation (operationParamSchema),
 *   - the stable tool name `plugin__<slug>__<operationId>` (toolName/parseToolName).
 *
 * Both the importer (ai-backend) and the runtime invoker/bridge (backend) consume
 * this, so the operation set never drifts between "what was imported" and "what
 * is callable".
 *
 * Scope: a pragmatic OpenAPI-3 subset (the shape Coze plugins emit). It resolves
 * local `#/components/...` $refs shallowly; it does not chase remote refs.
 *
 * @module plugins/openapiTools
 */
'use strict';

const TOOL_PREFIX = 'plugin__';
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** Build the stable tool name for an operation. */
function toolName(slug, operationId) {
  return `${TOOL_PREFIX}${slug}__${operationId}`;
}

/** Parse `plugin__<slug>__<operationId>` → { slug, operationId } or null. */
function parseToolName(name) {
  if (typeof name !== 'string' || !name.startsWith(TOOL_PREFIX)) return null;
  const rest = name.slice(TOOL_PREFIX.length);
  const sep = rest.indexOf('__');
  if (sep <= 0 || sep >= rest.length - 2) return null;
  return { slug: rest.slice(0, sep), operationId: rest.slice(sep + 2) };
}

/** True if a tool name is a plugin-dispatch name. */
function isPluginTool(name) {
  return parseToolName(name) != null;
}

// ── $ref resolution (local components only) ─────────────────────────────────

function _resolveRef(doc, ref, seen) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = doc;
  for (const p of parts) {
    if (node == null || typeof node !== 'object') return null;
    node = node[p];
  }
  if (node && typeof node === 'object' && node.$ref) {
    if (seen.has(node.$ref)) return {}; // cycle guard
    seen.add(node.$ref);
    return _resolveRef(doc, node.$ref, seen);
  }
  return node;
}

/** Deref a node one level (follows $ref against the doc). */
function _deref(doc, node, seen = new Set()) {
  if (node && typeof node === 'object' && node.$ref) {
    return _resolveRef(doc, node.$ref, seen) || {};
  }
  return node;
}

// ── Operation listing ───────────────────────────────────────────────────────

/**
 * Flatten an OpenAPI doc into operations.
 * @param {object} openapi
 * @returns {Array<{operationId,method,path,summary,description}>}
 */
function listOperations(openapi) {
  const doc = openapi && typeof openapi === 'object' ? openapi : {};
  const paths = doc.paths && typeof doc.paths === 'object' ? doc.paths : {};
  const ops = [];
  const usedIds = new Set();

  for (const [routePath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;
      let id = typeof op.operationId === 'string' && op.operationId.trim()
        ? op.operationId.trim()
        : _syntheticId(method, routePath);
      id = _sanitizeId(id);
      // Guarantee uniqueness within the doc.
      let unique = id;
      let n = 2;
      while (usedIds.has(unique)) unique = `${id}_${n++}`;
      usedIds.add(unique);
      ops.push({
        operationId: unique,
        method: method.toUpperCase(),
        path: routePath,
        summary: typeof op.summary === 'string' ? op.summary : '',
        description: typeof op.description === 'string' ? op.description : '',
      });
    }
  }
  return ops;
}

function _syntheticId(method, routePath) {
  const cleaned = String(routePath || '')
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${method}_${cleaned || 'root'}`;
}

function _sanitizeId(id) {
  // Tool names embed operationId; keep it to a safe charset and avoid the "__"
  // separator so parseToolName can split unambiguously.
  return String(id).replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/__+/g, '_');
}

/** Find the raw operation object (with its path/method) by operationId. */
function findOperation(openapi, operationId) {
  const doc = openapi && typeof openapi === 'object' ? openapi : {};
  const meta = listOperations(doc).find((o) => o.operationId === operationId);
  if (!meta) return null;
  const pathItem = (doc.paths || {})[meta.path] || {};
  const raw = pathItem[meta.method.toLowerCase()] || {};
  return {
    ...meta,
    raw,
    pathItemParameters: Array.isArray(pathItem.parameters) ? pathItem.parameters : [],
  };
}

// ── Parameter schema projection ─────────────────────────────────────────────

/**
 * Build a JSON-Schema object describing the operation's inputs: each path/query/
 * header parameter is a top-level property; a JSON request body is nested under
 * `body`. Used for the tool's input schema and for runtime arg binding.
 *
 * @param {object} openapi
 * @param {string} operationId
 * @returns {{schema:object, params:Array, body:object|null}}
 */
function operationParamSchema(openapi, operationId) {
  const doc = openapi && typeof openapi === 'object' ? openapi : {};
  const op = findOperation(doc, operationId);
  if (!op) return { schema: { type: 'object', properties: {}, additionalProperties: true }, params: [], body: null };

  const properties = {};
  const required = [];
  const params = [];

  // Path-item params merged with operation params (operation overrides by name+in).
  const merged = _mergeParams(op.pathItemParameters, op.raw.parameters);
  for (const rawP of merged) {
    const p = _deref(doc, rawP);
    if (!p || !p.name || !p.in) continue;
    const sch = _deref(doc, p.schema) || { type: 'string' };
    properties[p.name] = _slimSchema(sch, p.description);
    if (p.required) required.push(p.name);
    params.push({ name: p.name, in: p.in, required: !!p.required, schema: sch });
  }

  // Request body (application/json only).
  let body = null;
  const rb = _deref(doc, op.raw.requestBody);
  if (rb && rb.content && typeof rb.content === 'object') {
    const json = rb.content['application/json'] || rb.content['application/*+json'];
    if (json) {
      const bodySchema = _deref(doc, json.schema) || { type: 'object' };
      properties.body = _slimSchema(bodySchema, 'Request body (JSON)');
      if (rb.required) required.push('body');
      body = { contentType: 'application/json', schema: bodySchema, required: !!rb.required };
    }
  }

  const schema = { type: 'object', properties, additionalProperties: true };
  if (required.length) schema.required = required;
  return { schema, params, body };
}

function _mergeParams(pathLevel, opLevel) {
  const out = [];
  const seen = new Set();
  const key = (p) => `${p && p.in}:${p && p.name}`;
  for (const p of (Array.isArray(opLevel) ? opLevel : [])) {
    if (p && p.name) { out.push(p); seen.add(key(p)); }
  }
  for (const p of (Array.isArray(pathLevel) ? pathLevel : [])) {
    if (p && p.name && !seen.has(key(p))) out.push(p);
  }
  return out;
}

/**
 * Trim an OpenAPI schema down to the JSON-Schema fields a model needs, dropping
 * vendor extensions. Keeps it shallow-safe (does not fully expand nested $refs).
 */
function _slimSchema(schema, description) {
  if (!schema || typeof schema !== 'object') return { type: 'string' };
  const out = {};
  const keep = ['type', 'enum', 'format', 'items', 'properties', 'required', 'default', 'description'];
  for (const k of keep) if (schema[k] !== undefined) out[k] = schema[k];
  if (!out.type && (out.properties || out.items)) out.type = out.properties ? 'object' : 'array';
  if (!out.type) out.type = 'string';
  if (description && !out.description) out.description = description;
  return out;
}

/**
 * Project one operation into a tool descriptor consumed by the agent/tool layer.
 * @returns {{name,description,input_schema,operationId,method,path}}
 */
function operationToTool(openapi, slug, operationId) {
  const op = findOperation(openapi, operationId);
  const { schema } = operationParamSchema(openapi, operationId);
  const desc = (op && (op.summary || op.description)) || `${op ? op.method : 'CALL'} ${op ? op.path : operationId}`;
  return {
    name: toolName(slug, operationId),
    description: desc.slice(0, 1024),
    input_schema: schema,
    operationId,
    method: op ? op.method : 'GET',
    path: op ? op.path : '/',
  };
}

module.exports = {
  TOOL_PREFIX,
  HTTP_METHODS,
  toolName,
  parseToolName,
  isPluginTool,
  listOperations,
  findOperation,
  operationParamSchema,
  operationToTool,
  // internal, exported for tests
  _deref,
  _slimSchema,
};
