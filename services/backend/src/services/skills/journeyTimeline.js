'use strict';

/**
 * journeyTimeline.js — pure aggregation/sort leaf for `skill journey`
 * (ported concept from Hermes Agent v0.18.0 /journey, adapted to Khy-OS engine).
 *
 * Hermes /journey renders a terminal timeline of everything the agent has learned
 * (skills) and remembered (memories) over time. Khy-OS keeps the *rendering data*
 * deterministic by isolating the merge+sort+summary into this pure leaf; all IO
 * (reading the learned-skills store and the memory dir) stays in the service layer.
 *
 * PURE LEAF CONTRACT:
 *   - zero IO (no fs / no network / no process / no argless `new Date()`);
 *   - deterministic: identical inputs → byte-identical output;
 *   - never throws: malformed entries are skipped, bad shapes coerced or dropped.
 *
 * Inputs are already-serialized records supplied by the caller:
 *   skills:   [{ id, name, description, category, source, learnedAt }]  (learnedAt = ISO string)
 *   memories: [{ name, description, type, modifiedAt }]                 (modifiedAt = ISO string | Date | epoch ms)
 *
 * Output:
 *   buildJourneyTimeline({ skills, memories }) →
 *     { ok: true, entries: [ normalized ... ], summary: {...} }
 *   Entries are sorted oldest → newest (Hermes timeline order). Entries with no
 *   parseable date sort last, preserving their relative input order (stable).
 */

const _MAX_TITLE = 80;
const _MAX_DESC = 120;

// 收敛到 utils/toStr 单一真源(逐字节委托,调用点不变)
const _str = require('../../utils/toStr').toStr;

function _clip(v, max) {
  const s = _str(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Normalize any supported date shape into { iso, ts }.
 * Accepts ISO string, epoch ms number, or a Date instance. Anything unparseable
 * yields { iso: '', ts: null } and the entry sorts to the end.
 */
function _normalizeDate(value) {
  if (value == null || value === '') return { iso: '', ts: null };
  let ms = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    ms = value;
  } else if (value instanceof Date) {
    const t = value.getTime();
    ms = Number.isFinite(t) ? t : null;
  } else {
    const t = Date.parse(_str(value));
    ms = Number.isFinite(t) ? t : null;
  }
  if (ms == null) return { iso: '', ts: null };
  return { iso: new Date(ms).toISOString(), ts: ms };
}

function _normalizeSkill(skill, index) {
  if (!skill || typeof skill !== 'object') return null;
  const { iso, ts } = _normalizeDate(skill.learnedAt);
  const title = _clip(skill.name || skill.id, _MAX_TITLE);
  if (!title) return null;
  return {
    kind: 'skill',
    id: _str(skill.id) || title,
    title,
    description: _clip(skill.description, _MAX_DESC),
    category: _clip(skill.category, 40) || 'skill',
    source: _clip(skill.source, 60) || 'learned',
    date: iso,
    ts,
    _order: index,
  };
}

function _normalizeMemory(memory, index) {
  if (!memory || typeof memory !== 'object') return null;
  const fm = memory.frontmatter && typeof memory.frontmatter === 'object' ? memory.frontmatter : null;
  const name = memory.name || (fm && fm.name);
  const description = memory.description || (fm && fm.description);
  const type = memory.type || (fm && fm.metadata && fm.metadata.type);
  const title = _clip(name || memory.filename, _MAX_TITLE);
  if (!title) return null;
  const { iso, ts } = _normalizeDate(memory.modifiedAt);
  return {
    kind: 'memory',
    id: _str(memory.filename || name) || title,
    title,
    description: _clip(description, _MAX_DESC),
    category: _clip(type, 40) || 'memory',
    source: 'memory',
    date: iso,
    ts,
    _order: index,
  };
}

/**
 * Stable chronological sort: parseable dates ascending (oldest first); undated
 * entries after all dated ones, preserving input order among themselves.
 */
function _byChrono(a, b) {
  const at = a.ts;
  const bt = b.ts;
  if (at == null && bt == null) return a._order - b._order;
  if (at == null) return 1;
  if (bt == null) return -1;
  if (at !== bt) return at - bt;
  return a._order - b._order;
}

function _buildSummary(entries) {
  const byCategory = {};
  const byKind = { skill: 0, memory: 0 };
  let earliest = '';
  let latest = '';
  for (const e of entries) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    const cat = e.category || 'other';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    if (e.date) {
      if (!earliest || e.date < earliest) earliest = e.date;
      if (!latest || e.date > latest) latest = e.date;
    }
  }
  return {
    total: entries.length,
    skillCount: byKind.skill,
    memoryCount: byKind.memory,
    byCategory,
    earliest,
    latest,
  };
}

/**
 * Merge learned skills and memories into one chronological timeline.
 * @param {{ skills?: Array, memories?: Array }} input
 * @returns {{ ok: true, entries: Array, summary: Object }}
 */
function buildJourneyTimeline(input) {
  const skills = input && Array.isArray(input.skills) ? input.skills : [];
  const memories = input && Array.isArray(input.memories) ? input.memories : [];

  const entries = [];
  let order = 0;
  for (const s of skills) {
    const n = _normalizeSkill(s, order++);
    if (n) entries.push(n);
  }
  for (const m of memories) {
    const n = _normalizeMemory(m, order++);
    if (n) entries.push(n);
  }

  entries.sort(_byChrono);
  // Drop the internal ordering key from the public output.
  const clean = entries.map(({ _order, ...rest }) => rest);

  return { ok: true, entries: clean, summary: _buildSummary(clean) };
}

/**
 * Pure renderer: turn a journey result into printable lines (no color/IO).
 * Kept in the leaf so line composition stays deterministic and testable.
 * @param {{ entries: Array, summary: Object }} result
 * @returns {string[]}
 */
function formatJourneyTimeline(result) {
  const entries = result && Array.isArray(result.entries) ? result.entries : [];
  const summary = (result && result.summary) || {};
  const lines = [];
  const kindLabel = { skill: '技能', memory: '记忆' };
  for (const e of entries) {
    const day = e.date ? e.date.slice(0, 10) : '——————';
    const label = kindLabel[e.kind] || e.kind;
    lines.push(`${day}  [${label}] ${e.title}`);
    if (e.description) lines.push(`            ${e.description}`);
  }
  lines.push('');
  lines.push(
    `共 ${summary.total || 0} 项 · 技能 ${summary.skillCount || 0} · 记忆 ${summary.memoryCount || 0}`
  );
  return lines;
}

module.exports = {
  buildJourneyTimeline,
  formatJourneyTimeline,
};
