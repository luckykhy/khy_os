/**
 * Per-user workflow CRUD service (multi-tenant).
 *
 * Backs the `/api/workflow` routes. Every query is scoped to a `userId`, so a
 * user can only ever read/write their own workflows. The canvas graph
 * ({ nodes, connections }) is stored verbatim in `UserWorkflow.graphJson` and
 * is the single source of truth; the Markdown export pipeline derives skill /
 * agent artifacts from it (see workflowExportService).
 *
 * Table creation: ai-backend only calls `sequelize.authenticate()` (the trading
 * backend owns the global `sequelize.sync`). To stay self-contained regardless
 * of boot order, we lazily `UserWorkflow.sync()` once on first use — a
 * model-level sync touches only `user_workflows`, never other tables.
 *
 * @pattern Repository
 */
'use strict';

const { UserWorkflow } = require('@khy/shared/models');
const { portsFor, getNodeType } = require('@khy/shared/workflow/nodeCatalog');
const { getTemplate, listTemplateSummaries } = require('@khy/shared/workflow/templates');

// ── Table bootstrap (idempotent, model-scoped) ──────────────────────────────

let tableReady = null;
async function ensureTable() {
  if (!tableReady) {
    // Model-level sync: creates only user_workflows if missing; no-op otherwise.
    tableReady = UserWorkflow.sync().catch((err) => {
      tableReady = null; // allow retry on transient failure
      throw err;
    });
  }
  return tableReady;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const NAME_RE = /^[\w一-龥 .\-]{1,80}$/;

// 收敛到 utils/httpError 单一真源(逐字节委托,调用点不变)
const httpError = require('../../../backend/src/utils/httpError');

function normalizeName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (!NAME_RE.test(name)) {
    throw httpError(400, 'Invalid workflow name (1-80 chars: letters, digits, CJK, space, dot, dash, underscore)');
  }
  return name;
}

function emptyGraph() {
  return { nodes: [], connections: [] };
}

// ── Graph validation ─────────────────────────────────────────────────────────

const MAX_NODES = 100;
const MAX_EDGES = 300;

/**
 * Validate a canvas graph against the node catalog.
 *
 * Two layers:
 *   - integrity (always): bounded size, unique node/connection ids, known node
 *     types, endpoints resolve, and ports match the catalog spec. Enforced on
 *     every save so a malformed graph never persists.
 *   - completeness (strict only): exactly one start with no inbound edges and at
 *     least one end with no outbound edges. Required to export/run, NOT to save a
 *     work-in-progress — so an empty or half-built graph still saves cleanly.
 *
 * Throws httpError(400, ...) on the first batch of violations; returns true when
 * the graph is acceptable.
 */
function validateGraph(graph, { strict = false } = {}) {
  if (!graph || typeof graph !== 'object') {
    throw httpError(400, 'graph must be an object');
  }
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const conns = Array.isArray(graph.connections) ? graph.connections : [];
  const errors = [];

  if (nodes.length > MAX_NODES) errors.push(`too many nodes (${nodes.length} > ${MAX_NODES})`);
  if (conns.length > MAX_EDGES) errors.push(`too many connections (${conns.length} > ${MAX_EDGES})`);

  // Nodes: unique id + known type.
  const nodeById = new Map();
  for (const n of nodes) {
    if (!n || typeof n !== 'object') { errors.push('invalid node entry'); continue; }
    if (!n.id) { errors.push('node missing id'); continue; }
    if (nodeById.has(n.id)) { errors.push(`duplicate node id: ${n.id}`); continue; }
    nodeById.set(n.id, n);
    if (!getNodeType(n.type)) errors.push(`unknown node type '${n.type}' (node ${n.id})`);
  }

  // Connections: unique id, endpoints exist, ports valid for the catalog.
  const connIds = new Set();
  const inbound = new Map();
  const outbound = new Map();
  for (const c of conns) {
    if (!c || typeof c !== 'object') { errors.push('invalid connection entry'); continue; }
    if (c.id) {
      if (connIds.has(c.id)) errors.push(`duplicate connection id: ${c.id}`);
      else connIds.add(c.id);
    }
    const src = nodeById.get(c.from);
    const dst = nodeById.get(c.to);
    if (!src) { errors.push(`connection ${c.id || ''} references unknown source node '${c.from}'`); continue; }
    if (!dst) { errors.push(`connection ${c.id || ''} references unknown target node '${c.to}'`); continue; }
    const fromPort = c.fromPort || 'default';
    const toPort = c.toPort || 'input';
    if (!portsFor(src.type).outputs.includes(fromPort)) {
      errors.push(`invalid source port '${fromPort}' on ${src.type} (node ${src.id})`);
    }
    if (!portsFor(dst.type).inputs.includes(toPort)) {
      errors.push(`invalid target port '${toPort}' on ${dst.type} (node ${dst.id})`);
    }
    outbound.set(c.from, (outbound.get(c.from) || 0) + 1);
    inbound.set(c.to, (inbound.get(c.to) || 0) + 1);
  }

  if (strict) {
    const starts = nodes.filter((n) => n && n.type === 'start');
    const ends = nodes.filter((n) => n && n.type === 'end');
    if (starts.length !== 1) errors.push(`graph must have exactly one start node (found ${starts.length})`);
    for (const s of starts) {
      if (inbound.get(s.id)) errors.push(`start node ${s.id} must have no inbound connections`);
    }
    if (ends.length < 1) errors.push('graph must have at least one end node');
    for (const e of ends) {
      if (outbound.get(e.id)) errors.push(`end node ${e.id} must have no outbound connections`);
    }
  }

  if (errors.length) {
    throw httpError(400, `Invalid graph: ${errors.join('; ')}`);
  }
  return true;
}

// Summary row for list views — no heavy graph payload.
function toSummary(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    version: row.version,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

// Full row including the canvas graph.
function toFull(row) {
  return {
    ...toSummary(row),
    graph: row.graphJson || emptyGraph(),
  };
}

// ── CRUD ────────────────────────────────────────────────────────────────────

async function list(userId) {
  await ensureTable();
  const rows = await UserWorkflow.findAll({
    where: { userId },
    order: [['updatedAt', 'DESC'], ['id', 'DESC']],
  });
  return rows.map(toSummary);
}

async function get(userId, id) {
  await ensureTable();
  const row = await UserWorkflow.findOne({ where: { userId, id } });
  if (!row) throw httpError(404, 'Workflow not found');
  return toFull(row);
}

async function create(userId, body = {}) {
  await ensureTable();
  const name = normalizeName(body.name || 'Untitled workflow');
  const graph = body.graph && typeof body.graph === 'object' ? body.graph : emptyGraph();
  if (body.graph != null) validateGraph(graph);
  const row = await UserWorkflow.create({
    userId,
    name,
    description: String(body.description || '').slice(0, 500),
    version: 1,
    graphJson: graph,
  });
  return toFull(row);
}

async function save(userId, id, body = {}) {
  await ensureTable();
  const row = await UserWorkflow.findOne({ where: { userId, id } });
  if (!row) throw httpError(404, 'Workflow not found');

  // Optional optimistic lock: when the caller supplies the version it last read
  // (e.g. an external editor via MCP), reject the write if the row has moved on,
  // so concurrent edits from a human and an AI don't silently clobber each other.
  // Omitting expectedVersion preserves the historical last-write-wins behaviour.
  if (body.expectedVersion != null) {
    const expected = Number(body.expectedVersion);
    if (!Number.isInteger(expected)) throw httpError(400, 'expectedVersion must be an integer');
    if (row.version !== expected) {
      throw httpError(409, `Version conflict: expected ${expected}, current ${row.version}`);
    }
  }

  const patch = {};
  if (body.name != null) patch.name = normalizeName(body.name);
  if (body.description != null) patch.description = String(body.description).slice(0, 500);
  if (body.graph != null) {
    if (typeof body.graph !== 'object') throw httpError(400, 'graph must be an object');
    validateGraph(body.graph);
    patch.graphJson = body.graph;
  }
  patch.version = (row.version || 1) + 1;

  await row.update(patch);
  return toFull(row);
}

async function remove(userId, id) {
  await ensureTable();
  const deleted = await UserWorkflow.destroy({ where: { userId, id } });
  if (!deleted) throw httpError(404, 'Workflow not found');
  return { deleted: true, id: Number(id) };
}

// ── Built-in templates ───────────────────────────────────────────────────────

// Summary catalog for the "从模板新建" picker (no graph payload).
function listTemplates() {
  return listTemplateSummaries();
}

// Instantiate a built-in template as a new per-user workflow. Reuses create(),
// so the template graph passes the same integrity validation as any save, and
// the new row starts at version 1. Caller-supplied name/description override the
// template's defaults.
async function createFromTemplate(userId, templateId, body = {}) {
  const tpl = getTemplate(templateId);
  if (!tpl) throw httpError(404, `Template not found: ${templateId}`);
  return create(userId, {
    name: body.name || tpl.name,
    description: body.description != null ? body.description : tpl.description,
    graph: tpl.graph,
  });
}

// ── Coze import ───────────────────────────────────────────────────────────────

// Import a Coze (coze-studio) exported workflow as a new per-user workflow.
// Decoding (base64 / container / nested zip) lives in cozeImportService; the pure
// node-type/edge mapping lives in @khy/shared/workflow/cozeImport. The converted
// graph passes the SAME integrity validation as any save (via create()), and the
// conversion `report` (dropped comments, unsupported nodes, approximations) is
// returned to the caller so nothing is silently lost.
async function createFromCoze(userId, body = {}) {
  const cozeImport = require('./cozeImportService');
  const { graph, report } = await cozeImport.importToGraph(body, { name: body.name });
  const created = await create(userId, {
    name: body.name || report.name,
    description: body.description != null
      ? body.description
      : `从 Coze 导入（${report.nodeCount} 节点）`,
    graph,
  });
  return { ...created, report };
}

// ── Coze gallery: enumerate + on-demand per-entry install ─────────────────────

// Enumerate an uploaded Coze collection into a cached session + preview catalog
// WITHOUT persisting anything. The user then installs entries one at a time.
async function enumerateCoze(userId, body = {}) {
  const cozeImport = require('./cozeImportService');
  return cozeImport.enumerateToSession(body, { userId });
}

// Enumerate the server-side built-in catalog (shared, read-only source). Each
// caller still gets a userId-scoped session and installs into their own list.
async function enumerateCozeBuiltin(userId) {
  const cozeImport = require('./cozeImportService');
  return cozeImport.enumerateBuiltin({ userId });
}

// Install one enumerated entry (by session + index) as a new per-user workflow.
// Mirrors createFromCoze: the cached graph passes the same validateGraph as any
// save (via create()), and the conversion `report` is returned to the caller.
// Coze workflow titles routinely contain characters NAME_RE rejects (parentheses,
// slashes, emoji); coerce the name into the allowed set so a gallery install of
// any of the 200+ entries never fails name validation.
function sanitizeImportName(raw) {
  const cleaned = String(raw == null ? '' : raw)
    .replace(/[^\w一-龥 .\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'Coze 工作流';
}

async function installCozeEntry(userId, body = {}) {
  const cozeImport = require('./cozeImportService');
  const { sessionId, index } = body;
  const { graph, report } = cozeImport.getSessionGraph(sessionId, userId, index);
  const created = await create(userId, {
    name: sanitizeImportName(body.name || report.name),
    description: body.description != null
      ? body.description
      : `从 Coze 安装（${report.nodeCount} 节点）`,
    graph,
  });
  return { ...created, report };
}

module.exports = {
  list,
  get,
  create,
  save,
  remove,
  listTemplates,
  createFromTemplate,
  createFromCoze,
  enumerateCoze,
  enumerateCozeBuiltin,
  installCozeEntry,
  // exported for reuse by validation/export slices
  emptyGraph,
  normalizeName,
  validateGraph,
  httpError,
};
