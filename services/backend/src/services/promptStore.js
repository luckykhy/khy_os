/**
 * Per-user prompt template store (multi-tenant).
 *
 * Backs the `/api/ai/prompts` routes. Every query is scoped to a `userId`, so a
 * user can only ever read/write their own prompts. Two lifecycles coexist:
 *   - manual saves land `status: 'active'` (visible in the library immediately);
 *   - auto-captured candidates land `status: 'pending'` (a review queue) until
 *     the user approves (→ active) or deletes them.
 *
 * Table creation: the daemon may boot before the global `sequelize.sync`. To stay
 * self-contained regardless of boot order, we lazily `PromptTemplate.sync()` once
 * on first use — a model-level sync touches only `prompt_templates`, never other
 * tables. Mirrors conversationStore.ensureTable boot-order safety.
 *
 * @pattern Repository
 */
'use strict';

const { PromptTemplate } = require('@khy/shared/models');

// Keep per-user history bounded so a long-lived account never grows without limit.
const MAX_PER_USER = 500;
const TITLE_MAX = 40;

// ── Table bootstrap (idempotent, model-scoped) ──────────────────────────────

let tableReady = null;
async function ensureTable() {
  if (!tableReady) {
    // Model-level sync: creates only prompt_templates if missing; no-op otherwise.
    tableReady = PromptTemplate.sync().catch((err) => {
      tableReady = null; // allow retry on transient failure
      throw err;
    });
  }
  return tableReady;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// 收敛到 utils/httpError 单一真源(逐字节委托,调用点不变)
const httpError = require('../utils/httpError');

function normTags(value) {
  if (Array.isArray(value)) return value.map((t) => String(t)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

// Derive a human-friendly title from the prompt content, else a default.
function deriveTitle(content) {
  const text = String(content == null ? '' : content).trim().replace(/\s+/g, ' ');
  if (!text) return '未命名提示词';
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
}

// Normalize/whitelist an incoming source value.
function normSource(value) {
  return value === 'ai_discovered' ? 'ai_discovered' : 'manual';
}

// Normalize/whitelist an incoming status value.
function normStatus(value) {
  return value === 'pending' ? 'pending' : 'active';
}

function toRecord(row) {
  return {
    id: row.id,
    title: row.title || '未命名提示词',
    content: row.content || '',
    category: row.category || null,
    tags: row.tags || [],
    source: row.source || 'manual',
    status: row.status || 'active',
    usedCount: row.usedCount || 0,
    lastUsedAt: row.lastUsedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

// ── CRUD ────────────────────────────────────────────────────────────────────

async function list(userId, opts = {}) {
  await ensureTable();
  const where = { userId };
  if (opts.status === 'active' || opts.status === 'pending') where.status = opts.status;
  if (opts.source === 'manual' || opts.source === 'ai_discovered') where.source = opts.source;
  const rows = await PromptTemplate.findAll({
    where,
    order: [['updatedAt', 'DESC'], ['id', 'DESC']],
  });
  let records = rows.map(toRecord);
  // Keyword filter applied in-memory (title/content/tags) — small per-user set.
  const q = opts.q && String(opts.q).trim().toLowerCase();
  if (q) {
    records = records.filter((r) =>
      r.title.toLowerCase().includes(q) ||
      r.content.toLowerCase().includes(q) ||
      (r.category || '').toLowerCase().includes(q) ||
      r.tags.some((t) => String(t).toLowerCase().includes(q)));
  }
  return records;
}

async function get(userId, id) {
  await ensureTable();
  const row = await PromptTemplate.findOne({ where: { userId, id } });
  if (!row) throw httpError(404, 'Prompt not found');
  return toRecord(row);
}

async function create(userId, body = {}) {
  await ensureTable();
  const content = String(body.content == null ? '' : body.content).trim();
  if (!content) throw httpError(400, 'Prompt content is required');
  const title = (body.title && String(body.title).trim()) || deriveTitle(content);
  const row = await PromptTemplate.create({
    userId,
    title: title.slice(0, 200),
    content,
    category: body.category ? String(body.category).trim().slice(0, 80) : null,
    tags: normTags(body.tags),
    source: normSource(body.source),
    status: normStatus(body.status),
  });
  await pruneOld(userId);
  return toRecord(row);
}

async function update(userId, id, body = {}) {
  await ensureTable();
  const row = await PromptTemplate.findOne({ where: { userId, id } });
  if (!row) throw httpError(404, 'Prompt not found');

  const patch = {};
  if (body.title != null) {
    patch.title = String(body.title).trim().slice(0, 200) || '未命名提示词';
  }
  if (body.content != null) {
    const content = String(body.content).trim();
    if (!content) throw httpError(400, 'Prompt content cannot be empty');
    patch.content = content;
  }
  if (body.category !== undefined) {
    patch.category = body.category ? String(body.category).trim().slice(0, 80) : null;
  }
  if (body.tags !== undefined) patch.tags = normTags(body.tags);
  if (body.status !== undefined) patch.status = normStatus(body.status);

  await row.update(patch);
  return toRecord(row);
}

async function remove(userId, id) {
  await ensureTable();
  const deleted = await PromptTemplate.destroy({ where: { userId, id } });
  if (!deleted) throw httpError(404, 'Prompt not found');
  return { deleted: true, id: Number(id) };
}

// Bump the reuse counter and stamp last-used time.
async function use(userId, id) {
  await ensureTable();
  const row = await PromptTemplate.findOne({ where: { userId, id } });
  if (!row) throw httpError(404, 'Prompt not found');
  await row.update({
    usedCount: (row.usedCount || 0) + 1,
    lastUsedAt: new Date(),
  });
  return toRecord(row);
}

// Promote a pending (AI-discovered) prompt into the active library.
async function approve(userId, id) {
  await ensureTable();
  const row = await PromptTemplate.findOne({ where: { userId, id } });
  if (!row) throw httpError(404, 'Prompt not found');
  await row.update({ status: 'active' });
  return toRecord(row);
}

// True when this user already has a prompt with identical content — used by the
// auto-capture hook to avoid enqueuing the same prompt on every repeat turn.
async function existsByContent(userId, content) {
  await ensureTable();
  const text = String(content == null ? '' : content).trim();
  if (!text) return false;
  const row = await PromptTemplate.findOne({
    where: { userId, content: text },
    attributes: ['id'],
  });
  return !!row;
}

// Drop the oldest rows beyond the per-user cap so history stays bounded.
async function pruneOld(userId) {
  const count = await PromptTemplate.count({ where: { userId } });
  if (count <= MAX_PER_USER) return;
  const stale = await PromptTemplate.findAll({
    where: { userId },
    order: [['updatedAt', 'ASC'], ['id', 'ASC']],
    limit: count - MAX_PER_USER,
    attributes: ['id'],
  });
  const ids = stale.map((r) => r.id);
  if (ids.length) await PromptTemplate.destroy({ where: { userId, id: ids } });
}

module.exports = {
  list,
  get,
  create,
  update,
  remove,
  use,
  approve,
  existsByContent,
  // exported for reuse / tests
  deriveTitle,
  ensureTable,
  httpError,
  MAX_PER_USER,
};
