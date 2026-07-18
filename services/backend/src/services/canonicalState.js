'use strict';

/**
 * canonicalState.js — 6-Dimension Canonical State Snapshot
 *
 * Aligned with DeepSeek-TUI's canonical state preservation.
 * Captures an immutable snapshot of session context for crash recovery
 * and cycle boundary carry-forward.
 *
 * 6 Dimensions:
 *   1. Goal        — Last user message summary (what the task is)
 *   2. Constraints — Model, workspace, config notes
 *   3. Facts       — Last N successful tool results (confirmed knowledge)
 *   4. OpenLoops   — Last N failed tool calls (unresolved issues)
 *   5. Pending     — Next steps / planned actions
 *   6. CriticalRefs — Top file paths + recent tool IDs referenced
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.khyquant', 'canonical_state');
const MAX_FACTS = 4;
const MAX_OPEN_LOOPS = 4;
const MAX_CRITICAL_REFS = 8;

// ── Build Snapshot ────────────────────────────────────────────────────

/**
 * Build a canonical state snapshot from session context.
 *
 * @param {object} ctx
 * @param {Array}  ctx.messages        - Conversation messages
 * @param {Array}  ctx.toolCallLog     - Tool call results [{tool, params, result, elapsed}]
 * @param {string} [ctx.model]         - Model identifier
 * @param {string} [ctx.workspace]     - Working directory
 * @param {Array<string>} [ctx.workingSet] - Files in working set
 * @param {string} [ctx.notes]         - User/session notes
 * @returns {CanonicalState}
 */
function buildSnapshot(ctx) {
  const { messages = [], toolCallLog = [], model, workspace, workingSet = [], notes } = ctx;

  // 1. Goal: extract from last user message
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const goal = lastUser
    ? (typeof lastUser.content === 'string' ? lastUser.content.slice(0, 500) : '[non-text]')
    : '';

  // 2. Constraints
  const constraints = {
    model: model || process.env.KHY_MODEL || 'unknown',
    workspace: workspace || process.cwd(),
    notes: notes || '',
  };

  // 3. Confirmed facts: last N successful tool results
  const facts = toolCallLog
    .filter(tc => tc.result?.success)
    .slice(-MAX_FACTS)
    .map(tc => ({
      tool: tc.tool,
      summary: _summarizeResult(tc.result),
    }));

  // 4. Open loops: last N failed tool calls
  const openLoops = toolCallLog
    .filter(tc => tc.result && !tc.result.success)
    .slice(-MAX_OPEN_LOOPS)
    .map(tc => ({
      tool: tc.tool,
      error: _summarizeError(tc.result),
    }));

  // 5. Pending actions: extract from last assistant message
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const pending = lastAssistant
    ? _extractPendingActions(typeof lastAssistant.content === 'string' ? lastAssistant.content : '')
    : [];

  // 6. Critical references
  const filePaths = [...new Set(workingSet)].slice(0, MAX_CRITICAL_REFS);
  const recentToolIds = toolCallLog.slice(-MAX_CRITICAL_REFS).map(tc => tc.tool);
  const criticalRefs = { filePaths, recentToolIds };

  return {
    version: 1,
    timestamp: Date.now(),
    goal,
    constraints,
    facts,
    openLoops,
    pending,
    criticalRefs,
  };
}

// ── Persistence ───────────────────────────────────────────────────────

/**
 * Save canonical state to disk.
 * @param {CanonicalState} state
 * @param {string} [sessionId='default']
 */
function save(state, sessionId = 'default') {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    const filePath = path.join(STATE_DIR, `${sessionId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch { /* best-effort */ }
}

/**
 * Load canonical state from disk.
 * @param {string} [sessionId='default']
 * @returns {CanonicalState|null}
 */
function load(sessionId = 'default') {
  try {
    const filePath = path.join(STATE_DIR, `${sessionId}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Format canonical state as a carry-forward prompt string.
 * Used for cycle boundary carry-forward layer 1 (auto-preserved).
 *
 * @param {CanonicalState} state
 * @returns {string}
 */
function formatAsPrompt(state) {
  if (!state) return '';
  const parts = [];

  if (state.goal) {
    parts.push(`## Goal\n${state.goal}`);
  }

  if (state.constraints) {
    parts.push(`## Constraints\nModel: ${state.constraints.model}\nWorkspace: ${state.constraints.workspace}`);
    if (state.constraints.notes) parts.push(`Notes: ${state.constraints.notes}`);
  }

  if (state.facts?.length > 0) {
    parts.push(`## Confirmed Facts\n${state.facts.map(f => `- [${f.tool}] ${f.summary}`).join('\n')}`);
  }

  if (state.openLoops?.length > 0) {
    parts.push(`## Open Issues\n${state.openLoops.map(l => `- [${l.tool}] ${l.error}`).join('\n')}`);
  }

  if (state.pending?.length > 0) {
    parts.push(`## Pending Actions\n${state.pending.map(p => `- ${p}`).join('\n')}`);
  }

  if (state.criticalRefs?.filePaths?.length > 0) {
    parts.push(`## Key Files\n${state.criticalRefs.filePaths.map(f => `- ${f}`).join('\n')}`);
  }

  return parts.join('\n\n');
}

// ── Helpers ────────────────────────────────────────────────────────────

function _summarizeResult(result) {
  if (!result) return '';
  const out = result.output || result.content || result.text || '';
  return typeof out === 'string' ? out.slice(0, 200) : JSON.stringify(out).slice(0, 200);
}

function _summarizeError(result) {
  if (!result) return '';
  const err = result.error || result.message || '';
  return typeof err === 'string' ? err.slice(0, 200) : JSON.stringify(err).slice(0, 200);
}

function _extractPendingActions(text) {
  if (!text) return [];
  // Look for numbered lists or bullet points indicating next steps
  const lines = text.split('\n');
  const actions = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(\d+[.)\]:]|\*|-|→|>)\s/.test(trimmed) && trimmed.length > 10 && trimmed.length < 200) {
      actions.push(trimmed.replace(/^(\d+[.)\]:]|\*|-|→|>)\s*/, ''));
    }
    if (actions.length >= 5) break;
  }
  return actions;
}

module.exports = {
  buildSnapshot,
  save,
  load,
  formatAsPrompt,
};
