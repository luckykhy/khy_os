'use strict';

/**
 * toolGuards.js — Built-in ToolGuard hooks for tool execution safety.
 *
 * Guards shipped with the system:
 *   1. OutputSizeGuard    (PostToolUse)  — truncate outputs >200KB
 *   2. EditBoundaryGuard  (PreToolUse)  — block edits outside project root
 *   3. ShellTimeoutGuard  (PreToolUse)  — warn on shell commands without timeout
 *   4. PriorReadGuard     (PreToolUse)  — block edits on files not yet read (G5)
 *   5. FileStaleGuard     (PreToolUse)  — block edits on externally modified files (G5 TOCTOU)
 *   6. LspDiagnosticsGuard (PostToolUse) — inject LSP diagnostics after edits (G1)
 *
 * Disable all guards: KHY_TOOL_GUARDS=false
 * Disable individual guards: add source ID to hooks.json "disabled" array
 */

const fs = require('fs');
const path = require('path');
const envInt = require('../utils/envInt');

const MAX_OUTPUT_BYTES = 200 * 1024; // 200KB

/**
 * PostToolUse guard: truncate tool output exceeding MAX_OUTPUT_BYTES.
 * Uses smart truncation (head+tail) to preserve the most useful parts.
 */
function outputSizeGuard(ctx) {
  if (ctx.result && typeof ctx.result === 'object') {
    const output = ctx.result.output || ctx.result.content || ctx.result.text;
    if (typeof output === 'string' && output.length > MAX_OUTPUT_BYTES) {
      const headSize = Math.min(2048, Math.floor(MAX_OUTPUT_BYTES * 0.15));
      const tailSize = MAX_OUTPUT_BYTES - headSize - 120;
      const omitted = output.length - headSize - tailSize;
      const truncated = output.slice(0, headSize)
        + `\n\n... [${omitted} chars omitted — head+tail preserved by OutputSizeGuard] ...\n\n`
        + output.slice(output.length - tailSize);
      return {
        action: 'modify',
        result: {
          ...ctx.result,
          output: truncated,
          _truncated: true,
          _originalSize: output.length,
        },
      };
    }
  }
  return { action: 'allow' };
}

/**
 * PreToolUse guard: block file edits/writes outside the project root.
 */
function editBoundaryGuard(ctx) {
  const filePath = ctx.params?.file_path || ctx.params?.filePath || ctx.params?.path;
  if (!filePath) return { action: 'allow' };

  const root = process.env.KHYQUANT_CWD || process.cwd();
  let abs;
  try {
    abs = path.resolve(root, filePath);
  } catch {
    return { action: 'allow' }; // can't resolve — let the tool handle it
  }

  // [SAFE] Defense-in-depth twin of the tool-level validateNoPathTraversal fix.
  // The trusted-root allowance below treats the ENTIRE home dir as writable, so
  // an absolute path like /home/<user>/.ssh/authorized_keys would be ALLOWED here
  // even for a tool that does not self-confine — a second privilege-escalation
  // path independent of the tool layer. Reject home-internal escalation/
  // persistence sinks (SSH keys, shell rc, GPG, autostart/systemd/LaunchAgent)
  // FIRST, before any trusted-root pass. Single source of truth: the same
  // denylist used by validateNoPathTraversal.
  try {
    if (require('../tools/inputValidators').isSensitiveHomeWrite(abs)) {
      return {
        action: 'block',
        reason: `Write to sensitive home location blocked: ${abs} (SSH/shell-rc/GPG/autostart persistence vector)`,
        source: 'EditBoundaryGuard',
      };
    }
  } catch { /* validator unavailable — fall through */ }

  const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(normalizedRoot)) {
    // Directories the user explicitly granted this session via `/add-dir` are
    // allowed roots (Claude Code parity). Checked before the strict gate because
    // the grant is an explicit, deliberate authorization — but AFTER the
    // sensitive-home-write denylist above, which is never bypassed.
    try {
      if (require('./additionalDirectories').isUnderAdditionalDir(abs)) {
        return { action: 'allow' };
      }
    } catch { /* module unavailable — fall through */ }

    // Allow the user's own data folders (home / Desktop / Documents / Downloads),
    // including drive-relocated ones, without an approval prompt. System paths
    // still fall through to the approvable block. KHY_STRICT_WRITE_BOUNDARY=1 opts out.
    const strict = String(process.env.KHY_STRICT_WRITE_BOUNDARY || '').trim() === '1';
    if (!strict) {
      try {
        if (require('../tools/_userDirs').isUnderTrustedRoot(abs)) {
          return { action: 'allow' };
        }
      } catch { /* fall through to block */ }
    }
    return {
      action: 'block',
      reason: `Edit outside project root blocked: ${abs} is not under ${root}`,
      approvable: true,
      source: 'EditBoundaryGuard',
    };
  }
  return { action: 'allow' };
}

/**
 * PreToolUse guard: gate file READS outside the project root behind approval.
 *
 * Mirrors editBoundaryGuard's boundary logic for the read path so the goal —
 * "subdirectories of the project need no authorization, but other working
 * directories do; once authorized, access is allowed" — holds for reads too,
 * not just writes. Reads under the project root, under a `/add-dir` grant, or
 * (unless KHY_STRICT_READ_BOUNDARY=1) under the user's own trusted data folders
 * are allowed silently; anything else becomes a soft, approvable block whose
 * "always" approval grants the directory via additionalDirectories.
 *
 * No sensitive-home-write denylist here — that protects against *persistence
 * vectors* written into home, which is write-specific and irrelevant to reads.
 */
function readBoundaryGuard(ctx) {
  const filePath = ctx.params?.file_path || ctx.params?.filePath || ctx.params?.path;
  if (!filePath) return { action: 'allow' };

  const root = process.env.KHYQUANT_CWD || process.cwd();
  let abs;
  try {
    abs = path.resolve(root, filePath);
  } catch {
    return { action: 'allow' }; // can't resolve — let the tool handle it
  }

  const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(normalizedRoot)) {
    // Explicit `/add-dir` (or previously-approved) grants are allowed roots.
    try {
      if (require('./additionalDirectories').isUnderAdditionalDir(abs)) {
        return { action: 'allow' };
      }
    } catch { /* module unavailable — fall through */ }

    // The user's own data folders read silently unless strict reads are on.
    const strict = String(process.env.KHY_STRICT_READ_BOUNDARY || '').trim() === '1';
    if (!strict) {
      try {
        if (require('../tools/_userDirs').isUnderTrustedRoot(abs)) {
          return { action: 'allow' };
        }
      } catch { /* fall through to block */ }
    }
    return {
      action: 'block',
      reason: `Read outside project root blocked: ${abs} is not under ${root}`,
      approvable: true,
      source: 'ReadBoundaryGuard',
    };
  }
  return { action: 'allow' };
}

/**
 * PreToolUse guard: inject default timeout when shell commands lack one.
 * Prevents hanging processes that block the entire tool loop.
 */
const DEFAULT_SHELL_TIMEOUT_MS = parseInt(process.env.KHY_SHELL_DEFAULT_TIMEOUT_MS || '30000', 10);

function shellTimeoutGuard(ctx) {
  if (!ctx.params?.timeout && !ctx.params?.timeout_ms) {
    return {
      action: 'modify',
      params: {
        ...ctx.params,
        timeout: DEFAULT_SHELL_TIMEOUT_MS,
        _timeoutInjected: true,
      },
    };
  }
  return { action: 'allow' };
}

// ── Rate Limit Guard (PreToolUse) ──────────────────────────────────

const _toolCallCounts = new Map(); // toolName → [timestamp, ...]
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 50;

/**
 * PreToolUse guard: block tools called more than RATE_LIMIT_MAX times per minute.
 */
function rateLimitGuard(ctx) {
  const tool = ctx.toolName || ctx.params?._toolName;
  if (!tool) return { action: 'allow' };
  const now = Date.now();
  const history = _toolCallCounts.get(tool) || [];
  const recent = history.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  _toolCallCounts.set(tool, recent);
  if (recent.length > RATE_LIMIT_MAX) {
    return {
      action: 'block',
      reason: `Rate limit: ${tool} called ${recent.length} times in ${RATE_LIMIT_WINDOW_MS / 1000}s (max ${RATE_LIMIT_MAX})`,
    };
  }
  return { action: 'allow' };
}

// ── Path Traversal Guard (PreToolUse) ─────────────────────────────

/**
 * PreToolUse guard: block file paths that escape the project root via '..' traversal.
 */
function pathTraversalGuard(ctx) {
  const fp = ctx.params?.file_path || ctx.params?.path || ctx.params?.filePath || '';
  if (!fp || !fp.includes('..')) return { action: 'allow' };
  if (!/\.\.[/\\]/.test(fp)) return { action: 'allow' };

  const root = process.env.KHYQUANT_CWD || process.cwd();
  try {
    const resolved = path.resolve(root, fp);
    const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved !== root && !resolved.startsWith(normalizedRoot)) {
      // A `..` path that lands inside an explicitly granted /add-dir directory is
      // a legitimate cross-root access, not an escape — allow it (CC parity).
      try {
        if (require('./additionalDirectories').isUnderAdditionalDir(resolved)) {
          return { action: 'allow' };
        }
      } catch { /* module unavailable — fall through to block */ }
      return {
        action: 'block',
        reason: `Path traversal detected: ${fp} resolves outside project root`,
      };
    }
  } catch { /* can't resolve — let the tool handle it */ }
  return { action: 'allow' };
}

// ── Error Recovery Guard (PostToolUse) ────────────────────────────

/**
 * PostToolUse guard: inject recovery hints for common error patterns.
 */
function errorRecoveryGuard(ctx) {
  const result = ctx.result;
  if (!result || result.success !== false) return { action: 'allow' };

  const error = result.error || result.output || '';
  let hint = null;
  if (/old_?string not found|no match/i.test(error)) {
    hint = 'Re-read the file to get current content, then retry with updated old_string.';
  } else if (/permission denied/i.test(error)) {
    hint = 'Check file permissions or use an alternative path.';
  } else if (/timed?\s*out/i.test(error)) {
    hint = 'Break the command into smaller steps or increase timeout.';
  }

  if (hint) {
    return { action: 'modify', result: { ...result, _recoveryHint: hint } };
  }
  return { action: 'allow' };
}

// ── Prior-Read Enforcement Guard (PreToolUse) — G5 ──────────────
const EDIT_TOOL_PATTERN = /^(editFile|edit_file|edit|write_file|writeFile|apply_patch)$/i;

// Single source of truth for platform-aware path normalization, shared with the
// read tracker so the guard's lookup key matches how reads are recorded
// (Windows drive-case / slash direction parity). Falls back to a plain resolve
// if the tracker is unavailable.
let _normalizePath;
try {
  _normalizePath = require('../tools/_readTracker').normalizePath;
} catch { /* fall back below */ }
if (typeof _normalizePath !== 'function') {
  _normalizePath = (fp) => path.resolve(fp);
}

function _resolveFilePath(fp) {
  if (!fp) return null;
  try {
    return _normalizePath(path.resolve(process.env.KHYQUANT_CWD || process.cwd(), fp));
  } catch { return null; }
}

/**
 * PreToolUse guard: block file edits/writes when the file has not been read
 * in the current session. Prevents blind edits on files the model hasn't seen.
 *
 * Creating a NEW file is always allowed: there is nothing to read, and requiring
 * a prior Read would deadlock (Read fails with "file not found" on a path that
 * does not exist yet, so it could never satisfy the guard).
 */
function priorReadGuard(ctx) {
  const fp = ctx.params?.file_path || ctx.params?.path || ctx.params?.filePath;
  if (!fp) return { action: 'allow' };
  // apply_patch operates on multiple files — skip per-file check here
  if (/^apply_patch$/i.test(ctx.toolName)) return { action: 'allow' };
  const abs = _resolveFilePath(fp);
  if (!abs) return { action: 'allow' };
  // New-file creation: the target does not exist on disk → nothing to read.
  try { if (!fs.existsSync(abs)) return { action: 'allow' }; } catch { return { action: 'allow' }; }
  // Existing file: honor a prior read recorded in either the read tracker
  // (Windows-aware key) or the hash map; both are populated on a successful read.
  let readByTracker = false;
  try {
    const rt = require('../tools/_readTracker');
    if (rt && typeof rt.hasRead === 'function') readByTracker = rt.hasRead(abs);
  } catch { /* ignore */ }
  const readMap = ctx._fileReadHashes;
  if (readByTracker) return { action: 'allow' };
  if (!readMap) return { action: 'allow' }; // no tracking available = allow (backward compat)
  if (!readMap.has(abs)) {
    return {
      action: 'block',
      reason: `Prior-read required: ${fp} was not read this session. Use the Read tool first.`,
      approvable: true,
      source: 'PriorReadGuard',
    };
  }
  return { action: 'allow' };
}

/**
 * PreToolUse guard: block edits on files that have been externally modified
 * since the last read (TOCTOU check via mtime + size).
 */
function fileStaleGuard(ctx) {
  const fp = ctx.params?.file_path || ctx.params?.path || ctx.params?.filePath;
  if (!fp) return { action: 'allow' };
  if (/^apply_patch$/i.test(ctx.toolName)) return { action: 'allow' };
  const abs = _resolveFilePath(fp);
  if (!abs) return { action: 'allow' };
  const readMap = ctx._fileReadHashes;
  const entry = readMap?.get(abs);
  if (!entry || entry.mtime == null) return { action: 'allow' };
  try {
    const st = fs.statSync(abs);
    if (st.mtimeMs !== entry.mtime || st.size !== entry.size) {
      return {
        action: 'block',
        reason: `File changed since last read (external modification detected). Re-read before editing: ${fp}`,
        approvable: true,
        source: 'FileStaleGuard',
      };
    }
  } catch { /* file gone — let the tool handle it */ }
  return { action: 'allow' };
}

/**
 * PreToolUse guard: project hygiene ([DESIGN-ARCH-054]) — block a write that
 * would (1) produce a "god file" over the LOC ceiling, or (2) create a new file
 * that re-implements functionality an existing file already provides. Both are
 * approvable: the user can override deliberately, but the detour is surfaced
 * instead of silently shipped.
 *
 * Two shapes are covered:
 *   1. single write — `write_file`/`writeFile` carry the FULL resulting content
 *      in params.content (a create or full overwrite).
 *   2. batch scaffold — `scaffoldFiles` (and aliases) carry params.files[]
 *      `{path, content}`; this is how the agent generates a whole project, so
 *      it must be checked too or "no god component" is trivially bypassable.
 * Edits via old_string/new_string don't carry the whole file pre-apply, so
 * file-growth there is left to the repo-wide arch-debt scan
 * (scripts/archDebtScan.js R2). Fail-open throughout.
 */
function projectHygieneGuard(ctx) {
  try {
    let hygiene;
    try { hygiene = require('./projectHygiene'); } catch { return { action: 'allow' }; }

    // ── Batch scaffold shape (project generation) ──
    if (Array.isArray(ctx.params?.files)) {
      const verdict = hygiene.assessScaffold({ files: ctx.params.files });
      return _hygieneVerdictToAction(verdict);
    }

    // ── Single-write shape ──
    const fp = ctx.params?.file_path || ctx.params?.path || ctx.params?.filePath;
    const content = ctx.params?.content;
    if (!fp || typeof content !== 'string') return { action: 'allow' };
    const abs = _resolveFilePath(fp);
    const verdict = hygiene.assessWrite({ path: abs || fp, content });
    return _hygieneVerdictToAction(verdict);
  } catch {
    return { action: 'allow' };
  }
}

/** Shared: turn a projectHygiene verdict into an approvable block (or allow). */
function _hygieneVerdictToAction(verdict) {
  if (!verdict || verdict.ok || !verdict.violations || verdict.violations.length === 0) {
    return { action: 'allow' };
  }
  // Surface every violation in one reason so the user sees the full picture.
  const reason = verdict.violations.map((v) => v.message).join('\n');
  return {
    action: 'block',
    reason,
    approvable: true,
    source: 'ProjectHygieneGuard',
    _hygieneViolations: verdict.violations,
  };
}

// ── LSP Post-Edit Diagnostics Guard (PostToolUse) — G1 ──────────

const LSP_DIAG_WAIT_MS = parseInt(process.env.KHY_LSP_DIAG_WAIT_MS, 10) || 200;

/**
 * PostToolUse guard: after successful file edits, collect LSP diagnostics
 * and attach them to the result so the AI can self-correct.
 */
async function lspDiagnosticsGuard(ctx) {
  if (!ctx.result?.success) return { action: 'allow' };
  const fp = ctx.params?.file_path || ctx.params?.path || ctx.params?.filePath;
  if (!fp) return { action: 'allow' };

  try {
    let lspClient;
    try { lspClient = require('./lspClient'); } catch { return { action: 'allow' }; }
    if (!lspClient || typeof lspClient.getDiagnostics !== 'function') return { action: 'allow' };
    if (typeof lspClient.isInitialized === 'function' && !lspClient.isInitialized()) return { action: 'allow' };

    const abs = _resolveFilePath(fp);
    if (!abs) return { action: 'allow' };

    // Notify LSP server of file change
    if (typeof lspClient.didSave === 'function') {
      await lspClient.didSave(abs);
    } else if (typeof lspClient.didChange === 'function') {
      await lspClient.didChange(abs);
    }

    // Wait briefly for diagnostics push from LSP server
    await new Promise(r => setTimeout(r, LSP_DIAG_WAIT_MS));

    const diags = lspClient.getDiagnostics(abs) || [];
    if (diags.length === 0) return { action: 'allow' };

    const formatted = diags.map(d => {
      const line = (d.range?.start?.line || 0) + 1;
      const sev = d.severity === 1 ? 'Error' : d.severity === 2 ? 'Warning' : 'Info';
      const code = d.code ? ` (${d.code})` : '';
      return `  Line ${line}: [${sev}] ${d.message}${code}`;
    }).join('\n');

    return {
      action: 'modify',
      result: {
        ...ctx.result,
        _lspDiagnostics: `<diagnostics file="${fp}">\n${formatted}\n</diagnostics>`,
      },
    };
  } catch { return { action: 'allow' }; }
}

/**
 * Register all built-in ToolGuard hooks with the hook system.
 * @param {Object} hookSystem - The hook system facade (hookSystem.js)
 * @returns {number} Number of guards registered
 */
function registerBuiltinGuards(hookSystem) {
  if (process.env.KHY_TOOL_GUARDS === 'false') return 0;
  if (!hookSystem || typeof hookSystem.registerFunction !== 'function') return 0;

  let count = 0;

  hookSystem.registerFunction('PostToolUse', outputSizeGuard, {
    source: 'builtin:OutputSizeGuard',
    priority: 10,
  });
  count++;

  hookSystem.registerFunction('PreToolUse', editBoundaryGuard, {
    source: 'builtin:EditBoundaryGuard',
    priority: 10,
    pattern: 'editFile|edit_file|edit|write_file|writeFile',
  });
  count++;

  hookSystem.registerFunction('PreToolUse', shellTimeoutGuard, {
    source: 'builtin:ShellTimeoutGuard',
    priority: 10,
    pattern: 'shell_command|shellCommand|bash',
  });
  count++;

  hookSystem.registerFunction('PreToolUse', rateLimitGuard, {
    source: 'builtin:RateLimitGuard',
    priority: 5,
  });
  count++;

  hookSystem.registerFunction('PreToolUse', pathTraversalGuard, {
    source: 'builtin:PathTraversalGuard',
    priority: 5,
    pattern: 'editFile|edit_file|edit|write_file|writeFile|read_file|readFile',
  });
  count++;

  hookSystem.registerFunction('PreToolUse', readBoundaryGuard, {
    source: 'builtin:ReadBoundaryGuard',
    priority: 9,
    pattern: 'read_file|readFile',
  });
  count++;

  hookSystem.registerFunction('PostToolUse', errorRecoveryGuard, {
    source: 'builtin:ErrorRecoveryGuard',
    priority: 15,
  });
  count++;

  // ── G5: Prior-read + TOCTOU guards ─────────────────────────────

  hookSystem.registerFunction('PreToolUse', priorReadGuard, {
    source: 'builtin:PriorReadGuard',
    priority: 8,
    pattern: 'editFile|edit_file|edit|write_file|writeFile|apply_patch',
  });
  count++;

  hookSystem.registerFunction('PreToolUse', fileStaleGuard, {
    source: 'builtin:FileStaleGuard',
    priority: 8,
    pattern: 'editFile|edit_file|edit|write_file|writeFile|apply_patch',
  });
  count++;

  // ── G1: LSP post-edit diagnostics injection ────────────────────

  hookSystem.registerFunction('PostToolUse', lspDiagnosticsGuard, {
    source: 'builtin:LspDiagnosticsGuard',
    priority: 12,
    pattern: 'editFile|edit_file|edit|write_file|writeFile|apply_patch',
  });
  count++;

  // ── DESIGN-ARCH-054: project hygiene (no god files / no duplicate modules) ──

  hookSystem.registerFunction('PreToolUse', projectHygieneGuard, {
    source: 'builtin:ProjectHygieneGuard',
    priority: 7,
    // single write + batch project scaffolding (the agent's project-generation
    // path) — both must be checked or "no god component" is bypassable.
    pattern: 'write_file|writeFile|scaffoldFiles|scaffold_files|create_project_structure|project_scaffold|batch_create_files',
  });
  count++;

  return count;
}

// ── ToolCallGuardrail (PreToolUse) — 借鉴 Hermes Agent tool_guardrails.py ──

/**
 * 幂等工具集合（读操作，可安全重复调用）
 */
const IDEMPOTENT_TOOLS = new Set([
  'read_file', 'readFile', 'glob', 'grep', 'git_status', 'gitStatus',
  'list_files', 'listFiles', 'search', 'web_search', 'webSearch',
  'lsp_diagnostics', 'lspDiagnostics', 'get_config', 'getConfig',
]);

/**
 * 变更工具集合（写操作，重复调用可能造成副作用）
 */
const MUTATING_TOOLS = new Set([
  'write_file', 'writeFile', 'edit_file', 'editFile', 'edit',
  'shell_command', 'shellCommand', 'bash', 'apply_patch', 'applyPatch',
  'delete_file', 'deleteFile',
]);

/**
 * 幂等工具允许同参数重复调用的最大次数
 */
const IDEMPOTENT_MAX_REPEATS = 5;

/**
 * 变更工具同参数+同结果允许的最大次数（第 N+1 次为 critical）
 */
const MUTATING_MAX_REPEATS = 1;

/**
 * ToolCallGuardrail 状态存储。
 * Key: `${toolName}::${paramsHash}`, Value: { count, lastResultHash, level, ts }
 *
 * 有界 LRU + TTL（[MGMT-RPT-020] REQ-2026-003）：键为 `${tool}::${hash(params)}`，
 * 每个不同参数的调用产生新键。无界增长会在长会话/长自主任务中导致内存泄漏。
 * 这里以「插入序即近度」的 Map 做 LRU，配合 TTL 清扫，把上限固定下来。
 */
const _guardrailState = new Map();

// 上限与存活时长（env 可调）。默认 2000 条 / 30 分钟，足够覆盖单轮工具循环去重，
// 又不会随会话时长单调累积。
const GUARDRAIL_MAX_ENTRIES = envInt('KHY_GUARDRAIL_MAX_ENTRIES', 2000, { min: 16 });
const GUARDRAIL_TTL_MS = envInt('KHY_GUARDRAIL_TTL_MS', 30 * 60 * 1000, { min: 1000 });

/**
 * TTL 清扫 + 容量淘汰。Map 保持插入顺序 → 队首即最久未触达（LRU）。
 * 在 Map 上 for..of 期间 delete 当前键是安全的。
 */
function _evictGuardrailState() {
  const now = Date.now();
  for (const [key, st] of _guardrailState) {
    if (now - (st.ts || 0) > GUARDRAIL_TTL_MS) _guardrailState.delete(key);
  }
  while (_guardrailState.size > GUARDRAIL_MAX_ENTRIES) {
    const oldest = _guardrailState.keys().next().value;
    if (oldest === undefined) break;
    _guardrailState.delete(oldest);
  }
}

/**
 * 写入/刷新一条 guardrail 状态：盖时间戳并把键移到队尾（提升 LRU 近度），随后淘汰越界项。
 */
function _recordGuardrailState(fingerprint, state) {
  state.ts = Date.now();
  if (_guardrailState.has(fingerprint)) _guardrailState.delete(fingerprint);
  _guardrailState.set(fingerprint, state);
  _evictGuardrailState();
}

/**
 * 简单 hash 函数（非加密用途，用于参数/结果去重）
 */
function _simpleHash(str) {
  let h = 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

/**
 * 生成工具调用的参数指纹
 */
function _toolCallFingerprint(toolName, params) {
  const normalized = toolName.toLowerCase().replace(/_/g, '');
  const paramsStr = JSON.stringify(params || {});
  return `${normalized}::${_simpleHash(paramsStr)}`;
}

/**
 * ToolCallGuardrail — 精细化工具循环防护。
 *
 * 借鉴 Hermes Agent 的 ToolCallGuardrail，区分 idempotent（读）和 mutating（写）操作：
 * - idempotent 工具：同参数允许重复≤5次，超出 warning
 * - mutating 工具：同参数+同结果第2次即 critical（阻止执行）
 *
 * 返回值:
 *   { level: 'allow'|'warning'|'critical', reason?: string, injectedHint?: string }
 *
 * @param {string} toolName - 工具名称
 * @param {object} params - 工具参数
 * @param {string} [resultHash] - 上次执行结果的 hash（用于 mutating 工具检测）
 * @returns {{ level: string, reason?: string, injectedHint?: string }}
 */
function toolCallGuardrail(toolName, params, resultHash = null) {
  const fingerprint = _toolCallFingerprint(toolName, params);
  const state = _guardrailState.get(fingerprint) || { count: 0, lastResultHash: null, level: 'allow' };
  state.count += 1;
  _recordGuardrailState(fingerprint, state);

  const isIdempotent = IDEMPOTENT_TOOLS.has(toolName);
  const isMutating = MUTATING_TOOLS.has(toolName);

  if (isIdempotent) {
    if (state.count > IDEMPOTENT_MAX_REPEATS) {
      return {
        level: 'warning',
        reason: `Idempotent tool '${toolName}' called ${state.count} times with same params (max ${IDEMPOTENT_MAX_REPEATS})`,
        injectedHint: `You have called ${toolName} with the same parameters ${state.count} times. The result is unlikely to change. Consider a different approach.`,
      };
    }
    return { level: 'allow' };
  }

  if (isMutating) {
    // 如果提供了结果 hash 且与上次相同 → 说明操作无效果
    if (resultHash && state.lastResultHash === resultHash && state.count > MUTATING_MAX_REPEATS) {
      return {
        level: 'critical',
        reason: `Mutating tool '${toolName}' produced identical result ${state.count} times — blocking to prevent loop`,
        injectedHint: `BLOCKED: ${toolName} was called ${state.count} times with same params and identical results. This is a loop. Change your approach.`,
      };
    }
    if (state.count > MUTATING_MAX_REPEATS + 2) {
      // 即使没有 resultHash，超过 3 次也发出 warning
      return {
        level: 'warning',
        reason: `Mutating tool '${toolName}' called ${state.count} times with same params`,
        injectedHint: `Warning: ${toolName} has been called ${state.count} times with the same parameters. Verify this is intentional.`,
      };
    }
    state.lastResultHash = resultHash;
    return { level: 'allow' };
  }

  // 未知分类的工具：宽松检测，超 8 次 warning
  if (state.count > 8) {
    return {
      level: 'warning',
      reason: `Tool '${toolName}' called ${state.count} times with same params`,
      injectedHint: `Tool ${toolName} has been called ${state.count} times with identical parameters. Consider changing approach.`,
    };
  }
  return { level: 'allow' };
}

/**
 * 记录工具执行结果的 hash（PostToolUse 阶段调用）
 */
function toolCallGuardrailRecordResult(toolName, params, result) {
  const fingerprint = _toolCallFingerprint(toolName, params);
  const state = _guardrailState.get(fingerprint);
  if (!state) return;
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result || '');
  state.lastResultHash = _simpleHash(resultStr);
}

/**
 * 重置 guardrail 状态（新会话/新轮次时调用）
 */
function resetGuardrailState() {
  _guardrailState.clear();
}

/**
 * Localized guardrail message helper.
 * Falls back to English template if i18n module is unavailable.
 */
function _guardMsg(key, toolName, count) {
  try {
    const { t } = require('../constants/promptLocales');
    return t(key, 'en', { tool: toolName, count });
  } catch {
    // Hardcoded English fallback
    const fallbacks = {
      'guard.exact_fail_block': `${toolName} failed ${count} times with same arguments — try different arguments or a different tool`,
      'guard.exact_fail_warn': `${toolName} failed ${count} times with same arguments — consider changing arguments`,
      'guard.tool_fail_halt': `${toolName} failed ${count} times total — terminating loop`,
      'guard.tool_fail_warn': `${toolName} failed ${count} times — consider a different tool`,
      'guard.no_progress_block': `${toolName} returned identical results ${count} times — no progress`,
      'guard.no_progress_warn': `${toolName} returned identical results ${count} times`,
    };
    return fallbacks[key] || `${toolName}: guard triggered (${key})`;
  }
}

/**
 * ToolCallGuardrailV2 — 三策略循环守卫。
 *
 * 来源: Hermes Agent ToolCallGuardrailController 设计，适配 KHY 架构。
 *
 * 三策略:
 * 1. exact_failure:  (tool+args_hash) 相同且失败 → warn@2, block@5
 * 2. same_tool_failure: 同工具名反复失败 → warn@3, halt@8
 * 3. no_progress: 只读工具结果 hash 不变 → warn@2, block@5
 *
 * 决策分级: allow → warn(注入指导) → block(返回合成错误) → halt(终止循环)
 */
class ToolCallGuardrailV2 {
  /**
   * @param {object} opts - Global thresholds
   * @param {number} [opts.exactWarn=2]
   * @param {number} [opts.exactBlock=5]
   * @param {number} [opts.toolWarn=3]
   * @param {number} [opts.toolHalt=8]
   * @param {number} [opts.noProgressWarn=2]
   * @param {number} [opts.noProgressBlock=5]
   * @param {object} [opts.toolThresholds] - Per-tool threshold overrides
   *   e.g. { 'edit_file': { exactWarn: 1, exactBlock: 3 }, 'bash': { toolHalt: 5 } }
   *   Keys are tool names; values are partial threshold objects merged over global defaults.
   */
  constructor(opts = {}) {
    this._exactFailures = new Map();   // argsHash → count
    this._toolFailures = new Map();    // toolName → count
    this._noProgress = new Map();      // argsHash → { count, hash }
    this._globalThresholds = {
      exactWarn: opts.exactWarn || 2,
      exactBlock: opts.exactBlock || 5,
      toolWarn: opts.toolWarn || 3,
      toolHalt: opts.toolHalt || 8,
      noProgressWarn: opts.noProgressWarn || 2,
      noProgressBlock: opts.noProgressBlock || 5,
    };
    // Per-tool threshold overrides: toolName → partial threshold object
    this._toolThresholds = new Map();
    if (opts.toolThresholds && typeof opts.toolThresholds === 'object') {
      for (const [tool, overrides] of Object.entries(opts.toolThresholds)) {
        if (overrides && typeof overrides === 'object') {
          this._toolThresholds.set(tool, overrides);
        }
      }
    }
    // Backward-compat alias
    this._thresholds = this._globalThresholds;
  }

  /**
   * Resolve effective thresholds for a specific tool.
   * Per-tool overrides are merged over global defaults.
   * @param {string} toolName
   * @returns {object} Merged thresholds
   */
  _resolveThresholds(toolName) {
    const override = this._toolThresholds.get(toolName);
    if (!override) return this._globalThresholds;
    return { ...this._globalThresholds, ...override };
  }

  reset() {
    this._exactFailures.clear();
    this._toolFailures.clear();
    this._noProgress.clear();
  }

  /**
   * Pre-execution check. Returns { decision, strategy, reason }.
   * decision: 'allow' | 'warn' | 'block' | 'halt'
   */
  check(toolName, params) {
    const key = _toolCallFingerprint(toolName, params);
    const t = this._resolveThresholds(toolName);

    // Strategy 1: exact_failure
    const ef = this._exactFailures.get(key) || 0;
    if (ef >= t.exactBlock) {
      return { decision: 'block', strategy: 'exact_failure',
        reason: _guardMsg('guard.exact_fail_block', toolName, ef) };
    }
    if (ef >= t.exactWarn) {
      return { decision: 'warn', strategy: 'exact_failure',
        reason: _guardMsg('guard.exact_fail_warn', toolName, ef) };
    }

    // Strategy 2: same_tool_failure
    const tf = this._toolFailures.get(toolName) || 0;
    if (tf >= t.toolHalt) {
      return { decision: 'halt', strategy: 'same_tool_failure',
        reason: _guardMsg('guard.tool_fail_halt', toolName, tf) };
    }
    if (tf >= t.toolWarn) {
      return { decision: 'warn', strategy: 'same_tool_failure',
        reason: _guardMsg('guard.tool_fail_warn', toolName, tf) };
    }

    // Strategy 3: no_progress
    const np = this._noProgress.get(key);
    if (np) {
      if (np.count >= t.noProgressBlock) {
        return { decision: 'block', strategy: 'no_progress',
          reason: _guardMsg('guard.no_progress_block', toolName, np.count) };
      }
      if (np.count >= t.noProgressWarn) {
        return { decision: 'warn', strategy: 'no_progress',
          reason: _guardMsg('guard.no_progress_warn', toolName, np.count) };
      }
    }

    return { decision: 'allow', strategy: null, reason: null };
  }

  /**
   * Post-execution result recording.
   * @param {string} toolName
   * @param {object} params
   * @param {boolean} success
   * @param {string} [resultHash] - hash of the tool output for no_progress detection
   */
  recordResult(toolName, params, success, resultHash) {
    const key = _toolCallFingerprint(toolName, params);

    if (!success) {
      this._exactFailures.set(key, (this._exactFailures.get(key) || 0) + 1);
      this._toolFailures.set(toolName, (this._toolFailures.get(toolName) || 0) + 1);
    } else if (resultHash) {
      const np = this._noProgress.get(key) || { count: 0, hash: null };
      if (np.hash === resultHash) {
        np.count++;
      } else {
        np.count = 1;
        np.hash = resultHash;
      }
      this._noProgress.set(key, np);
    }
  }
}

module.exports = {
  outputSizeGuard,
  editBoundaryGuard,
  readBoundaryGuard,
  shellTimeoutGuard,
  rateLimitGuard,
  pathTraversalGuard,
  errorRecoveryGuard,
  priorReadGuard,
  fileStaleGuard,
  lspDiagnosticsGuard,
  projectHygieneGuard,
  registerBuiltinGuards,
  toolCallGuardrail,
  toolCallGuardrailRecordResult,
  resetGuardrailState,
  IDEMPOTENT_TOOLS,
  MUTATING_TOOLS,
  MAX_OUTPUT_BYTES,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
  GUARDRAIL_MAX_ENTRIES,
  GUARDRAIL_TTL_MS,
  _toolCallCounts,
  _guardrailState,
  ToolCallGuardrailV2,
};
