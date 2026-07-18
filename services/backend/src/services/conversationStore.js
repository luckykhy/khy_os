/**
 * Per-user AI chat conversation store (multi-tenant).
 *
 * Backs the `/api/ai/conversations` routes. Every query is scoped to a `userId`,
 * so a user can only ever read/write their own conversations. The full message
 * transcript is stored verbatim in `Conversation.messages` (JSON array) and is
 * the single source of truth; the sidebar list view reads only a lightweight
 * projection (title + timestamps + counts + preview), never the heavy transcript.
 *
 * Table creation: the daemon may boot before the global `sequelize.sync`. To stay
 * self-contained regardless of boot order, we lazily `Conversation.sync()` once on
 * first use — a model-level sync touches only `ai_conversations`, never other
 * tables. Mirrors workflowService.ensureTable / userGatewayConfigService boot-order
 * safety.
 *
 * @pattern Repository
 */
'use strict';

const { Conversation } = require('@khy/shared/models');

// Keep per-user history bounded so a long-lived account never grows without limit.
const MAX_PER_USER = 200;
const TITLE_MAX = 24;

// ── Table bootstrap (idempotent, model-scoped) ──────────────────────────────

let tableReady = null;
async function ensureTable() {
  if (!tableReady) {
    // Model-level sync: creates only ai_conversations if missing; no-op otherwise.
    tableReady = Conversation.sync().catch((err) => {
      tableReady = null; // allow retry on transient failure
      throw err;
    });
  }
  return tableReady;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// 收敛到 utils/httpError 单一真源(逐字节委托,调用点不变)
const httpError = require('../utils/httpError');

function normMessages(value) {
  return Array.isArray(value) ? value : [];
}

// Normalize an optional project id to a positive integer or null (ungrouped).
// Any blank / non-numeric / non-positive value collapses to null so a
// conversation without a project stays in the always-visible "全部" bucket.
function normProjectId(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Extract a plain-text snippet from a message's content. Web messages carry
// `content` as a string; tolerate array/object shapes (multimodal) by pulling
// the first text-ish field so the title/preview never renders "[object Object]".
function messageText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    for (const part of c) {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
    }
    return '';
  }
  if (typeof msg.text === 'string') return msg.text;
  return '';
}

// Derive a human-friendly title from the first user message, else a default.
function deriveTitle(messages) {
  const list = normMessages(messages);
  const firstUser = list.find((m) => m && m.role === 'user');
  const text = messageText(firstUser).trim().replace(/\s+/g, ' ');
  if (!text) return '新对话';
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
}

// Lightweight list projection — no heavy transcript payload.
function toSummary(row) {
  const messages = row.messages || [];
  const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
  return {
    id: row.id,
    title: row.title || '新对话',
    projectId: row.projectId ?? null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    messageCount: messages.length,
    preview: messageText(lastUser).trim().slice(0, 60),
  };
}

// Full row including the transcript.
function toFull(row) {
  return {
    id: row.id,
    title: row.title || '新对话',
    projectId: row.projectId ?? null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    messages: row.messages || [],
  };
}

// ── CRUD ────────────────────────────────────────────────────────────────────

// List a user's conversations. Backward-compatible: called with just (userId)
// it returns every conversation (today's behavior). Pass { projectId } to filter
// to one coding project's conversations; a null/absent projectId keeps the full
// list. The second arg is optional so existing callers are unaffected.
async function list(userId, options = {}) {
  await ensureTable();
  const where = { userId };
  const projectId = normProjectId(options && options.projectId);
  if (projectId != null) where.projectId = projectId;
  const rows = await Conversation.findAll({
    where,
    order: [['updatedAt', 'DESC'], ['id', 'DESC']],
  });
  return rows.map(toSummary);
}

async function get(userId, id) {
  await ensureTable();
  const row = await Conversation.findOne({ where: { userId, id } });
  if (!row) throw httpError(404, 'Conversation not found');
  return toFull(row);
}

async function create(userId, body = {}) {
  await ensureTable();
  const messages = normMessages(body.messages);
  const title = (body.title && String(body.title).trim()) || deriveTitle(messages);
  const row = await Conversation.create({
    userId,
    title: title.slice(0, 200),
    projectId: normProjectId(body.projectId),
    messages,
  });
  await pruneOld(userId);
  return toFull(row);
}

async function update(userId, id, body = {}) {
  await ensureTable();
  const row = await Conversation.findOne({ where: { userId, id } });
  if (!row) throw httpError(404, 'Conversation not found');

  const patch = {};
  if (body.messages != null) patch.messages = normMessages(body.messages);
  if (body.projectId !== undefined) patch.projectId = normProjectId(body.projectId);
  if (body.title != null) {
    patch.title = String(body.title).trim().slice(0, 200) || '新对话';
  } else if (body.messages != null && (!row.title || row.title === '新对话')) {
    // First persisted turn: backfill a derived title if it was still the default.
    patch.title = deriveTitle(patch.messages).slice(0, 200);
  }

  await row.update(patch);
  return toFull(row);
}

async function remove(userId, id) {
  await ensureTable();
  const deleted = await Conversation.destroy({ where: { userId, id } });
  if (!deleted) throw httpError(404, 'Conversation not found');
  return { deleted: true, id: Number(id) };
}

// Drop the oldest rows beyond the per-user cap so history stays bounded.
async function pruneOld(userId) {
  const count = await Conversation.count({ where: { userId } });
  if (count <= MAX_PER_USER) return;
  const stale = await Conversation.findAll({
    where: { userId },
    order: [['updatedAt', 'ASC'], ['id', 'ASC']],
    limit: count - MAX_PER_USER,
    attributes: ['id'],
  });
  const ids = stale.map((r) => r.id);
  if (ids.length) await Conversation.destroy({ where: { userId, id: ids } });
}

module.exports = {
  list,
  get,
  create,
  update,
  remove,
  // exported for reuse / tests
  deriveTitle,
  ensureTable,
  httpError,
  MAX_PER_USER,
};
