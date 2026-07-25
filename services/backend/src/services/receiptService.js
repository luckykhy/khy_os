'use strict';

/**
 * receiptService.js — Structured, auditable execution receipts.
 *
 * Learned from DesireCore (Agent OS): every delegated execution should produce
 * an immutable, queryable "回执" (Receipt) instead of only scattered logs. A
 * receipt bundles one turn (one user request → all of its tool calls) into a
 * single record with six canonical fields:
 *
 *   1. goal         (执行目标)     — what the user asked for.
 *   2. plan         (执行计划)     — the plan/steps the agent committed to.
 *   3. toolChain    (工具调用链)   — ordered tool calls: name + param summary +
 *                                    result + elapsed + step type + risk.
 *   4. artifacts    (产物与变更)   — files created/edited/deleted, output summary.
 *   5. riskApproval (风险与审批)   — highest risk, human-gated steps, denials.
 *   6. error        (错误信息)     — aggregated errors, if any.
 *
 * Design:
 *   - One open receipt per sessionId, held in memory while the turn runs.
 *   - `startReceipt` opens it; if one is already open for the session it is
 *     auto-finalized first (so a missed finalize never leaks across turns).
 *   - `appendToolCall` is called from the single tool funnel (executeTool); it
 *     lazily opens an ad-hoc receipt if none is open, so tool calls made
 *     outside a loop are still recorded.
 *   - `finalizeReceipt` stamps status/artifacts, writes an immutable JSON file
 *     under getDataDir('receipts', <sessionId>, '<id>.json'), and emits a
 *     `tool.receipt` event onto the trace/audit bus. It is idempotent.
 *
 * Zero hardcoding: all paths resolve through utils/dataHome (→ .khy); all
 * tunables read from env with safe defaults. Pure side-effect isolation: every
 * disk/audit interaction is wrapped so a receipt failure never breaks a turn.
 */

const fs = require('fs');
const path = require('path');

const { getDataDir } = require('../utils/dataHome');

// Param/string truncation budget — matches auditLog's 200-char convention.
const MAX_STR = (() => {
  const n = parseInt(process.env.KHY_RECEIPT_MAX_STR || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 200;
})();

const SENSITIVE_KEYS = ['password', 'apikey', 'token', 'secret', 'key', 'credential'];

// Tools whose execution mutates the workspace — used to derive the artifacts
// field from the tool chain without a second source of truth.
const WRITE_TOOLS = new Set(['write', 'writefile', 'createfile', 'create_file', 'write_file']);
const EDIT_TOOLS = new Set(['edit', 'editfile', 'multiedit', 'edit_file', 'apply_patch']);
const DELETE_TOOLS = new Set(['delete', 'deletefile', 'rm', 'remove', 'delete_file']);

const { RISK_ORDER } = require('../constants/riskOrder'); // single source of truth

/** @type {Map<string, object>} sessionId → open receipt */
const _open = new Map();

// ── Helpers ──────────────────────────────────────────────────────────

function _sessionKey(sessionId) {
  return sessionId ? String(sessionId) : '_no-session';
}

function _two(n) { return String(n).padStart(2, '0'); }

/**
 * Build a sortable receipt id: RCPT-YYYYMMDD-HHMMSS-<rand>.
 * The random suffix avoids collisions within the same second.
 */
function _newReceiptId() {
  const d = new Date();
  const stamp =
    `${d.getFullYear()}${_two(d.getMonth() + 1)}${_two(d.getDate())}` +
    `-${_two(d.getHours())}${_two(d.getMinutes())}${_two(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `RCPT-${stamp}-${rand}`;
}

function _summarizeParams(params) {
  if (!params || typeof params !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (k.startsWith('_')) continue; // internal fields
    if (SENSITIVE_KEYS.some(s => k.toLowerCase().includes(s))) {
      out[k] = '***';
    } else if (typeof v === 'string' && v.length > MAX_STR) {
      out[k] = `${v.slice(0, MAX_STR)}… (${v.length} chars)`;
    } else if (v && typeof v === 'object') {
      out[k] = '[object]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function _summarizeResult(result) {
  if (!result || typeof result !== 'object') {
    return { success: false };
  }
  const summary = { success: !!result.success };
  if (result.error) summary.error = String(result.error).slice(0, MAX_STR);
  if (typeof result.output === 'string' && result.output) {
    summary.output = result.output.length > MAX_STR
      ? `${result.output.slice(0, MAX_STR)}… (${result.output.length} chars)`
      : result.output;
  }
  if (result.exitCode != null) summary.exitCode = result.exitCode;
  return summary;
}

// 收敛到 utils/normalizeToolName 单一真源(逐字节委托,调用点不变)
const _normTool = require('../utils/normalizeToolName');

function _filePathOf(params) {
  if (!params || typeof params !== 'object') return '';
  return params.file_path || params.filePath || params.path || '';
}

function _higherRisk(a, b) {
  return (RISK_ORDER[a] ?? 2) >= (RISK_ORDER[b] ?? 2) ? a : b;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Open a receipt for a session/turn. Auto-finalizes any previously open
 * receipt for the same session (defensive against a missed finalize).
 *
 * @param {object} ctx
 * @param {string} [ctx.sessionId]
 * @param {string} [ctx.traceId]
 * @param {string} [ctx.requestId]
 * @param {string} [ctx.goal]   — the user request (执行目标)
 * @param {string} [ctx.plan]   — committed plan, if known at start (执行计划)
 * @param {string} [ctx.companionId] — active companion id; defaults to the active pointer
 * @returns {object} the open receipt
 */
function startReceipt(ctx = {}) {
  const key = _sessionKey(ctx.sessionId);
  if (_open.has(key)) {
    // Flush the stale one before opening a new turn.
    try { finalizeReceipt({ sessionId: ctx.sessionId, status: 'partial' }); } catch { /* ignore */ }
  }
  // Associate with the active companion (AgentFS #2 五类资产: Receipts). Explicit
  // ctx.companionId wins; otherwise fall back to the active companion pointer.
  let companionId = ctx.companionId || null;
  if (!companionId) {
    try { companionId = require('./agentFs/agentFsService').getActiveAgentId(); } catch { companionId = null; }
  }

  const receipt = {
    id: _newReceiptId(),
    sessionId: ctx.sessionId || null,
    companionId: companionId || null,
    traceId: ctx.traceId || null,
    requestId: ctx.requestId || null,
    status: 'running',
    goal: ctx.goal ? String(ctx.goal).slice(0, 2000) : '',
    plan: ctx.plan ? String(ctx.plan).slice(0, 4000) : '',
    toolChain: [],
    artifacts: { files: [], summary: '' },
    riskApproval: { maxRisk: 'safe', humanGated: [], denied: [], permissions: {} },
    error: null,
    gitCommit: null,
    startedAt: new Date().toISOString(),
    startedTs: Date.now(),
    finalizedAt: null,
    durationMs: 0,
    counts: { tools: 0, ok: 0, failed: 0 },
  };
  _open.set(key, receipt);
  return receipt;
}

/**
 * Append a single tool call to the open receipt. Lazily opens an ad-hoc
 * receipt if none is open so out-of-loop tool calls are still recorded.
 *
 * @param {object} entry
 * @param {string} [entry.sessionId]
 * @param {string} entry.tool
 * @param {object} [entry.params]
 * @param {object} [entry.result]
 * @param {number} [entry.elapsedMs]
 * @param {string} [entry.permission]
 * @param {string} [entry.stepType]  — hardened|flexible|human-gate
 * @param {string} [entry.risk]      — safe|low|medium|high|critical
 * @param {string} [entry.error]
 */
function appendToolCall(entry = {}) {
  if (!entry.tool) return;
  const key = _sessionKey(entry.sessionId);
  let receipt = _open.get(key);
  if (!receipt) {
    receipt = startReceipt({ sessionId: entry.sessionId, goal: '(ad-hoc tool call)' });
  }

  const success = entry.result ? entry.result.success !== false : !entry.error;
  const status = entry.permission === 'deny'
    ? 'denied'
    : (success ? 'ok' : 'failed');

  const call = {
    seq: receipt.toolChain.length + 1,
    tool: entry.tool,
    params: _summarizeParams(entry.params),
    result: _summarizeResult(entry.result),
    status,
    elapsedMs: Number(entry.elapsedMs) || 0,
    stepType: entry.stepType || 'flexible',
    risk: entry.risk || 'medium',
    permission: entry.permission || 'unknown',
    error: entry.error ? String(entry.error).slice(0, MAX_STR) : null,
    timestamp: new Date().toISOString(),
  };
  receipt.toolChain.push(call);

  // Counters
  receipt.counts.tools += 1;
  if (status === 'ok') receipt.counts.ok += 1;
  else if (status === 'failed') receipt.counts.failed += 1;

  // Risk / approval rollup (可控)
  receipt.riskApproval.maxRisk = _higherRisk(receipt.riskApproval.maxRisk, call.risk);
  if (call.stepType === 'human-gate') {
    receipt.riskApproval.humanGated.push({ seq: call.seq, tool: call.tool, risk: call.risk });
  }
  if (status === 'denied') {
    receipt.riskApproval.denied.push({ seq: call.seq, tool: call.tool });
  }
  const p = call.permission;
  receipt.riskApproval.permissions[p] = (receipt.riskApproval.permissions[p] || 0) + 1;

  // Artifact derivation (产物与变更) — only on successful mutations.
  if (status === 'ok') {
    const n = _normTool(call.tool);
    const fp = _filePathOf(entry.params);
    if (fp) {
      let action = null;
      if (WRITE_TOOLS.has(n)) action = 'write';
      else if (EDIT_TOOLS.has(n)) action = 'edit';
      else if (DELETE_TOOLS.has(n)) action = 'delete';
      if (action) receipt.artifacts.files.push({ action, path: fp, seq: call.seq });
    }
  }

  // First-seen error becomes the receipt-level error summary.
  if (!receipt.error && call.error) receipt.error = call.error;

  return call;
}

/**
 * Finalize and persist the open receipt for a session. Idempotent: a second
 * call with no open receipt is a no-op returning null.
 *
 * @param {object} opts
 * @param {string} [opts.sessionId]
 * @param {string} [opts.status]    — completed|failed|partial|interrupted
 * @param {string} [opts.plan]      — plan filled in late (overrides start)
 * @param {string} [opts.summary]   — final delivery text / artifact summary
 * @param {string} [opts.error]
 * @param {string} [opts.gitCommit]
 * @returns {object|null} the finalized receipt, or null if none was open
 */
function finalizeReceipt(opts = {}) {
  const key = _sessionKey(opts.sessionId);
  const receipt = _open.get(key);
  if (!receipt) return null;
  _open.delete(key);

  receipt.finalizedAt = new Date().toISOString();
  receipt.durationMs = Date.now() - receipt.startedTs;
  if (opts.plan && !receipt.plan) receipt.plan = String(opts.plan).slice(0, 4000);
  if (opts.summary) receipt.artifacts.summary = String(opts.summary).slice(0, 2000);
  if (opts.error && !receipt.error) receipt.error = String(opts.error).slice(0, MAX_STR);
  if (opts.gitCommit) receipt.gitCommit = String(opts.gitCommit);

  // Derive status when not explicitly provided.
  if (opts.status) {
    receipt.status = opts.status;
  } else if (receipt.counts.failed > 0) {
    receipt.status = 'partial';
  } else {
    receipt.status = 'completed';
  }

  // Persist immutably.
  try {
    const dir = getDataDir('receipts', _sessionKey(receipt.sessionId));
    fs.writeFileSync(path.join(dir, `${receipt.id}.json`), JSON.stringify(receipt, null, 2));
  } catch { /* persistence failure is non-critical to the turn */ }

  // Emit onto the trace/audit bus for trace correlation + remote sinks.
  try {
    const traceAudit = require('./traceAuditService');
    traceAudit.logEvent('tool.receipt', {
      receiptId: receipt.id,
      status: receipt.status,
      tools: receipt.counts.tools,
      ok: receipt.counts.ok,
      failed: receipt.counts.failed,
      maxRisk: receipt.riskApproval.maxRisk,
      humanGated: receipt.riskApproval.humanGated.length,
      durationMs: receipt.durationMs,
    }, {
      sessionId: receipt.sessionId,
      traceId: receipt.traceId,
      requestId: receipt.requestId,
      source: 'receipt-service',
      visibility: 'summary',
    });
  } catch { /* trace audit optional */ }

  return receipt;
}

/** Read the (still open) receipt for a session, if any. */
function getOpenReceipt(sessionId) {
  return _open.get(_sessionKey(sessionId)) || null;
}

// ── Query (CLI: khy receipts) ────────────────────────────────────────

function _receiptsRoot() {
  return getDataDir('receipts');
}

function _readReceiptFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Walk every receipt JSON across all session folders. */
function _allReceiptFiles() {
  const root = _receiptsRoot();
  const files = [];
  let sessions = [];
  try { sessions = fs.readdirSync(root); } catch { return files; }
  for (const s of sessions) {
    const sdir = path.join(root, s);
    let entries = [];
    try {
      if (!fs.statSync(sdir).isDirectory()) continue;
      entries = fs.readdirSync(sdir);
    } catch { continue; }
    for (const e of entries) {
      if (e.startsWith('RCPT-') && e.endsWith('.json')) files.push(path.join(sdir, e));
    }
  }
  return files;
}

/**
 * List receipts, most recent first.
 * @param {object} [opts]
 * @param {string} [opts.sessionId] — restrict to one session
 * @param {string} [opts.companionId] — restrict to one companion (AgentFS agent)
 * @param {number} [opts.limit=50]
 * @returns {object[]} compact receipt summaries
 */
function listReceipts(opts = {}) {
  const limit = opts.limit || 50;
  let files;
  if (opts.sessionId) {
    const sdir = path.join(_receiptsRoot(), _sessionKey(opts.sessionId));
    try {
      files = fs.readdirSync(sdir)
        .filter(e => e.startsWith('RCPT-') && e.endsWith('.json'))
        .map(e => path.join(sdir, e));
    } catch { files = []; }
  } else {
    files = _allReceiptFiles();
  }
  let records = files.map(_readReceiptFile).filter(Boolean);
  if (opts.companionId) {
    records = records.filter(r => r.companionId === opts.companionId);
  }
  records.sort((a, b) => String(b.id).localeCompare(String(a.id)));
  return records.slice(0, limit).map(r => ({
    id: r.id,
    sessionId: r.sessionId,
    companionId: r.companionId || null,
    status: r.status,
    goal: (r.goal || '').slice(0, 80),
    tools: r.counts?.tools || 0,
    maxRisk: r.riskApproval?.maxRisk || 'safe',
    startedAt: r.startedAt,
    durationMs: r.durationMs,
  }));
}

/** Load a full receipt by id (searches all sessions). */
function getReceipt(id) {
  if (!id) return null;
  for (const f of _allReceiptFiles()) {
    if (path.basename(f) === `${id}.json`) return _readReceiptFile(f);
  }
  return null;
}

/**
 * Full-text search over goal, plan, tool names, and file paths.
 * @param {string} keyword
 * @param {object} [opts] — { limit }
 */
function searchReceipts(keyword, opts = {}) {
  const kw = String(keyword || '').toLowerCase().trim();
  if (!kw) return [];
  const limit = opts.limit || 50;
  const hits = [];
  for (const f of _allReceiptFiles()) {
    const r = _readReceiptFile(f);
    if (!r) continue;
    const haystack = [
      r.goal, r.plan, r.error,
      ...(r.toolChain || []).map(c => c.tool),
      ...(r.artifacts?.files || []).map(a => a.path),
    ].join(' ').toLowerCase();
    if (haystack.includes(kw)) {
      hits.push({
        id: r.id, sessionId: r.sessionId, status: r.status,
        goal: (r.goal || '').slice(0, 80), startedAt: r.startedAt,
      });
    }
  }
  hits.sort((a, b) => String(b.id).localeCompare(String(a.id)));
  return hits.slice(0, limit);
}

// ── Orchestration rollup receipts (B1) ───────────────────────────────
// A single orchestration run (one AgentTool fan-out over N subtasks) produces
// one rollup receipt distinct from the per-turn tool receipt above. It records
// per-subtask duration / executor / step-type so a multi-agent run is auditable
// as a unit. Persisted under receipts/orchestration/<sessionId>/ORCH-<ts>.json.

function _newOrchId() {
  const d = new Date();
  const stamp =
    `${d.getFullYear()}${_two(d.getMonth() + 1)}${_two(d.getDate())}` +
    `-${_two(d.getHours())}${_two(d.getMinutes())}${_two(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `ORCH-${stamp}-${rand}`;
}

/**
 * Persist an orchestration rollup receipt and emit a trace event.
 * @param {object} entry
 * @param {string} [entry.sessionId]
 * @param {string} [entry.goal]
 * @param {string} [entry.mode]  flexible | hardened | mixed
 * @param {object} entry.summary  output of SubAgentOrchestrator.summarize()
 * @param {string} [entry.status]
 * @returns {object|null} the persisted receipt
 */
function saveOrchestrationReceipt(entry = {}) {
  const summary = entry.summary || {};
  const status = entry.status
    || (summary.failCount > 0 ? (summary.successCount > 0 ? 'partial' : 'failed') : 'completed');

  const receipt = {
    id: _newOrchId(),
    sessionId: _sessionKey(entry.sessionId),
    goal: entry.goal ? String(entry.goal).slice(0, MAX_STR) : '',
    mode: entry.mode || 'flexible',
    status,
    subtaskCount: summary.subtaskCount || 0,
    successCount: summary.successCount || 0,
    failCount: summary.failCount || 0,
    totalDurationMs: summary.totalDurationMs || 0,
    byStepType: summary.byStepType || {},
    byExecutor: summary.byExecutor || {},
    subtasks: Array.isArray(summary.subtasks) ? summary.subtasks : [],
    startedAt: entry.startedAt || null,
    finalizedAt: new Date().toISOString(),
  };

  try {
    const dir = getDataDir('receipts', 'orchestration', receipt.sessionId);
    fs.writeFileSync(path.join(dir, `${receipt.id}.json`), JSON.stringify(receipt, null, 2));
  } catch { /* persistence failure is non-critical */ }

  try {
    const traceAudit = require('./traceAuditService');
    traceAudit.logEvent('tool.orchestration.receipt', {
      receiptId: receipt.id,
      mode: receipt.mode,
      status: receipt.status,
      subtaskCount: receipt.subtaskCount,
      successCount: receipt.successCount,
      failCount: receipt.failCount,
      totalDurationMs: receipt.totalDurationMs,
      byExecutor: receipt.byExecutor,
      byStepType: receipt.byStepType,
    }, {
      sessionId: receipt.sessionId,
      source: 'receipt-service',
      visibility: 'summary',
    });
  } catch { /* trace audit optional */ }

  return receipt;
}

/**
 * List persisted orchestration receipts (most recent first).
 * @param {object} [opts]
 * @param {number} [opts.limit=20]
 * @returns {object[]}
 */
function listOrchestrationReceipts(opts = {}) {
  const limit = opts.limit || 20;
  const root = getDataDir('receipts', 'orchestration');
  const out = [];
  try {
    for (const sess of fs.readdirSync(root)) {
      const sessDir = path.join(root, sess);
      let stat;
      try { stat = fs.statSync(sessDir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      for (const f of fs.readdirSync(sessDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          out.push(JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf-8')));
        } catch { /* skip unreadable */ }
      }
    }
  } catch { /* no orchestration receipts yet */ }
  out.sort((a, b) => String(b.id).localeCompare(String(a.id)));
  return out.slice(0, limit);
}

module.exports = {
  startReceipt,
  appendToolCall,
  finalizeReceipt,
  getOpenReceipt,
  listReceipts,
  getReceipt,
  searchReceipts,
  saveOrchestrationReceipt,
  listOrchestrationReceipts,
};
