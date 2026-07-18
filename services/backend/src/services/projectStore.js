/**
 * Per-user coding Project store (multi-tenant).
 *
 * Backs the `/api/ai/projects` routes. Every query is scoped to a `userId`, so a
 * user can only ever read/write their own projects; isolation is enforced by the
 * store's `where:{userId}`, not by a DB-level FK (the model uses constraints:false
 * so the single-machine sentinel user 0 persists cleanly). A Project is a named
 * multi-folder workspace anchor (aligning to Hermes v0.18.0 desktop coding
 * projects); conversations opt into one via Conversation.project_id.
 *
 * Table creation: the daemon may boot before the global `sequelize.sync`. To stay
 * self-contained regardless of boot order, we lazily `UserProject.sync()` once on
 * first use — a model-level sync touches only `user_projects`, never other tables.
 * Mirrors conversationStore.ensureTable / workflowService boot-order safety.
 *
 * @pattern Repository
 */
'use strict';

const { UserProject } = require('@khy/shared/models');

// Keep per-user projects bounded so a long-lived account never grows without limit.
const MAX_PER_USER = 200;
const NAME_MAX = 120;

// ── Table bootstrap (idempotent, model-scoped) ──────────────────────────────

let tableReady = null;
async function ensureTable() {
  if (!tableReady) {
    // Model-level sync: creates only user_projects if missing; no-op otherwise.
    tableReady = UserProject.sync().catch((err) => {
      tableReady = null; // allow retry on transient failure
      throw err;
    });
  }
  return tableReady;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// 收敛到 utils/httpError 单一真源(逐字节委托,调用点不变)
const httpError = require('../utils/httpError');

function normFolders(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((f) => String(f == null ? '' : f).trim())
    .filter((f) => f.length > 0)
    .slice(0, 64);
}

function normName(value) {
  return String(value == null ? '' : value).trim().slice(0, NAME_MAX);
}

// Lightweight projection for the list view (all fields are already light — a
// project carries no heavy transcript — but keep a stable shape distinct from
// the model row so the API contract is explicit).
function toSummary(row) {
  return {
    id: row.id,
    name: row.name || '未命名项目',
    description: row.description || '',
    icon: row.icon || '',
    color: row.color || '',
    primaryPath: row.primaryPath || '',
    folders: row.folders || [],
    archived: !!row.archived,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

const toFull = toSummary;

// ── CRUD ────────────────────────────────────────────────────────────────────

// List a user's projects. By default archived rows are hidden; pass
// { includeArchived:true } to include them (the management view toggle).
async function list(userId, options = {}) {
  await ensureTable();
  const where = { userId };
  if (!options.includeArchived) where.archived = false;
  const rows = await UserProject.findAll({
    where,
    order: [['updatedAt', 'DESC'], ['id', 'DESC']],
  });
  return rows.map(toSummary);
}

async function get(userId, id) {
  await ensureTable();
  const row = await UserProject.findOne({ where: { userId, id } });
  if (!row) throw httpError(404, 'Project not found');
  return toFull(row);
}

async function create(userId, body = {}) {
  await ensureTable();
  const name = normName(body.name);
  if (!name) throw httpError(400, 'Project name is required');
  const row = await UserProject.create({
    userId,
    name,
    description: String(body.description || '').slice(0, 500),
    icon: String(body.icon || '').slice(0, 32),
    color: String(body.color || '').slice(0, 32),
    primaryPath: String(body.primaryPath || '').slice(0, 500),
    folders: normFolders(body.folders),
    archived: false,
  });
  await pruneOld(userId);
  return toFull(row);
}

async function update(userId, id, body = {}) {
  await ensureTable();
  const row = await UserProject.findOne({ where: { userId, id } });
  if (!row) throw httpError(404, 'Project not found');

  const patch = {};
  if (body.name != null) {
    const name = normName(body.name);
    if (!name) throw httpError(400, 'Project name cannot be empty');
    patch.name = name;
  }
  if (body.description != null) patch.description = String(body.description).slice(0, 500);
  if (body.icon != null) patch.icon = String(body.icon).slice(0, 32);
  if (body.color != null) patch.color = String(body.color).slice(0, 32);
  if (body.primaryPath != null) patch.primaryPath = String(body.primaryPath).slice(0, 500);
  if (body.folders != null) patch.folders = normFolders(body.folders);
  if (body.archived != null) patch.archived = !!body.archived;

  await row.update(patch);
  return toFull(row);
}

// Archive / restore are thin wrappers over update so the REST layer can expose a
// dedicated endpoint without duplicating the guard/lookup logic.
async function archive(userId, id) {
  return update(userId, id, { archived: true });
}

async function restore(userId, id) {
  return update(userId, id, { archived: false });
}

async function remove(userId, id) {
  await ensureTable();
  const deleted = await UserProject.destroy({ where: { userId, id } });
  if (!deleted) throw httpError(404, 'Project not found');
  return { deleted: true, id: Number(id) };
}

// Drop the oldest rows beyond the per-user cap so the list stays bounded.
async function pruneOld(userId) {
  const count = await UserProject.count({ where: { userId } });
  if (count <= MAX_PER_USER) return;
  const stale = await UserProject.findAll({
    where: { userId },
    order: [['updatedAt', 'ASC'], ['id', 'ASC']],
    limit: count - MAX_PER_USER,
    attributes: ['id'],
  });
  const ids = stale.map((r) => r.id);
  if (ids.length) await UserProject.destroy({ where: { userId, id: ids } });
}

module.exports = {
  list,
  get,
  create,
  update,
  archive,
  restore,
  remove,
  ensureTable,
  MAX_PER_USER,
};
