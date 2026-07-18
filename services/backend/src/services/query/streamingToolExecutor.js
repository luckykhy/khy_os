/**
 * Streaming Tool Executor — begin tool execution during API streaming.
 *
 * Instead of waiting for the full AI response, tool calls are submitted
 * for execution as soon as they are parsed from the streaming output.
 * Concurrency-safe tools run in parallel; others are queued for serial
 * execution after the stream completes.
 *
 * This mirrors Claude Code's architecture where tool parsing happens
 * incrementally and execution overlaps with continued streaming.
 */

const MAX_PARALLEL = 5;

/**
 * @typedef {object} ToolCall
 * @property {string} name - Tool name
 * @property {object} params - Tool parameters
 * @property {string} [id] - Optional call identifier
 */

/**
 * @typedef {object} ToolResult
 * @property {string} name - Tool name
 * @property {string} id - Call identifier
 * @property {'success'|'error'|'denied'} status
 * @property {*} output - Execution result or error message
 * @property {number} elapsed - Execution time in ms
 */

class StreamingToolExecutor {
  /**
   * @param {object} deps
   * @param {Function} deps.executeTools - Tool execution function (from toolCalling)
   * @param {Function} [deps.isConcurrencySafe] - Check if a tool is safe for parallel exec
   * @param {Function} [deps.uuid] - ID generator
   * @param {boolean} [deps.siblingAbortOnBashError=true] - Abort sibling tools on bash error
   */
  constructor(deps = {}) {
    this._executeTools = deps.executeTools;
    this._isConcurrencySafe = deps.isConcurrencySafe || (() => false);
    this._uuid = deps.uuid || (() => `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    this._siblingAbortOnBashError = deps.siblingAbortOnBashError !== false;

    /** @type {Map<string, Promise<ToolResult>>} */
    this._inflight = new Map();

    /** @type {ToolResult[]} */
    this._completed = [];

    /** @type {ToolCall[]} */
    this._serialQueue = [];

    this._parallelCount = 0;
    this._aborted = false;

    /** @type {Map<string, AbortController>} - Per-tool abort controllers for sibling abort */
    this._toolAbortControllers = new Map();

    /**
     * 结果缓存（借鉴 Claude Code StreamingToolExecutor 的 hash 去重）
     * Key: `${toolName}::hash(params)`, Value: ToolResult
     * 流式预执行后，toolUseLoop 正式执行时可直接取缓存结果
     */
    this._resultCache = new Map();
  }

  /**
   * Submit a tool call for execution.
   *
   * Concurrency-safe tools start immediately (up to MAX_PARALLEL).
   * Others are queued for serial execution via `drainSerialQueue()`.
   *
   * @param {ToolCall} call
   * @returns {string} Call ID
   */
  addTool(call) {
    if (this._aborted) return null;

    const id = call.id || this._uuid();
    const enriched = { ...call, id };

    if (this._isConcurrencySafe(call.name) && this._parallelCount < MAX_PARALLEL) {
      this._startParallel(enriched);
    } else {
      this._serialQueue.push(enriched);
    }

    return id;
  }

  /**
   * Start a tool execution in parallel (fire-and-forget into inflight map).
   * @param {ToolCall & { id: string }} call
   * @private
   */
  _startParallel(call) {
    this._parallelCount++;
    // Create per-tool AbortController for sibling abort
    const ac = new AbortController();
    this._toolAbortControllers.set(call.id, ac);

    const promise = this._executeSingle(call, ac.signal).finally(() => {
      this._parallelCount--;
      this._inflight.delete(call.id);
      this._toolAbortControllers.delete(call.id);
    });
    this._inflight.set(call.id, promise);
  }

  /**
   * Execute a single tool call with timing.
   * On bash/shell error, triggers sibling abort to cancel other parallel tools.
   * @param {ToolCall & { id: string }} call
   * @param {AbortSignal} [signal] - Abort signal for cancellation
   * @returns {Promise<ToolResult>}
   * @private
   */
  async _executeSingle(call, signal) {
    const start = Date.now();
    try {
      // Check abort before executing
      if (signal?.aborted) {
        const result = {
          name: call.name,
          params: call.params,
          id: call.id,
          status: 'error',
          output: 'Cancelled by sibling abort',
          elapsed: Date.now() - start,
          siblingAborted: true,
        };
        this._completed.push(result);
        return result;
      }

      const output = await this._executeTools(call.name, call.params, { signal });

      // Check for user denial
      if (output && output.__denied) {
        const result = {
          name: call.name,
          params: call.params,
          id: call.id,
          status: 'denied',
          output: output.message || 'User denied tool execution',
          elapsed: Date.now() - start,
        };
        this._completed.push(result);
        return result;
      }

      const result = {
        name: call.name,
        params: call.params,
        id: call.id,
        status: 'success',
        output,
        elapsed: Date.now() - start,
      };
      this._completed.push(result);
      // 缓存结果供后续 getResultByHash() 复用
      this._resultCache.set(_toolCallHash(call.name, call.params), result);
      return result;
    } catch (err) {
      const result = {
        name: call.name,
        params: call.params,
        id: call.id,
        status: 'error',
        output: err.message || String(err),
        elapsed: Date.now() - start,
      };
      this._completed.push(result);

      // Sibling abort: if a bash/shell tool errors, cancel other inflight tools
      // to prevent wasting time on operations that depend on the failed command
      if (this._siblingAbortOnBashError && _isBashLikeTool(call.name)) {
        this._abortSiblings(call.id);
      }

      return result;
    }
  }

  /**
   * Abort all inflight sibling tools except the one specified.
   * @param {string} exceptId - ID of the tool that triggered the abort
   * @private
   */
  _abortSiblings(exceptId) {
    for (const [id, ac] of this._toolAbortControllers) {
      if (id !== exceptId) {
        try { ac.abort(); } catch { /* ignore */ }
      }
    }
    // Also clear serial queue — no point executing queued tools after bash failure
    this._serialQueue.length = 0;
  }

  /**
   * Drain the serial queue — execute queued tools one at a time.
   * Call this after the stream completes.
   *
   * @returns {Promise<ToolResult[]>} Results from serial executions
   */
  async drainSerialQueue() {
    const results = [];
    while (this._serialQueue.length > 0 && !this._aborted) {
      const call = this._serialQueue.shift();
      const result = await this._executeSingle(call);
      results.push(result);
    }
    return results;
  }

  /**
   * Wait for all inflight parallel executions to complete,
   * then drain the serial queue.
   *
   * @returns {Promise<ToolResult[]>} All results (parallel + serial)
   */
  async awaitAll() {
    // Wait for parallel executions
    if (this._inflight.size > 0) {
      await Promise.allSettled([...this._inflight.values()]);
    }

    // Drain serial queue
    await this.drainSerialQueue();

    return this.getAllResults();
  }

  /**
   * Get results that have completed so far (non-blocking).
   * @returns {ToolResult[]}
   */
  getCompletedResults() {
    return [...this._completed];
  }

  /**
   * Get all results collected so far.
   * @returns {ToolResult[]}
   */
  getAllResults() {
    return [...this._completed];
  }

  /**
   * Check if there are still pending executions.
   * @returns {boolean}
   */
  hasPending() {
    return this._inflight.size > 0 || this._serialQueue.length > 0;
  }

  /**
   * Abort — prevent new tools from starting and skip remaining serial queue.
   */
  abort() {
    this._aborted = true;
    this._serialQueue.length = 0;
  }

  /**
   * Get execution statistics.
   * @returns {{ completed: number, inflight: number, queued: number, aborted: boolean }}
   */
  getStats() {
    return {
      completed: this._completed.length,
      inflight: this._inflight.size,
      queued: this._serialQueue.length,
      aborted: this._aborted,
    };
  }

  /**
   * 通过工具名+参数 hash 获取缓存结果（借鉴 Claude Code 流式预执行）。
   * 如果在流式阶段已预执行完成，toolUseLoop 可直接复用结果避免重复执行。
   *
   * @param {string} toolName
   * @param {object} params
   * @returns {ToolResult|null}
   */
  getResultByHash(toolName, params) {
    const hash = _toolCallHash(toolName, params);
    return this._resultCache.get(hash) || null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

const BASH_LIKE_TOOLS = new Set([
  'bash', 'shell', 'shellcommand', 'shell_command',
  'run_shell_command', 'shelltool', 'terminal',
]);

function _isBashLikeTool(name) {
  return BASH_LIKE_TOOLS.has((name || '').toLowerCase().replace(/[-_\s]/g, ''));
}

/**
 * 生成工具调用的指纹 hash（用于结果缓存去重）
 */
function _toolCallHash(toolName, params) {
  const normalized = String(toolName || '').toLowerCase().replace(/[-_]/g, '');
  const paramStr = JSON.stringify(params || {});
  let h = 0;
  const s = `${normalized}:${paramStr}`;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

module.exports = { StreamingToolExecutor };
