'use strict';

/**
 * turnEnvelope.js — derive a structured envelope for a completed agent turn.
 *
 * Why this exists (我希望Khy-os是结构化输出):
 *   Every consumer of a finished turn (CLI, web SSE, API) historically received a
 *   bare human-language string (`finalResponse`/`reply`). Downstream code that
 *   wants to know "did it succeed? what files changed? what commands ran? what
 *   failed and with which code?" had to scrape prose. That violates the project
 *   invariant: human language is for human interaction; code consumes structure.
 *
 *   This module produces a machine-consumable envelope ALONGSIDE the prose, derived
 *   PURELY from already-structured signals — `toolCallLog` entries
 *   ({ tool, params, result }), `error_code`, `pseudoRefusal`, `iterations`,
 *   `provider`, `tokenUsage`. It NEVER parses the model's free-form text to infer
 *   status or artifacts — the reply is carried verbatim as `summary`, nothing more.
 *
 * The envelope is additive: it sits next to the existing string fields so no
 * current consumer breaks; structure-aware consumers read `structured`.
 *
 * Pure & dependency-free so it is trivially testable and safe to call on the hot
 * path. Defensive against partial/garbage entries — never throws.
 */

const SCHEMA_VERSION = 1;

/** Normalize a tool name to an alias-insensitive key (write_file ≈ writeFile ≈ WRITE-FILE). */
// 收敛到 utils/normalizeAlnumKey 单一真源(逐字节委托,调用点不变)
const _normTool = require('../../utils/normalizeAlnumKey');

// Action classification by normalized tool name. Order matters: a token is tested
// against the most specific category first (edit before write, etc.).
const _DELETE = ['deletefile', 'delete', 'removefile', 'remove', 'rm', 'unlink', 'rmdir'];
const _EDIT = ['editfile', 'edit', 'stredit', 'strreplace', 'strreplaceeditor', 'multiedit',
  'multiedits', 'applypatch', 'patch', 'append', 'appendfile', 'notebookedit', 'insert', 'replace'];
const _WRITE = ['createfile', 'writefile', 'write', 'newfile', 'savefile', 'createdocument', 'renderdocument'];
const _READ = ['readfile', 'read', 'cat', 'view', 'notebookread', 'opencat'];
const _COMMAND = ['shellcommand', 'shell', 'bash', 'command', 'runcommand', 'run', 'exec',
  'execute', 'powershell', 'terminal', 'cmd', 'spawn'];

function _classify(toolName) {
  const k = _normTool(toolName);
  if (!k) return 'other';
  if (_DELETE.includes(k)) return 'delete';
  if (_EDIT.includes(k)) return 'edit';
  if (_WRITE.includes(k)) return 'write';
  if (_READ.includes(k)) return 'read';
  if (_COMMAND.includes(k)) return 'command';
  return 'other';
}

const _PATH_KEYS = ['path', 'file_path', 'filePath', 'notebook_path', 'notebookPath',
  'file', 'target', 'filename', 'fileName', 'dest', 'destination'];
const _CMD_KEYS = ['command', 'cmd', 'script', 'commandLine', 'command_line'];

function _pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Resolve a single tool result's success as a tri-state:
 *   true  — explicitly succeeded
 *   false — explicitly failed
 *   null  — unknown (no structured signal; do NOT guess from prose)
 */
function _resolveSuccess(result) {
  const r = result && typeof result === 'object' ? result : {};
  if (typeof r.success === 'boolean') return r.success;
  if (typeof r.exitCode === 'number') return r.exitCode === 0;
  if (typeof r.error === 'string' && r.error.trim()) return false;
  if (r.isError === true) return false;
  return null;
}

function _errorOf(result) {
  const r = result && typeof result === 'object' ? result : {};
  const code = (typeof r.code === 'string' && r.code)
    || (typeof r.error_code === 'string' && r.error_code)
    || undefined;
  let message;
  if (typeof r.error === 'string' && r.error.trim()) message = r.error.trim();
  else if (typeof r.message === 'string' && r.message.trim()) message = r.message.trim();
  return { code, message };
}

/**
 * Build the structured turn envelope from a completed loop/chat result.
 *
 * @param {object} finalResult - loop/chat return; reads finalResponse|reply,
 *   toolCallLog, error_code, pseudoRefusal, iterations, provider, tokenUsage, effort,
 *   terminalNotice, attribution.
 * @param {object} [opts]
 * @param {string} [opts.summary] - explicit human-facing text override (else finalResponse|reply).
 * @returns {object} structured envelope (never throws; fields always present).
 */
function buildTurnEnvelope(finalResult, opts = {}) {
  const fr = finalResult && typeof finalResult === 'object' ? finalResult : {};
  const log = Array.isArray(fr.toolCallLog) ? fr.toolCallLog : [];

  const summary = String(
    (opts && typeof opts.summary === 'string' ? opts.summary : undefined)
    ?? fr.finalResponse ?? fr.reply ?? '',
  );

  const artifacts = [];
  const filesTouchedSet = new Set();
  const filesReadSet = new Set();
  const commands = [];
  const errors = [];
  let failedCount = 0;
  let succeededCount = 0;

  for (const entry of log) {
    if (!entry || typeof entry !== 'object') continue;
    const tool = String(entry.tool || '').trim();
    if (!tool || tool === '_legacy_cmd') continue;
    const kind = _classify(tool);
    const success = _resolveSuccess(entry.result);
    if (success === true) succeededCount += 1;
    else if (success === false) failedCount += 1;

    if (kind === 'command') {
      const command = _pick(entry.params, _CMD_KEYS);
      const r = entry.result && typeof entry.result === 'object' ? entry.result : {};
      commands.push({
        tool,
        command: command || null,
        success,
        exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
      });
    } else if (kind === 'write' || kind === 'edit' || kind === 'delete' || kind === 'read') {
      const path = _pick(entry.params, _PATH_KEYS);
      if (path) {
        artifacts.push({ path, action: kind, tool });
        if (kind === 'read') filesReadSet.add(path);
        else if (success !== false) filesTouchedSet.add(path); // only count a mutation that did not explicitly fail
      }
    }

    if (success === false) {
      const e = _errorOf(entry.result);
      errors.push({ tool, code: e.code || null, message: e.message || null });
    }
  }

  // Top-level turn-level error (pseudo-refusal / classified failure) outranks per-tool noise.
  const topErrorCode = (typeof fr.error_code === 'string' && fr.error_code) ? fr.error_code : null;
  const pseudoRefusal = fr.pseudoRefusal === true;
  if (topErrorCode || pseudoRefusal) {
    const att = fr.attribution && typeof fr.attribution === 'object' ? fr.attribution : {};
    errors.unshift({
      tool: null,
      code: topErrorCode || 'PSEUDO_REFUSAL',
      message: (typeof att.message === 'string' && att.message) || null,
    });
  }

  const toolCalls = commands.length + artifacts.length;
  let status;
  if (topErrorCode || pseudoRefusal) {
    status = 'error';
  } else if (toolCalls === 0) {
    status = 'ok'; // pure Q&A turn — structured too: ok with empty artifacts
  } else if (failedCount === 0) {
    status = 'ok';
  } else if (succeededCount === 0) {
    status = 'error'; // every tool failed
  } else {
    status = 'partial';
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    status,
    summary,
    artifacts,
    filesTouched: Array.from(filesTouchedSet),
    filesRead: Array.from(filesReadSet),
    commands,
    errors,
    metrics: {
      iterations: Number.isFinite(fr.iterations) ? fr.iterations : null,
      toolCalls,
      artifactCount: artifacts.length,
      commandCount: commands.length,
      provider: fr.provider || null,
      effort: fr.effort || null,
      tokenUsage: fr.tokenUsage || null,
    },
  };
}

module.exports = { buildTurnEnvelope, SCHEMA_VERSION, _classify, _resolveSuccess };
