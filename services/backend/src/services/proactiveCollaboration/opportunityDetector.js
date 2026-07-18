'use strict';

/**
 * proactiveCollaboration/opportunityDetector.js
 *
 * Pure, deterministic detection of "this task is decomposable into independent
 * pieces that collaborating sub-agents could tackle in parallel". No I/O, no
 * model calls — structure-driven only, so it is cheap, testable and predictable.
 *
 * The detector is intentionally CONSERVATIVE. A false positive spends real
 * tokens spinning up sub-agents for a task that did not need them, so the bar is
 * high: it requires multiple genuinely-independent deliverables AND a confidence
 * score above the configured floor before it will recommend collaboration.
 */

const { LIMITS, PARALLEL_MARKERS } = require('./constants');

// Bracketed hints the agentic harness injects ([System Skill/Memory/Context …]).
// They are not part of the user's actual request and must not seed sub-tasks.
const SYSTEM_HINT_RE = /\[(?:system|系统)[^\]]*\]/gi;

// Conjunctions that join independent clauses. Chinese enumerative comma (、) and
// the listed connectors typically separate parallel deliverables. Bare 和/与
// are included because they are the standard list connectors ("登录、注册和找回");
// the confidence floor downstream guards against the occasional in-word match.
// Note: bare 并 is a connector ("编写…并验证…") but 并发/并行 are single words —
// a negative lookahead keeps those intact.
const CONJUNCTION_SPLIT_RE = /\s*(?:、|；|;|以及|还有|然后|并且|并(?![发行])|和|与|\band\b|\bplus\b|&)\s*/i;

// Action verbs that mark a clause as an actionable deliverable (not prose).
const ACTION_VERB_RE = /实现|编写|创建|新增|生成|构建|开发|修复|重构|实施|搭建|更新|更改|修改|删除|移除|调研|研究|搜索|查找|查询|检索|收集|分析|评估|设计|规划|测试|验证|校验|添加|配置|部署|优化|integrat|implement|build|create|write|generate|develop|fix|refactor|update|modify|remove|delete|add\b|research|investigate|analy[sz]e|design|test|verify|configure|deploy|optimi[sz]e|set\s+up/i;

/** Normalize a raw user message for structural analysis. */
function _normalize(message) {
  return String(message || '')
    .replace(SYSTEM_HINT_RE, ' ')
    .replace(/\r\n/g, '\n')
    .trim();
}

/** A clause qualifies as a deliverable if it is substantive and action-bearing. */
function _isDeliverableClause(clause) {
  const c = String(clause || '').trim();
  if (c.length < 4) return false;
  if (c.length > LIMITS.MAX_SUBTASK_CHARS) return false;
  if (/^[?？。.!！\s]*$/.test(c)) return false; // punctuation/empty only
  return ACTION_VERB_RE.test(c);
}

/**
 * Extract candidate sub-tasks from enumerated list structure:
 *   "1. do X  2. do Y" or "- do X\n- do Y" or "• do X".
 * Returns an array of cleaned clause strings (may be empty).
 */
function _extractEnumerated(text) {
  const out = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*(?:\d+[.)、]|[-*+•]|[(（]\s*\d+\s*[)）])\s+(.*\S)\s*$/);
    if (m && m[1]) out.push(m[1].trim());
  }
  // Inline enumerated form: "1. xxx 2. yyy 3. zzz" on a single line.
  if (out.length < 2) {
    const inline = text.match(/\d+\s*[.)、]\s*[^0-9]+?(?=(?:\d+\s*[.)、])|$)/g);
    if (inline && inline.length >= 2) {
      return inline.map(s => s.replace(/^\d+\s*[.)、]\s*/, '').trim()).filter(Boolean);
    }
  }
  return out;
}

/**
 * Extract candidate sub-tasks from conjunction-joined clauses. Handles two forms:
 *   (a) independent clauses, each with its own verb:
 *         "调研市场、编写报告并验证数据" → 3 deliverables as-is.
 *   (b) SHARED-VERB enumeration (very common in Chinese): one leading verb
 *       governs a list of objects:
 *         "实现登录、注册和找回密码" → ["实现登录","实现注册","实现找回密码"].
 *       The verb is propagated to the verb-less objects so each becomes a
 *       self-contained, delegable sub-task.
 * Returns [] when the structure is not a genuine action list.
 */
function _extractConjoined(text) {
  // Work on the first sentence-ish span; avoid splitting an entire paragraph.
  const span = text.split(/[。\n]/).find(s => CONJUNCTION_SPLIT_RE.test(s)) || text;
  const parts = span.split(CONJUNCTION_SPLIT_RE).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return [];

  const firstVerbMatch = parts[0].match(ACTION_VERB_RE);
  if (!firstVerbMatch) {
    // No leading verb — only keep clauses that independently look like tasks.
    return parts.filter(_isDeliverableClause);
  }

  // Shared-verb mode: prepend the leading verb to any verb-less object clause.
  const sharedVerb = firstVerbMatch[0];
  const out = [];
  for (const p of parts) {
    const clause = p.trim();
    if (!clause) continue;
    if (ACTION_VERB_RE.test(clause)) out.push(clause);
    else out.push(`${sharedVerb}${clause}`);
  }
  return out;
}

/**
 * Detect distinct file/module targets, e.g. "更新 a.js、b.ts 和 c.py".
 * Used purely as a corroborating signal (multiple targets ⇒ parallelizable).
 */
function _distinctTargets(text) {
  const matches = text.match(/[A-Za-z0-9_./-]+\.(?:js|ts|jsx|tsx|py|go|rs|java|c|cpp|h|css|vue|md|json|ya?ml|sh)\b/g) || [];
  return [...new Set(matches.map(s => s.toLowerCase()))];
}

/**
 * detectCollaborationOpportunity(message, opts?) → {
 *   shouldCollaborate: boolean,
 *   subtasks: Array<{ task: string }>,   // role assigned later by the planner
 *   confidence: number,                  // 0..1
 *   reason: string,
 *   signals: { enumerated, conjoined, parallelMarker, distinctTargets }
 * }
 *
 * Pure: same input always yields the same output.
 */
function detectCollaborationOpportunity(message, opts = {}) {
  const minConfidence = typeof opts.minConfidence === 'number' ? opts.minConfidence : LIMITS.MIN_CONFIDENCE;
  const minSubtasks = LIMITS.MIN_SUBTASKS;

  const empty = {
    shouldCollaborate: false,
    subtasks: [],
    confidence: 0,
    reason: 'no decomposable structure detected',
    signals: { enumerated: 0, conjoined: 0, parallelMarker: 0, distinctTargets: 0 },
  };

  const text = _normalize(message);
  if (text.length < LIMITS.MIN_MESSAGE_CHARS) {
    return { ...empty, reason: 'message too short for collaboration' };
  }

  // ── Gather candidate sub-tasks from the two structural extractors ──────────
  const enumerated = _extractEnumerated(text).filter(_isDeliverableClause);
  const conjoined = enumerated.length >= minSubtasks ? [] : _extractConjoined(text).filter(_isDeliverableClause);
  const targets = _distinctTargets(text);

  // Prefer enumerated structure (most explicit); fall back to conjoined clauses.
  let candidates = enumerated.length >= minSubtasks ? enumerated : conjoined;

  // De-duplicate while preserving order.
  const seen = new Set();
  candidates = candidates
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => {
      const key = s.toLowerCase();
      if (!s || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (candidates.length < minSubtasks) {
    return { ...empty, reason: `only ${candidates.length} independent deliverable(s) found (need ${minSubtasks})` };
  }

  // ── Confidence scoring ─────────────────────────────────────────────────────
  // Base: having ≥minSubtasks independent action clauses is itself the primary
  // signal. Structural corroboration (explicit parallel markers, multiple file
  // targets, richer enumeration) raises confidence toward 1.0.
  let parallelWeight = 0;
  for (const m of PARALLEL_MARKERS) {
    if (m.pattern.test(text)) parallelWeight += m.weight;
  }
  parallelWeight = Math.min(parallelWeight, 0.5);

  const enumeratedBonus = enumerated.length >= minSubtasks ? 0.25 : 0; // explicit list is strong
  const targetBonus = targets.length >= 2 ? 0.15 : 0;
  const countBonus = Math.min((candidates.length - minSubtasks) * 0.1, 0.2);

  // Verb diversity: distinct leading action verbs across the candidates. Several
  // DIFFERENT verbs ("调研…编写…验证…") means genuinely heterogeneous independent
  // work — a strong signal. Shared-verb enumerations score 1 here (no bonus) and
  // rely on the parallel/count/target signals instead.
  const verbSet = new Set();
  for (const ct of candidates) {
    const m = ct.match(ACTION_VERB_RE);
    if (m) verbSet.add(m[0]);
  }
  const diversityBonus = verbSet.size >= 3 ? 0.3 : verbSet.size >= 2 ? 0.2 : 0;

  const confidence = Math.min(0.4 + enumeratedBonus + parallelWeight + targetBonus + countBonus + diversityBonus, 1);

  const signals = {
    enumerated: enumerated.length,
    conjoined: conjoined.length,
    parallelMarker: Number(parallelWeight > 0),
    distinctTargets: targets.length,
  };

  if (confidence < minConfidence) {
    return {
      shouldCollaborate: false,
      subtasks: candidates.map(task => ({ task })),
      confidence,
      reason: `confidence ${confidence.toFixed(2)} below floor ${minConfidence.toFixed(2)}`,
      signals,
    };
  }

  return {
    shouldCollaborate: true,
    subtasks: candidates.map(task => ({ task })),
    confidence,
    reason: `detected ${candidates.length} independent deliverables (confidence ${confidence.toFixed(2)})`,
    signals,
  };
}

module.exports = {
  detectCollaborationOpportunity,
  // exported for unit testing of the building blocks
  _normalize,
  _extractEnumerated,
  _extractConjoined,
  _distinctTargets,
  _isDeliverableClause,
};
