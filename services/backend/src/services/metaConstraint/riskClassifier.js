'use strict';

/**
 * riskClassifier.js — 动作风险分级 (目标「元约束架构师」§3, 风险维度).
 *
 * The constraint solver needs two axes: WHO is acting (capabilityProbe) and HOW
 * RISKY the action is. This module supplies the second axis — a coarse, three-way
 * risk magnitude for a concrete action:
 *
 *   creative      纯创作 / 极低风险。注释、文案、Markdown、字符串常量、纯读取。
 *                 即使写错也不会引发语法崩溃或逻辑污染。
 *   logic         逻辑变更 / 中等风险。改源码、改控制流、非只读 shell。
 *   irreversible  不可逆 / 极高风险。删除、drop/truncate、强推、改依赖清单、动机密。
 *
 * This is risk MAGNITUDE, deliberately coarser than metaplan's constitutional
 * red lines. The red lines are the catastrophic SUBSET that always force
 * System_Block; this classifier instead grades ordinary work so the solver can
 * decide how much lock a given capability band earns at that risk level.
 *
 * Deterministic + pure. Pattern banks are explicit and auditable. Fail-safe:
 * anything unrecognized classifies as `logic` (the middle), never `creative` —
 * under-locking an unknown action is the dangerous direction.
 *
 * Env:
 *   KHY_METACONSTRAINT_CREATIVE_EXT   extra comma-separated extensions treated as
 *                                     creative (e.g. ".rst,.adoc")
 */

// 破坏性签名库唯一真源（Goal 1 收敛，见 .ai/GUARDS-AI.md §2）。
// 依赖方向 metaConstraint → metaplan，单向。
const {
  DELETE_TOOL_NAMES,
  IRREVERSIBLE_CMD_PATTERNS,
  IRREVERSIBLE_PATH_PATTERNS,
  _str,
  _any,
} = require('../metaplan/irreversibleSignatures');

const RISK = Object.freeze({
  CREATIVE: 'creative',
  LOGIC: 'logic',
  IRREVERSIBLE: 'irreversible',
});

// Strictness rank — higher = riskier. Lets callers compare/escalate if needed.
const RISK_RANK = Object.freeze({
  [RISK.CREATIVE]: 0,
  [RISK.LOGIC]: 1,
  [RISK.IRREVERSIBLE]: 2,
});

// File extensions whose edits are pure prose/data — no executable logic.
const CREATIVE_EXTS = new Set([
  '.md', '.markdown', '.txt', '.rst', '.adoc',
  '.csv', '.log', '.text',
]);

// Code extensions — editing these is a logic change by default.
const CODE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.c', '.h',
  '.cc', '.cpp', '.hpp', '.java', '.kt', '.rb', '.php', '.swift', '.sh', '.bash',
  '.zsh', '.sql', '.lua', '.scala', '.dart', '.vue', '.svelte', '.asm', '.s',
]);

// Read-only tool/command signatures → creative-grade (no mutation risk at all).
const READONLY_TOOL_NAMES = new Set([
  'readfile', 'read_file', 'read', 'cat', 'grep', 'glob', 'ls', 'list', 'search',
  'view', 'stat',
]);

function _ext(path) {
  const p = String(path || '');
  const m = /(\.[A-Za-z0-9_]+)$/.exec(p);
  return m ? m[1].toLowerCase() : '';
}

function _creativeExts() {
  const base = new Set(CREATIVE_EXTS);
  const extra = String(process.env.KHY_METACONSTRAINT_CREATIVE_EXT || '').trim();
  if (extra) {
    for (const e of extra.split(',')) {
      const t = e.trim().toLowerCase();
      if (t) base.add(t.startsWith('.') ? t : `.${t}`);
    }
  }
  return base;
}

/**
 * Classify a concrete action's risk magnitude.
 *
 * @param {object} action
 * @param {string} [action.tool]      tool/executor name
 * @param {object} [action.params]    tool params (path, command, content, sql…)
 * @param {string} [action.command]   convenience: raw shell command
 * @param {string} [action.path]      convenience: target file path
 * @param {string} [action.content]   convenience: content being written
 * @param {string} [action.riskClass] explicit override (only honored if a legal value)
 * @returns {{ riskClass:'creative'|'logic'|'irreversible', reason:string }}
 */
function classify(action = {}) {
  // Explicit, legal override wins (lets a caller pin a known risk).
  const pinned = String(action.riskClass || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(RISK_RANK, pinned)) {
    return { riskClass: pinned, reason: '调用方显式指定风险级别。' };
  }

  const params = action.params || {};
  const tool = String(action.tool || params.tool || '').trim().toLowerCase();
  const command = _str(action.command != null ? action.command : params.command);
  const sql = _str(params.sql != null ? params.sql : params.query);
  const path = _str(action.path != null ? action.path : (params.path || params.file || params.filename));
  const content = _str(action.content != null ? action.content : params.content);
  const commandish = `${command}\n${sql}`;

  // --- irreversible: the highest bar, checked first ---------------------------
  if (DELETE_TOOL_NAMES.has(tool)) {
    return { riskClass: RISK.IRREVERSIBLE, reason: `工具 "${tool}" 语义即删除，不可逆。` };
  }
  if (command && _any(IRREVERSIBLE_CMD_PATTERNS, commandish)) {
    return { riskClass: RISK.IRREVERSIBLE, reason: '命令包含删除/drop/强推等不可逆操作。' };
  }
  if (path && _any(IRREVERSIBLE_PATH_PATTERNS, path)) {
    return { riskClass: RISK.IRREVERSIBLE, reason: `目标路径 "${path}" 属依赖清单/锁文件/机密，高危。` };
  }

  // --- creative: pure read, or prose/data files ------------------------------
  if (READONLY_TOOL_NAMES.has(tool) && !command) {
    return { riskClass: RISK.CREATIVE, reason: `只读工具 "${tool}"，无写入风险。` };
  }
  const ext = _ext(path);
  if (ext && _creativeExts().has(ext)) {
    return { riskClass: RISK.CREATIVE, reason: `文件后缀 "${ext}" 为纯文本/文档，非可执行逻辑。` };
  }

  // --- logic: code files, or non-read shell ----------------------------------
  if (ext && CODE_EXTS.has(ext)) {
    return { riskClass: RISK.LOGIC, reason: `源码文件 "${ext}"，属逻辑变更。` };
  }
  if (command) {
    return { riskClass: RISK.LOGIC, reason: '非只读 shell 命令，按逻辑变更管控。' };
  }

  // --- fail-safe: unknown → logic (never under-lock to creative) -------------
  return { riskClass: RISK.LOGIC, reason: '未能识别动作类型，保守按逻辑变更处理（防呆 fail-safe）。' };
}

module.exports = {
  RISK,
  RISK_RANK,
  classify,
};
