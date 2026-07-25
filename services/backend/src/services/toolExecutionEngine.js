'use strict';

/**
 * ToolExecutionEngine — unified tool execution pipeline with
 * parallel/serial auto-classification.
 *
 * Extracts the per-tool execution pipeline from toolUseLoop.js
 * (lines 1860-2600) into a reusable class. Learned from Claude Code's
 * StreamingToolExecutor pattern.
 *
 * Pipeline stages per tool call:
 *   1. PreToolUse hook
 *   2. Loop detection
 *   3. Dedup (with read-after-write exemption)
 *   4. Intent dedup (shell/path)
 *   5. Platform command rewrite
 *   6. Shell safety check
 *   7. Execute via toolCalling.executeTool
 *   8. Recovery (app launch, web search)
 *   9. Platform error hint
 *  10. Diagnostics + trace audit
 *  11. Dedup key registration
 *  12. File content hash caching
 *  13. PostToolUse hook
 *
 * Phase 4A of industrial-grade modularization.
 * Feature-gated: KHY_USE_EXEC_ENGINE=true to activate.
 */

const path = require('path');
const fs = require('fs');
const { analyzeCommand } = require('./shellSafetyValidator');
const { diagnostics, generateTraceId: genDiagTraceId } = require('./diagnosticEvents');

// ── Constants ──────────────────────────────────────────────────────

const MAX_PARALLEL_TOOLS = 8;

const KNOWN_CONCURRENCY_SAFE = new Set([
  'read_file', 'readFile', 'Read', 'readfile',
  'grep', 'Grep', 'rg',
  'glob', 'Glob', 'find', 'find_files',
  'search', 'web_search', 'webSearch', 'WebSearch', 'websearch',
  'quote', 'data_fetch',
  'git_status', 'git_diff', 'git_log',
  'LS', 'ls',
]);

const WRITE_PATH_TOOLS = new Set([
  'edit_file', 'editFile', 'write_file', 'writeFile', 'Edit', 'Write',
  'FileEdit', 'FileWrite', 'file_edit', 'file_write',
]);

const READ_ONLY_TOOLS = new Set([
  'read_file', 'readfile', 'readFile', 'read',
  'grep', 'rg', 'search', 'glob', 'find', 'ls', 'LS',
  'quote', 'data_fetch', 'web_search', 'webSearch', 'websearch',
  'git_status', 'git_diff', 'git_log',
]);

const SHELL_TOOL_NAMES = new Set([
  'shell_command', 'shellCommand', 'bash', 'execute_command',
]);

// ── Concurrency-safety resolution (s02) ─────────────────────────────
// Generate name variants (snake_case / camelCase / lowercase) so a call
// named 'shell_command' resolves to the registered tool 'shellCommand'.
// Shared with toolCalling via the neutral utils/toolNameVariants leaf — both
// services depend on utils, not on each other (no reverse dependency).
const _toolNameVariants = require('../utils/toolNameVariants');

/**
 * Resolve whether a tool call is concurrency-safe.
 *
 * Resolution order (s02 fix for bash alias mismatch):
 *   1. Variant-expand call.name and look up the registry. If a tool is found
 *      with isConcurrencySafe(params), use its per-input verdict. This recovers
 *      shellCommand's content-aware check (bash "ls" → safe, bash "rm" → unsafe)
 *      that a bare registry.get('shell_command') would miss.
 *   2. Fall back to the static KNOWN_CONCURRENCY_SAFE set (no shell aliases →
 *      bash defaults to serial when the registry is unavailable: safety-first).
 *
 * @param {{name:string, params?:object, legacy?:boolean}} call
 * @param {object|null} toolRegistry - require('../tools') or null
 * @returns {boolean}
 */
function resolveConcurrencySafe(call, toolRegistry) {
  if (!call || call.legacy) return false;
  if (toolRegistry && typeof toolRegistry.get === 'function') {
    for (const variant of _toolNameVariants(call.name)) {
      const regTool = toolRegistry.get(variant);
      if (regTool) {
        if (typeof regTool.isConcurrencySafe === 'function') {
          try { return !!regTool.isConcurrencySafe(call.params); }
          catch { return false; }
        }
        if (typeof regTool.isConcurrencySafe === 'boolean') {
          return regTool.isConcurrencySafe;
        }
        break; // tool found but no concurrency hint → fall through to static set
      }
    }
  }
  return KNOWN_CONCURRENCY_SAFE.has(call.name);
}

/**
 * Partition tool calls into order-preserving batches (s02 / CC partitionToolCalls).
 *
 * Contiguous concurrency-safe calls are grouped into one parallel batch;
 * a non-safe call breaks the run and forms its own serial batch. Batch order
 * follows the original call order, so a serial call always executes between the
 * safe calls that precede and follow it (e.g. [readA, readB, rm, readC] →
 * [parallel(A,B), serial(rm), parallel(C)] — rm runs before readC).
 *
 * Within a parallel batch, two writes to the SAME resolved path are split: the
 * first stays in the batch, the duplicate is demoted to its own serial batch so
 * same-file writes never race.
 *
 * @param {Array} toolCalls
 * @param {object|null} toolRegistry
 * @param {string} [cwd]
 * @returns {Array<{parallel:boolean, calls:Array}>}
 */
function partitionIntoBatches(toolCalls, toolRegistry, cwd) {
  const batches = [];
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return batches;
  const baseDir = cwd || process.env.KHYQUANT_CWD || process.cwd();

  let current = null; // open parallel batch
  const writePaths = new Set(); // resolved write paths in the current parallel batch

  const flush = () => {
    if (current && current.calls.length > 0) batches.push(current);
    current = null;
    writePaths.clear();
  };

  for (const call of toolCalls) {
    const safe = resolveConcurrencySafe(call, toolRegistry);
    if (!safe) {
      flush();
      batches.push({ parallel: false, calls: [call] });
      continue;
    }

    // Concurrency-safe. Guard against same-path write collisions within a batch.
    if (WRITE_PATH_TOOLS.has(call.name)) {
      const target = call.params?.file_path || call.params?.path || '';
      if (target) {
        const resolved = path.resolve(baseDir, target);
        if (writePaths.has(resolved)) {
          // Duplicate target in this batch → serialize this write on its own.
          flush();
          batches.push({ parallel: false, calls: [call] });
          continue;
        }
        writePaths.add(resolved);
      }
    }

    if (!current) current = { parallel: true, calls: [] };
    current.calls.push(call);
  }
  flush();
  return batches;
}

// ── File content hash ──────────────────────────────────────────────

function _fileContentHash(filePath) {
  try {
    const crypto = require('crypto');
    const buf = Buffer.alloc(10240);
    const fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, 10240, 0);
    fs.closeSync(fd);
    return crypto.createHash('md5').update(buf.slice(0, bytesRead)).digest('hex');
  } catch { return null; }
}

// ── Result hash ────────────────────────────────────────────────────

function _hashResult(result) {
  const str = typeof result === 'string' ? result : JSON.stringify(result || '');
  const s = str.slice(0, 4096);
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  return hash.toString(36);
}

// ── Engine Class ───────────────────────────────────────────────────

class ToolExecutionEngine {
  /**
   * @param {object} deps - Injected dependencies
   * @param {object} [deps.hookSystem] - Hook system instance
   * @param {object} [deps.loopDetector] - Loop detector instance
   * @param {object} [deps.traceAudit] - Trace audit service
   * @param {object} [deps.execApproval] - Exec approval service
   * @param {Map}    [deps.executedCallKeys] - Dedup tracking map
   * @param {Map}    [deps.fileReadHashes] - File hash tracking map
   * @param {string} [deps.traceSessionId] - Session ID for tracing
   * @param {string} [deps.diagTraceId] - Diagnostic trace ID
   * @param {string} [deps.requestId] - Request ID
   * @param {string} [deps.userMessage] - User message for recovery context
   * @param {function} [deps.onToolCall] - Callback when tool call starts
   * @param {function} [deps.onToolResult] - Callback when tool result arrives
   */
  constructor(deps = {}) {
    this._hookSystem = deps.hookSystem || null;
    this._loopDetector = deps.loopDetector || null;
    this._traceAudit = deps.traceAudit || null;
    this._execApproval = deps.execApproval || null;
    this._executedCallKeys = deps.executedCallKeys || new Map();
    this._fileReadHashes = deps.fileReadHashes || new Map();
    this._traceSessionId = deps.traceSessionId || '';
    this._diagTraceId = deps.diagTraceId || '';
    this._requestId = deps.requestId || '';
    this._userMessage = deps.userMessage || '';
    this._onToolCall = deps.onToolCall || null;
    this._onToolResult = deps.onToolResult || null;
    this._onControlRequest = deps.onControlRequest || null;
    this._iteration = deps.iteration || 0;
    this._streamingExecutor = deps.streamingExecutor || null; // Phase 7
    this._hookStopRequested = false; // s04: PostToolUse 请求优雅停机
    this._hookStopReason = '';
  }

  /**
   * Execute a single tool call through the full pipeline.
   * @param {object} call - { name, params, _toolUseId, ... }
   * @param {object} [context] - Additional execution context
   * @returns {Promise<{ tool, params, result, elapsed, _loopWarning?, _toolUseId? }>}
   */
  async executeOne(call, context = {}) {
    if (this._onToolCall) {
      const callCtx = this._onToolCall(call.name, call.params, this._iteration);
      if (callCtx && typeof callCtx === 'object') {
        call._traceContext = { ...(call._traceContext || {}), ...callCtx };
      }
    }

    // Stage 1: PreToolUse hook
    const hookResult = await this._runPreToolUseHook(call);
    if (hookResult) return hookResult;

    // Stage 2: Loop detection
    const loopResult = this._checkLoopDetection(call);
    if (loopResult) return loopResult;

    // Stage 3: Dedup check
    const dedupResult = this._checkDedup(call);
    if (dedupResult) return dedupResult;

    // Stage 4: Intent dedup
    const intentResult = this._checkIntentDedup(call);
    if (intentResult) return intentResult;

    // Record call in loop detector
    if (this._loopDetector) this._loopDetector.recordCall(call.name, call.params);

    // Stage 5: Platform rewrite
    this._rewritePlatformCommand(call);

    // Stage 6: Shell safety
    const safetyResult = await this._checkShellSafety(call);
    if (safetyResult) return safetyResult;

    // Phase 7: Check streaming executor cache (tool may have been pre-executed)
    if (this._streamingExecutor) {
      const cached = this._streamingExecutor.getResultByHash(call.name, call.params);
      if (cached) {
        const elapsed = cached.elapsed || 0;
        const result = cached.output || cached;
        if (this._onToolResult) this._onToolResult(call.name, call.params, result, this._iteration, elapsed);
        return {
          tool: call.name, params: call.params, result, elapsed,
          _toolUseId: call._toolUseId || null, _preExecuted: true,
        };
      }
    }

    // Stage 7: Execute
    const start = Date.now();
    const diagSpanId = diagnostics.emitToolCall(call.name, call.params, {
      traceId: this._diagTraceId, requestId: this._requestId,
    });

    this._emitTraceEvent('agent.tool.call', {
      toolName: call.name, params: call.params, iteration: this._iteration,
    });

    let result;
    try {
      const toolCalling = require('./toolCalling');
      result = await toolCalling.executeTool(call.name, call.params, {
        sessionId: this._traceSessionId,
        traceId: this._diagTraceId,
        requestId: this._requestId,
        onControlRequest: this._onControlRequest,
        ...(call._traceContext || {}),
      });
    } catch (err) {
      const { ToolError } = require('./toolError');
      const te = ToolError.isToolError(err) ? err : ToolError.fromGenericError(err);
      result = { ...te.toStructuredResult(), _aiContext: te.toAIContext() };
    }

    // Stage 8: Recovery
    result = await this._runRecovery(call, result);

    // Stage 9: Platform error hint
    this._injectPlatformHint(call, result);

    // Stage 10: Diagnostics
    diagnostics.emitToolResult(diagSpanId, result, result?.error || null, {
      traceId: this._diagTraceId, requestId: this._requestId,
    });
    this._emitTraceEvent('agent.tool.result', {
      toolName: call.name, success: !!result?.success, error: result?.error || null,
      iteration: this._iteration,
    });

    // Stage 11: Register dedup key
    this._registerDedupKey(call, result);

    // Stage 12: File hash caching
    this._cacheFileHash(call, result);

    // Record outcome in loop detector
    if (this._loopDetector) this._loopDetector.recordOutcome(call.name, call.params, result);

    const elapsed = Date.now() - start;

    // Stage 13: PostToolUse hook
    result = await this._runPostToolUseHook(call, result, elapsed);

    if (this._onToolResult) this._onToolResult(call.name, call.params, result, this._iteration, elapsed);

    return {
      tool: call.name, params: call.params, result, elapsed,
      _loopWarning: call._loopWarning, _toolUseId: call._toolUseId || null,
    };
  }

  /**
   * Execute a batch of tool calls with auto parallel/serial classification.
   * @param {Array} toolCalls - Array of { name, params, ... }
   * @param {object} [context] - Additional context
   * @returns {Promise<Array>} Array of execution results
   */
  async executeBatch(toolCalls, context = {}) {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];

    let toolRegistry;
    try { toolRegistry = require('../tools'); } catch { toolRegistry = null; }

    // Order-preserving partition (s02): contiguous safe calls → parallel batch,
    // each unsafe call → its own serial batch, batch order = original order.
    const cwd = context.cwd || process.env.KHYQUANT_CWD || process.cwd();
    const batches = partitionIntoBatches(toolCalls, toolRegistry, cwd);
    const results = [];

    for (const batch of batches) {
      if (batch.parallel && batch.calls.length >= 2) {
        const settled = await this._executeParallel(batch.calls, context);
        results.push(...settled);
        // Denied within a parallel batch → stop the whole sequence.
        for (const r of settled) {
          if (r.result?.denied) { r._denied = true; return results; }
        }
      } else {
        // Single call (parallel batch of 1 or a serial batch) → run inline.
        for (const call of batch.calls) {
          const r = await this.executeOne(call, context);
          results.push(r);
          if (r.result?.denied) { r._denied = true; return results; }
        }
      }
    }

    return results;
  }

  // ── Classification ─────────────────────────────────────────────────
  // Retained for backward compatibility / external callers. Delegates to the
  // order-preserving partitioner and flattens batches back into the legacy
  // { parallel, sequential } shape. New code should use partitionIntoBatches.
  _classifyCalls(toolCalls) {
    let toolRegistry;
    try { toolRegistry = require('../tools'); } catch { toolRegistry = null; }
    const batches = partitionIntoBatches(toolCalls, toolRegistry);
    const parallel = [];
    const sequential = [];
    for (const b of batches) {
      if (b.parallel) parallel.push(...b.calls);
      else sequential.push(...b.calls);
    }
    return { parallel, sequential };
  }

  async _executeParallel(calls, context) {
    try {
      const { runWithConcurrency } = require('./concurrencyLimiter');
      const result = await runWithConcurrency({
        tasks: calls.map(call => () => this.executeOne(call, context)),
        limit: MAX_PARALLEL_TOOLS,
        errorMode: 'continue',
      });
      return result.results;
    } catch {
      // Fallback: Promise.allSettled
      const settled = await Promise.allSettled(
        calls.map(call => this.executeOne(call, context))
      );
      return settled.map(s => s.status === 'fulfilled'
        ? s.value
        : { tool: 'unknown', params: {}, result: { success: false, error: s.reason?.message || 'Promise rejected' }, elapsed: 0 }
      );
    }
  }

  // ── Pipeline stages ────────────────────────────────────────────────

  async _runPreToolUseHook(call) {
    if (!this._hookSystem) return null;
    try {
      const hr = await this._hookSystem.trigger('PreToolUse', {
        toolName: call.name, params: call.params,
        iteration: this._iteration, _fileReadHashes: this._fileReadHashes,
      });
      if (hr.blocked) {
        // Soft guards (editBoundary / fileStale / priorRead) flag their block as
        // approvable: turn it into a single user-approval prompt instead of a
        // hard dead-end. On approval the params carry EXEC_APPROVED so Stage 7
        // does not prompt again; on denial / no channel the block stands.
        if (hr.approvable && typeof this._onControlRequest === 'function') {
          try {
            const { requestGuardApproval } = require('./guardApproval');
            const verdict = await requestGuardApproval({
              toolName: call.name, params: call.params,
              reason: hr.reason, source: hr.source,
              onControlRequest: this._onControlRequest,
            });
            if (verdict.allowed) {
              call.params = verdict.params;
              return null; // proceed through the rest of the pipeline
            }
          } catch { /* approval failure falls through to the block */ }
        }
        const result = { success: false, error: `[Hook] ${hr.reason || 'Blocked by PreToolUse hook'}` };
        if (this._onToolResult) this._onToolResult(call.name, call.params, result, this._iteration, 0);
        return { tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null };
      }
      if (hr.context?.params) call.params = hr.context.params;
    } catch { /* hook failure should not block */ }
    return null;
  }

  _checkLoopDetection(call) {
    if (!this._loopDetector) return null;
    const detection = this._loopDetector.check(call.name, call.params);
    if (detection.stuck && (detection.level === 'circuit_breaker' || detection.level === 'critical')) {
      const result = {
        success: false,
        error: `[LoopDetector:${detection.detector}] ${detection.message}\n\n[STOP] Do not retry. Answer with available info or explain the limitation.`,
        _loopDetected: true,
      };
      if (this._onToolResult) this._onToolResult(call.name, call.params, result, this._iteration, 0);
      return { tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null };
    }
    if (detection.level === 'warning' && detection.message) {
      call._loopWarning = detection.message;
    }
    return null;
  }

  _checkDedup(call) {
    const isReadOnly = READ_ONLY_TOOLS.has(call.name);
    const dedupKey = JSON.stringify({ t: call.name, p: call.params });
    let prevExec = this._executedCallKeys.get(dedupKey);

    if (prevExec && isReadOnly) {
      const filePath = call.params?.file_path || call.params?.path || call.params?.filePath;
      if (filePath) {
        const currentHash = _fileContentHash(filePath);
        const prevHash = this._fileReadHashes.get(filePath);
        if (currentHash && prevHash && currentHash !== prevHash) {
          this._executedCallKeys.delete(dedupKey);
          prevExec = null;
        }
      }
    }

    if (!prevExec) {
      call._dedupKey = dedupKey;
      return null;
    }

    prevExec.count++;
    if (isReadOnly && prevExec.count <= 3) {
      call._dedupKey = dedupKey;
      return null;
    }

    // Guardrail check
    let guardrailResult = { level: 'allow' };
    try {
      const { toolCallGuardrail } = require('./toolGuards');
      guardrailResult = toolCallGuardrail(call.name, call.params, prevExec.resultHash);
    } catch { /* allow */ }

    if (guardrailResult.level === 'critical') {
      const result = { success: false, error: `[ToolCallGuardrail:critical] ${guardrailResult.reason}`, _loopDetected: true, _deduped: true };
      if (this._onToolResult) this._onToolResult(call.name, call.params, result, this._iteration, 0);
      return { tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null };
    }

    const result = { ...prevExec.result, _deduped: true,
      _dedupNote: `This exact call was already executed (attempt #${prevExec.count}). Use the previous result.` };
    if (guardrailResult.level === 'warning' && guardrailResult.injectedHint) {
      result._guardrailWarning = guardrailResult.injectedHint;
    }
    if (this._onToolResult) this._onToolResult(call.name, call.params, result, this._iteration, 0);
    return { tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null };
  }

  _checkIntentDedup(call) {
    try {
      const { extractShellIntent, _isShellTool, extractPathIntent, _isFsTool } = require('./toolLoopDetector');
      let intentKey = null;
      if (_isShellTool(call.name)) {
        const intent = extractShellIntent(call.params?.command || call.params?.cmd);
        if (intent) intentKey = `__intent__:shell:${intent}`;
      } else if (_isFsTool(call.name)) {
        const pathIntent = extractPathIntent(call.name, call.params);
        if (pathIntent) intentKey = `__intent__:fspath:${pathIntent}`;
      }
      if (intentKey) {
        const prev = this._executedCallKeys.get(intentKey);
        if (prev && prev.count >= 2) {
          const result = { ...prev.result, _deduped: true, _loopDetected: true,
            _dedupNote: `Same target "${intentKey}" already attempted ${prev.count} times. Do not retry.` };
          if (this._onToolResult) this._onToolResult(call.name, call.params, result, this._iteration, 0);
          return { tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null };
        }
        if (prev) prev.count++; else this._executedCallKeys.set(intentKey, { result: null, count: 1 });
      }
    } catch { /* best effort */ }
    return null;
  }

  _rewritePlatformCommand(call) {
    if (!SHELL_TOOL_NAMES.has(call.name) || !call.params?.command) return;
    try {
      const { proactivePlatformRewrite } = require('./platformRewrite');
      const rewritten = proactivePlatformRewrite(call.params.command);
      if (rewritten !== call.params.command) {
        call.params = { ...call.params, command: rewritten, _originalCommand: call.params.command };
      }
    } catch { /* ignore */ }
  }

  async _checkShellSafety(call) {
    if (!SHELL_TOOL_NAMES.has(call.name) || !call.params?.command) return null;

    const safety = analyzeCommand(call.params.command);
    if (!safety.safe) {
      const result = { success: false, error: `[ShellSafety] Command blocked (${safety.maxSeverity}): ${safety.risks.filter(r => r.severity === 'critical').map(r => r.detail).join('; ')}` };
      if (this._onToolResult) this._onToolResult(call.name, call.params, result, this._iteration, 0);
      return { tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null };
    }

    if (this._execApproval) {
      const approval = this._execApproval.checkCommand(call.params.command);
      const verdict = await this._resolveExecApproval(call, approval);
      if (verdict === 'deny') {
        const result = { success: false, denied: true, error: `[ExecApproval] ${approval.reason} (risk: ${approval.risk})` };
        if (this._onToolResult) this._onToolResult(call.name, call.params, result, this._iteration, 0);
        return { tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null };
      }
    }
    return null;
  }

  /**
   * Resolve an execApproval verdict, connecting the ask-state to the host
   * approval channel (this._onControlRequest). Returns 'allow' | 'deny'.
   * Mirrors toolUseLoop._resolveExecApproval — see that function for the full
   * contract (escape valves, fail-closed, dedup token).
   */
  async _resolveExecApproval(call, approval) {
    if (approval.allowed === true) return 'allow';
    if (!approval.requestId) return 'deny';

    const requestId = approval.requestId;
    let execApprovalMod = null;
    try { execApprovalMod = require('./execApproval'); } catch { execApprovalMod = null; }
    const mgr = (execApprovalMod && execApprovalMod.execApproval) || this._execApproval || null;
    const EXEC_APPROVED = execApprovalMod && execApprovalMod.EXEC_APPROVED;

    const stampAllow = () => {
      if (mgr) { try { mgr.decide(requestId, 'approved', { decidedBy: 'escape_valve' }); } catch { /* best-effort */ } }
      if (EXEC_APPROVED && call.params && typeof call.params === 'object') call.params[EXEC_APPROVED] = true;
      return 'allow';
    };
    const stampDeny = (by) => {
      if (mgr) { try { mgr.decide(requestId, 'denied', { decidedBy: by || 'fail_closed' }); } catch { /* best-effort */ } }
      return 'deny';
    };

    let yolo = false;
    try { yolo = require('./permissionStore').getProfile() === 'yolo'; } catch { /* optional */ }
    let dangerous = false;
    try { dangerous = require('./toolCalling').isDangerousMode(); } catch { /* optional */ }
    if (process.env.KHY_EXEC_APPROVAL === 'off' || dangerous || yolo) return stampAllow();

    if (typeof this._onControlRequest !== 'function') return stampDeny('no_channel');

    let ctrlResp = null;
    try {
      ctrlResp = await this._onControlRequest({
        requestId: `exec_${requestId}`,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'shell_command',
          input: { command: call.params?.command, risk: approval.risk, reason: approval.reason },
        },
      });
    } catch { ctrlResp = null; }

    // Honor the SAME resolution payloads every host emits via the canonical
    // toolCalling._decisionFromControl — primitives (`true`, `'always'`) AND the
    // {behavior} object shape. The Ink PermissionsPrompt resolves "允许本次" as
    // boolean `true` and "免审/始终允许" as `'always'`; an object-only check
    // mis-read those as deny, so a TUI approval still produced
    // "[ExecApproval] Approval required".
    let allow = false;
    try {
      const d = require('./toolCalling')._decisionFromControl(ctrlResp);
      allow = (d === 'allow' || d === 'allow-always');
    } catch {
      if (ctrlResp === true) {
        allow = true;
      } else if (ctrlResp && typeof ctrlResp === 'object') {
        let node = ctrlResp;
        if (node.type === 'control_response' && node.response) node = node.response;
        const inner = (node.response && typeof node.response === 'object') ? node.response : node;
        allow = (inner.behavior || node.behavior) === 'allow';
      }
    }
    return allow ? stampAllow() : stampDeny('user_denied');
  }

  async _runRecovery(call, result) {
    try {
      const { recoverOpenAppAfterShellFailure, recoverWebSearchAfterShellFailure } = require('./appLaunchRecovery');
      const toolCalling = require('./toolCalling');
      const execCtx = { sessionId: this._traceSessionId, traceId: this._diagTraceId, requestId: this._requestId };
      result = await recoverOpenAppAfterShellFailure(call, result, this._userMessage, toolCalling, execCtx);
      result = await recoverWebSearchAfterShellFailure(call, result, this._userMessage, toolCalling, execCtx);
    } catch { /* recovery failure is non-critical */ }
    return result;
  }

  _injectPlatformHint(call, result) {
    if (!result || result.success) return;
    if (!SHELL_TOOL_NAMES.has(call.name)) return;
    try {
      const { getWindowsCommandHint, getLinuxCommandHint } = require('./platformRewrite');
      const cmd = String(call.params?.command || '');
      if (process.platform === 'win32') {
        const hint = getWindowsCommandHint(cmd);
        if (hint) result.error = (result.error || '') + '\n[Windows Hint] ' + hint;
      } else {
        const hint = getLinuxCommandHint(cmd);
        if (hint) result.error = (result.error || '') + '\n[Linux Hint] ' + hint;
      }
    } catch { /* ignore */ }
  }

  _registerDedupKey(call, result) {
    const dedupKey = call._dedupKey || JSON.stringify({ t: call.name, p: call.params });
    this._executedCallKeys.set(dedupKey, { result, count: 1, resultHash: _hashResult(result) });

    // Update intent key
    try {
      const { extractShellIntent, _isShellTool, extractPathIntent, _isFsTool } = require('./toolLoopDetector');
      let intentKey = null;
      if (_isShellTool(call.name)) {
        const si = extractShellIntent(call.params?.command || call.params?.cmd);
        if (si) intentKey = `__intent__:shell:${si}`;
      } else if (_isFsTool(call.name)) {
        const pi = extractPathIntent(call.name, call.params);
        if (pi) intentKey = `__intent__:fspath:${pi}`;
      }
      if (intentKey) {
        const prev = this._executedCallKeys.get(intentKey);
        if (prev) prev.result = result; else this._executedCallKeys.set(intentKey, { result, count: 1 });
      }
    } catch { /* best effort */ }

    // Guardrail record
    try {
      const { toolCallGuardrailRecordResult } = require('./toolGuards');
      const str = typeof result === 'string' ? result : JSON.stringify(result || '');
      toolCallGuardrailRecordResult(call.name, call.params, str.slice(0, 4096));
    } catch { /* ignore */ }
  }

  _cacheFileHash(call, result) {
    if (!/^(read_file|readFile)$/i.test(call.name) || !result?.success) return;
    const fp = call.params?.path || call.params?.file_path;
    if (!fp) return;
    try {
      let abs = path.resolve(process.env.KHYQUANT_CWD || process.cwd(), fp);
      // Use the shared platform-aware normalizer so the key matches the
      // prior-read / stale guards on Windows (drive-case & slash parity).
      try { abs = require('../tools/_readTracker').normalizePath(abs); } catch { /* fallback to resolved */ }
      const hash = _fileContentHash(abs);
      if (hash) {
        try {
          const st = fs.statSync(abs);
          this._fileReadHashes.set(abs, { hash, mtime: st.mtimeMs, size: st.size });
        } catch {
          this._fileReadHashes.set(abs, { hash, mtime: null, size: null });
        }
      }
    } catch { /* best effort */ }
  }

  async _runPostToolUseHook(call, result, elapsed) {
    if (!this._hookSystem) return result;
    try {
      const postHr = await this._hookSystem.trigger('PostToolUse', {
        toolName: call.name, params: call.params, result, elapsed,
        _fileReadHashes: this._fileReadHashes,
      });
      // s04: PostToolUse 优雅停机 — 置实例标志，由引擎循环边界检查并干净收尾。
      if (postHr.context?.preventContinuation) {
        this._hookStopRequested = true;
        this._hookStopReason = postHr.context.stopReason || postHr.reason || '';
      }
      if (postHr.context?.result) return postHr.context.result;
    } catch { /* non-critical */ }
    return result;
  }

  _emitTraceEvent(eventName, payload) {
    if (!this._traceAudit) return;
    try {
      this._traceAudit.logEvent(eventName, {
        requestId: this._requestId, ...payload,
      }, {
        sessionId: this._traceSessionId,
        traceId: this._diagTraceId,
        requestId: this._requestId,
        source: 'tool-loop',
        visibility: 'summary',
      });
    } catch { /* non-critical */ }
  }
}

/**
 * Check if the execution engine should be used (feature gate).
 * @returns {boolean}
 */
function isEngineEnabled() {
  return process.env.KHY_USE_EXEC_ENGINE === 'true';
}

module.exports = {
  ToolExecutionEngine,
  isEngineEnabled,
  MAX_PARALLEL_TOOLS,
  KNOWN_CONCURRENCY_SAFE,
  resolveConcurrencySafe,
  partitionIntoBatches,
};
