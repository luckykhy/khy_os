/**
 * QueryEngine — unified dialogue orchestrator (async generator).
 *
 * Centralizes the AI conversation lifecycle that was previously split across
 * ai.js (message management), toolUseLoop.js (tool iteration), and repl.js
 * (command execution). Yields lifecycle events so callers can render them
 * however they choose (CLI, web, SDK).
 *
 * Architecture (Phase 3): this engine is a thin generator ADAPTER over the
 * authoritative tool loop. `submitMessage` preprocesses/secures the input,
 * assembles the system prompt + history, then delegates all loop execution to
 * `toolUseLoop.runToolUseLoop` (see `_submitMessageViaToolLoop`), bridging its
 * callbacks into the `yield {type,data}` event contract via a queue. The former
 * V2 state machine and legacy-inline loop (which manually mirrored the loop's
 * truncation/nudge/verification logic and drifted from it) have been removed,
 * so the loop's behavior can no longer diverge between the two engines.
 *
 * Feature flag: KHY_QUERY_ENGINE=true to enable (default: disabled). When
 * disabled, repl.js/TUI/subagents use toolUseLoop directly.
 *
 * Deprecated: KHY_QUERY_ENGINE_V2 — the V2 path no longer exists. The variable
 * is intentionally no longer read; setting it has no effect (kept undocumented
 * only to avoid breaking external scripts that still export it).
 *
 * Event types yielded by submitMessage():
 *   { type: 'thinking',    data: string }  — AI thinking/status update
 *   { type: 'text',        data: string }  — Streamed text chunk
 *   { type: 'control_request', data: { requestId, request } } — Adapter control request
 *   { type: 'tool_call',   data: { name, params } }
 *   { type: 'tool_result', data: { name, result, elapsed } }
 *   { type: 'cost',        data: { inputTokens, outputTokens, totalTokens } }
 *   { type: 'done',        data: { reply, commands, provider, ... } }
 */

const logger = require('../utils/logger');

const MAX_HISTORY = 30;
const MAX_TURNS = 10;

// ── Output token escalation ─────────────────────────────────────
// When the model hits max_tokens with a small cap (≤8K), retry with
// a much larger cap (64K) to let it finish. Matches Claude Code behavior.
const CAPPED_DEFAULT_MAX_TOKENS = 8_000;
const ESCALATED_MAX_TOKENS = 64_000;
const MAX_OUTPUT_RECOVERY_ATTEMPTS = 3;

// ── Model fallback on overloaded (529) ──────────────────────────
const MAX_CONSECUTIVE_529 = 3;

function _envFlag(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no', 'n'].includes(normalized)) return false;
  return fallback;
}

// ── Structured tool result builder (shared by V2 & Legacy) ─────
const CONTINUATION_SIGNAL = '\n[SYSTEM: 以上是工具执行结果。请根据结果继续完成任务。如果还有未完成的步骤，立即调用下一个工具；如果已全部完成，给出最终总结。]';
const RESULT_TRUNCATE_CHARS = 3000;

let _contentBlockUtils;
function _getCBU() {
  if (!_contentBlockUtils) {
    try { _contentBlockUtils = require('./contentBlockUtils'); } catch { _contentBlockUtils = null; }
  }
  return _contentBlockUtils;
}

function _normalizeControlRequestData(payload = {}) {
  const requestId = String(payload.requestId || payload.id || '').trim();
  const request = payload && typeof payload.request === 'object' && payload.request
    ? payload.request
    : {};
  return { requestId, request };
}

function _buildIntentAssuranceContext(userMessage, processedMessage) {
  try {
    const runtime = require('./khyUpgradeRuntime');
    const assurance = runtime.buildIntentAssuranceDirective(userMessage, {
      purifiedQuestion: processedMessage,
    });
    if (!assurance || !assurance.shouldInject || !assurance.directive) {
      return {
        intentAssurance: assurance || null,
        systemPrompt: '',
        chatOptsPatch: {},
      };
    }
    return {
      intentAssurance: assurance,
      systemPrompt: assurance.directive,
      chatOptsPatch: {
        _intentAssuranceDirective: assurance.directive,
        _intentAssuranceMeta: {
          requestClass: assurance.requestClass || '',
          primaryObjective: assurance.primaryObjective || assurance.summary || '',
          summary: assurance.summary || '',
          constraints: Array.isArray(assurance.constraints) ? assurance.constraints.slice(0, 5) : [],
          detailAnchors: Array.isArray(assurance.detailAnchors) ? assurance.detailAnchors.slice(0, 8) : [],
          tailDetails: Array.isArray(assurance.tailDetails) ? assurance.tailDetails.slice(0, 4) : [],
          detailCount: assurance.detailCount || 0,
          constraintCount: assurance.constraintCount || 0,
          tailDetailCount: assurance.tailDetailCount || 0,
        },
      },
    };
  } catch {
    return {
      intentAssurance: null,
      systemPrompt: '',
      chatOptsPatch: {},
    };
  }
}

/**
 * Build structured follow-up messages after tool execution.
 * Returns { assistantMsg, userMsg } for appending to state.messages.
 *
 * @param {object} chatResult - AI response with .reply and optional .toolUseBlocks
 * @param {Array}  toolCalls  - Parsed tool calls with _toolUseId, _structured
 * @param {Array}  toolResults - Execution results: { name, output, status, elapsed, id, params }
 * @returns {{ assistantMsg: object, userMsg: object }}
 */
function _buildStructuredFollowUp(chatResult, toolCalls, toolResults) {
  const cbu = _getCBU();

  // ── Extract text from tool output ──
  function _extractText(tr) {
    const isError = tr.status !== 'success';
    if (isError) {
      const err = tr.output;
      if (err && typeof err === 'object' && err.code) {
        let t = `[ERROR:${err.code}] ${err.message}`;
        if (err.hint) t += `\nHint: ${err.hint}`;
        return t;
      }
      return `Error: ${typeof err === 'string' ? err : (err?.message || err?.error || 'Unknown error')}`;
    }
    const output = tr.output;
    if (output == null) return 'Success';
    const raw = typeof output === 'string' ? output
      : (typeof output === 'object' && output.output) ? String(output.output)
      : JSON.stringify(output);
    return raw.length > RESULT_TRUNCATE_CHARS ? raw.slice(0, RESULT_TRUNCATE_CHARS) + '...' : raw;
  }

  // ── Build structured blocks (when contentBlockUtils available) ──
  const structuredResults = [];
  const usedIds = new Set();

  for (const tr of toolResults) {
    const isError = tr.status !== 'success';
    const text = _extractText(tr);

    // Resolve tool_use_id: prefer tr.id, then match from parsed toolCalls, then synthesize
    let toolUseId = tr.id || null;
    if (!toolUseId) {
      const match = toolCalls.find(c => c.name === tr.name && c._toolUseId && !usedIds.has(c._toolUseId));
      toolUseId = match?._toolUseId || null;
    }
    if (!toolUseId) {
      toolUseId = `synth_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
    usedIds.add(toolUseId);

    // Propagate _contentBlocks (images, etc.) for Anthropic structured pass-through
    const rawBlocks = tr.output?._contentBlocks || tr.result?._contentBlocks || null;
    structuredResults.push({
      tool_use_id: toolUseId,
      content: text,
      is_error: isError,
      ...(rawBlocks ? { _contentBlocks: rawBlocks } : {}),
    });
  }

  // Build assistant content with tool_use blocks for proper pairing
  const assistantToolUseBlocks = toolCalls
    .filter(c => c._structured && c._toolUseId)
    .map(c => ({ id: c._toolUseId, name: c.name, input: c.params || {} }));

  let assistantContent = chatResult.reply;
  if (cbu && assistantToolUseBlocks.length > 0) {
    assistantContent = cbu.buildAssistantContent(chatResult.reply, assistantToolUseBlocks);
  }

  // Try structured user message first
  let userContent = null;
  if (cbu) {
    const blocks = cbu.buildToolResultContent(structuredResults);
    if (blocks) {
      blocks.push({ type: 'text', text: CONTINUATION_SIGNAL });
      userContent = blocks;
    }
  }

  // Fallback to plain text
  if (!userContent) {
    const parts = ['[Tool execution results]\n'];
    for (const tr of toolResults) {
      parts.push(`Tool: ${tr.name}`);
      parts.push(tr.status === 'success' ? `Result: ${_extractText(tr)}` : _extractText(tr));
      parts.push('');
    }
    userContent = parts.join('\n') + CONTINUATION_SIGNAL;
  }

  return {
    assistantMsg: { role: 'assistant', content: assistantContent },
    userMsg: { role: 'user', content: userContent },
  };
}

// ── Lazy module loaders for V2 (fail gracefully) ─────────────────
// (Removed in Phase 3: the V2 state machine and its query/ helper modules were
//  deleted once queryEngine converged onto the toolUseLoop adapter.)

// ── QueryEngine class ─────────────────────────────────────────────

class QueryEngine {
  /**
   * @param {object} [options]
   * @param {number} [options.maxHistory=30] - Max messages to keep in history
   * @param {number} [options.maxTurns=10] - Max tool-use turns per submitMessage
   * @param {object} [options.deps] - Dependency injection (for testing)
   */
  constructor(options = {}) {
    this._messages = [];
    this._maxHistory = options.maxHistory || MAX_HISTORY;
    this._maxTurns = options.maxTurns || MAX_TURNS;
    this._totalTokens = 0;
    this._aborted = false;
    this._turnHistoryMark = 0;
  }

  /**
   * Submit a user message and yield lifecycle events as an async generator.
   * Single execution path: a thin generator adapter over the authoritative
   * toolUseLoop (Phase 3 — the former V2 state machine was removed).
   *
   * @param {string} userMessage
   * @param {object} [options]
   * @param {string} [options.effort] - AI effort level (low/medium/high/max)
   * @param {Array}  [options.images] - Image attachments
   * @yields {{ type: string, data: any }}
   */
  async * submitMessage(userMessage, options = {}) {
    this._aborted = false;
    // Single execution path: the generator adapter over the authoritative
    // toolUseLoop (Phase 3). The former V2 state machine and inline legacy loop
    // were removed; _submitMessageLegacy now only does preprocessing/security/
    // system-prompt assembly, then delegates to _submitMessageViaToolLoop (or
    // the harness path when enabled).
    yield* this._submitMessageLegacy(userMessage, options);
  }

  // ── Legacy: Original query loop (zero changes) ──────────────────

  /**
   * Original submitMessage implementation — preserved as fallback.
   *
   * @param {string} userMessage
   * @param {object} [options]
   * @yields {{ type: string, data: any }}
   * @private
   */
  async * _submitMessageLegacy(userMessage, options = {}) {
    // ── 1. Input preprocessing ────────────────────────────────────
    let processedMessage = userMessage;
    try {
      const { preprocess } = require('./inputPreprocessor');
      const result = preprocess(userMessage);
      processedMessage = result.processed;
    } catch { /* best effort */ }

    yield { type: 'thinking', data: 'Input preprocessing: normalizing user request (step 1/3)...' };

    // ── 2. Security check ─────────────────────────────────────────
    try {
      const { analyzeInput } = require('./securityGuardService');
      const check = analyzeInput(processedMessage);
      if (!check.safe) {
        yield { type: 'done', data: { reply: check.refusal, commands: [], provider: 'security', blocked: true } };
        return;
      }
    } catch { /* security failure should not block */ }

    // ── 3. Build system prompt ────────────────────────────────────
    const intentCtx = _buildIntentAssuranceContext(userMessage, processedMessage);
    if (intentCtx.intentAssurance?.shouldInject) {
      yield {
        type: 'thinking',
        data: `Intent assurance: extracted primary objective, ${intentCtx.intentAssurance.constraintCount || 0} constraints, ${intentCtx.intentAssurance.detailCount || 0} detail anchors.`,
      };
    }
    const systemPrompt = this._buildSystemPrompt(userMessage, processedMessage, intentCtx);

    // ── 4. Add to history ─────────────────────────────────────────
    this._messages.push({ role: 'user', content: processedMessage });
    if (this._messages.length > this._maxHistory) {
      this._messages = this._messages.slice(-this._maxHistory);
    }
    // Atomic-turn isolation (DESIGN-ARCH-046): remember the index of THIS turn's
    // user message (trim-safe — it is always the tail right now). On a failed /
    // fallback turn, commitTurn rolls history back to here so a canned error
    // never pollutes subsequent context and the next request starts clean.
    this._turnHistoryMark = this._messages.length - 1;

    // Optional harness path: unified context/loop/skills/memory orchestration.
    // On harness failure, fall back to the original legacy loop.
    if (this._isHarnessEnabled(options)) {
      try {
        yield* this._submitMessageLegacyWithHarness({
          userMessage,
          processedMessage,
          systemPrompt,
          chatOptsPatch: intentCtx.chatOptsPatch,
          options,
        });
        return;
      } catch (err) {
        const reason = err?.message || 'unknown harness error';
        yield { type: 'thinking', data: `Harness fallback: ${reason}. Switching to legacy loop.` };
      }
    }

    // ── 5. Tool-use loop (delegated to the authoritative toolUseLoop) ──
    // queryEngine no longer re-implements the agent loop (truncation
    // recovery / nudge / verification). It adapts runToolUseLoop's callbacks
    // into the generator event stream via _submitMessageViaToolLoop, so the
    // two engines can never drift again.
    yield* this._submitMessageViaToolLoop({
      userMessage,
      processedMessage,
      chatOptsPatch: intentCtx.chatOptsPatch,
      options,
    });
  }

  /**
   * Check if harness path is enabled for legacy query loop.
   *
   * Priority:
   * 1) options.useHarness (boolean)
   * 2) KHY_QUERY_ENGINE_HARNESS env
   * 3) default true
   *
   * @param {object} options
   * @returns {boolean}
   * @private
   */
  _isHarnessEnabled(options = {}) {
    if (typeof options.useHarness === 'boolean') return options.useHarness;
    return _envFlag(process.env.KHY_QUERY_ENGINE_HARNESS, true);
  }

  /**
   * Harness-backed legacy submit flow.
   * Keeps query-engine event contract while delegating execution to
   * agenticHarnessService.
   *
   * @param {object} params
   * @param {string} params.userMessage
   * @param {string} params.processedMessage
   * @param {string} params.systemPrompt
   * @param {object} params.options
   * @yields {{ type: string, data: any }}
   * @private
   */
  async * _submitMessageLegacyWithHarness(params) {
    const { userMessage, processedMessage, systemPrompt, chatOptsPatch = {}, options = {} } = params;
    const ai = this._aiChatFacade();
    const { createAgenticHarness } = require('./agenticHarnessService');
    const harness = createAgenticHarness();

    const queue = [];
    let queueWaiter = null;
    let queueClosed = false;

    const pushEvent = (event) => {
      if (!event || queueClosed) return;
      queue.push(event);
      if (queueWaiter) {
        const wake = queueWaiter;
        queueWaiter = null;
        wake();
      }
    };

    const closeQueue = () => {
      queueClosed = true;
      if (queueWaiter) {
        const wake = queueWaiter;
        queueWaiter = null;
        wake();
      }
    };

    const nextEvent = async () => {
      while (queue.length === 0) {
        if (queueClosed) return null;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          queueWaiter = resolve;
        });
      }
      return queue.shift();
    };

    const emitChunk = (chunk) => {
      if (!chunk || typeof chunk !== 'object') return;
      if (chunk.type === 'thinking') {
        const text = chunk.text || chunk.content;
        if (text) pushEvent({ type: 'thinking', data: text });
      } else if (chunk.type === 'text') {
        const text = chunk.text || chunk.content;
        if (text) pushEvent({ type: 'text', data: text });
      } else if (chunk.type === 'assistant_message') {
        // 用户可见的中间消息(如视觉路由说明)——透传到事件流,消费端据 type 渲染。
        const content = chunk.content || chunk.text;
        if (content) pushEvent({ type: 'assistant_message', data: content });
      }
    };

    const chat = async (message, chatOptions = {}) => {
      const result = await ai.chat(message, {
        effort: options.effort || ai.getEffort(),
        images: chatOptions?._isFollowUp ? undefined : options.images,
        ...chatOptsPatch,
        ...chatOptions,
        onChunk: (chunk) => {
          emitChunk(chunk);
          if (typeof chatOptions.onChunk === 'function') {
            try { chatOptions.onChunk(chunk); } catch { /* non-critical */ }
          }
        },
        onControlRequest: (payload) => {
          pushEvent({ type: 'control_request', data: _normalizeControlRequestData(payload) });
          if (typeof chatOptions.onControlRequest === 'function') {
            try { return chatOptions.onControlRequest(payload); } catch { return undefined; }
          }
          return undefined;
        },
      });

      if (result?.tokenUsage) {
        this._totalTokens += result.tokenUsage.totalTokens || 0;
        pushEvent({ type: 'cost', data: result.tokenUsage });
      }

      return result;
    };

    pushEvent({ type: 'thinking', data: 'Harness prepare: context routing and memory hint retrieval in progress...' });

    const priorMessages = this._messages.slice(0, -1);
    let harnessOutcome = null;

    const runPromise = harness.run({
      userMessage: processedMessage,
      messages: priorMessages,
      systemPrompt,
      chat,
      chatOpts: {},
      loopOptions: {
        maxIterations: this._maxTurns,
        onIteration: (iteration) => {
          pushEvent({ type: 'thinking', data: `Agent loop progressing: round ${iteration}/${this._maxTurns}` });
        },
        onToolCall: (toolName, toolParams) => {
          pushEvent({
            type: 'tool_call',
            data: {
              name: toolName,
              params: toolParams || {},
            },
          });
        },
        onToolResult: (toolName, toolParams, result, iteration, elapsed) => {
          pushEvent({
            type: 'tool_result',
            data: {
              name: toolName,
              params: toolParams || {},
              result,
              elapsed,
              iteration,
            },
          });
        },
      },
      recentFiles: Array.isArray(options.recentFiles) ? options.recentFiles : [],
      onEvent: (event) => {
        if (!event || !event.type) return;
        if (event.type === 'retry') {
          const attempt = Number(event.attempt || 0);
          const maxAttempts = Number(event.maxAttempts || 0);
          pushEvent({
            type: 'thinking',
            data: `Recovery action: retrying transient loop failure (${attempt}/${maxAttempts})...`,
          });
          return;
        }
        if (event.type === 'failed') {
          pushEvent({
            type: 'thinking',
            data: `Harness execution status: failed with error "${event.error || 'unknown'}".`,
          });
          return;
        }
        if (event.type === 'completed') {
          const route = String(event.report?.contextRoute || 'fits');
          pushEvent({
            type: 'thinking',
            data: `Harness execution status: completed with context route "${route}".`,
          });
          return;
        }
        if (
          (event.type === 'bugfix_regression_gate' || event.type === 'change_regression_gate')
          && event.phase === 'baseline_completed'
        ) {
          const steps = Array.isArray(event.requiredSteps) && event.requiredSteps.length > 0
            ? event.requiredSteps.join('+')
            : 'auto';
          pushEvent({
            type: 'thinking',
            data: `Regression gate baseline completed for verification steps (${steps}).`,
          });
          return;
        }
        if (
          (event.type === 'bugfix_regression_gate' || event.type === 'change_regression_gate')
          && event.phase === 'final_evaluation'
        ) {
          const status = event.passed ? 'passed' : 'blocked';
          pushEvent({
            type: 'thinking',
            data: `Regression gate final evaluation ${status}: ${String(event.summary || '').trim() || 'no summary'}.`,
          });
          return;
        }
        if (event.type === 'bugfix_regression_gate_error' || event.type === 'change_regression_gate_error') {
          const phase = String(event.phase || 'unknown');
          pushEvent({
            type: 'thinking',
            data: `Regression gate error during "${phase}": ${String(event.error || 'unknown error')}.`,
          });
        }
      },
    })
      .then((result) => {
        harnessOutcome = { ok: true, result };
      })
      .catch((err) => {
        harnessOutcome = { ok: false, error: err };
      })
      .finally(() => {
        closeQueue();
      });

    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const ev = await nextEvent();
      if (!ev) break;
      yield ev;
    }

    await runPromise;

    if (!harnessOutcome) {
      throw new Error('Harness execution returned no outcome');
    }
    if (!harnessOutcome.ok) {
      throw harnessOutcome.error || new Error('Harness execution failed');
    }

    const finalResult = harnessOutcome.result || {};
    const reply = String(finalResult.finalResponse || '');
    const toolCallLog = Array.isArray(finalResult.toolCallLog) ? finalResult.toolCallLog : [];
    const commands = toolCallLog
      .map((entry) => {
        const tool = String(entry?.tool || '').trim();
        if (!tool) return '';
        let serialized = '{}';
        try {
          serialized = JSON.stringify(entry.params || {});
        } catch {
          serialized = '{"error":"unserializable params"}';
        }
        return `${tool}(${serialized})`;
      })
      .filter(Boolean);

    // Atomic-turn commit (DESIGN-ARCH-046): persist a real answer; on an
    // error/fallback turn (finalResult carries errorType/error_code) roll the
    // turn back so it never pollutes session history.
    require('./chatStateIsolation').commitTurn(this._messages, {
      reply,
      finalResult,
      maxHistory: this._maxHistory,
      historyMark: this._turnHistoryMark,
    });

    this._postProcess(userMessage, reply);

    let structuredHarness = null;
    if (process.env.KHY_STRUCTURED_OUTPUT !== '0' && process.env.KHY_STRUCTURED_OUTPUT !== 'false') {
      try {
        structuredHarness = require('./structuredResults/turnEnvelope')
          .buildTurnEnvelope(finalResult, { summary: reply });
      } catch { /* best-effort */ }
    }

    yield {
      type: 'done',
      data: {
        reply,
        commands,
        provider: finalResult.provider,
        tokenUsage: finalResult.tokenUsage,
        effort: finalResult.effort,
        iterations: finalResult.iterations,
        toolCallLog,
        ...(structuredHarness ? { structured: structuredHarness } : {}),
        harness: finalResult.harness,
      },
    };
  }

  // ── Shared helpers ──────────────────────────────────────────────

  /**
   * Generator adapter over the authoritative toolUseLoop.
   *
   * Phase 3 convergence target: instead of re-implementing the agent loop
   * (truncation recovery / nudge / verification) inside queryEngine, delegate
   * execution wholesale to `toolUseLoop.runToolUseLoop` and translate its
   * callbacks into the `{ type, data }` event stream that repl.js consumes.
   *
   * Reuses the proven queue-bridge pattern from `_submitMessageLegacyWithHarness`:
   * the loop runs to completion on a background promise while this generator
   * drains queued events; on completion it emits a terminal `done` whose shape
   * matches the harness path (`reply/commands/provider/tokenUsage/effort/
   * iterations/toolCallLog`).
   *
   * Not wired by default (Step 2). Step 3/4 route legacy/V2 through it.
   *
   * @param {object} params
   * @param {string} params.userMessage - original user message (for post-processing)
   * @param {string} params.processedMessage - preprocessed message fed to the loop
   * @param {object} [params.chatOptsPatch] - intent-assurance chat option patch
   * @param {object} [params.options] - submitMessage options (effort/images/onControlRequest)
   * @yields {{ type: string, data: any }}
   * @private
   */
  async * _submitMessageViaToolLoop(params) {
    const { userMessage, processedMessage, chatOptsPatch = {}, options = {} } = params;
    const ai = this._aiChatFacade();
    const toolUseLoop = require('./toolUseLoop');

    const queue = [];
    let queueWaiter = null;
    let queueClosed = false;

    const pushEvent = (event) => {
      if (!event || queueClosed) return;
      queue.push(event);
      if (queueWaiter) {
        const wake = queueWaiter;
        queueWaiter = null;
        wake();
      }
    };

    const closeQueue = () => {
      queueClosed = true;
      if (queueWaiter) {
        const wake = queueWaiter;
        queueWaiter = null;
        wake();
      }
    };

    const nextEvent = async () => {
      while (queue.length === 0) {
        if (queueClosed) return null;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          queueWaiter = resolve;
        });
      }
      return queue.shift();
    };

    // Stream the model's own thinking/text chunks straight through.
    const emitChunk = (chunk) => {
      if (!chunk || typeof chunk !== 'object') return;
      if (chunk.type === 'thinking') {
        const text = chunk.text || chunk.content;
        if (text) pushEvent({ type: 'thinking', data: text });
      } else if (chunk.type === 'text') {
        const text = chunk.text || chunk.content;
        if (text) pushEvent({ type: 'text', data: text });
      } else if (chunk.type === 'assistant_message') {
        // 用户可见的中间消息(如视觉路由说明)——透传到事件流,消费端据 type 渲染。
        const content = chunk.content || chunk.text;
        if (content) pushEvent({ type: 'assistant_message', data: content });
      }
    };

    // Host-provided chat: wraps ai.chat so the loop stays transport-agnostic.
    const chat = async (message, chatOptions = {}) => {
      return ai.chat(message, {
        effort: options.effort || ai.getEffort(),
        images: chatOptions?._isFollowUp ? undefined : options.images,
        ...chatOptsPatch,
        ...chatOptions,
        onChunk: (chunk) => {
          emitChunk(chunk);
          if (typeof chatOptions.onChunk === 'function') {
            try { chatOptions.onChunk(chunk); } catch { /* non-critical */ }
          }
        },
        onControlRequest: (payload) => {
          pushEvent({ type: 'control_request', data: _normalizeControlRequestData(payload) });
          if (typeof options.onControlRequest === 'function') {
            try { return options.onControlRequest(payload); } catch { return undefined; }
          }
          return undefined;
        },
      });
    };

    const priorMessages = this._messages.slice(0, -1);
    let outcome = null;

    // ── Boulder State: 跨会话检查点覆盖（回退直连路径）──
    // 主 harness 路径已通过 agenticHarnessService._boulderCheckpoint 落盘检查点；
    // 此直连回退路径此前不落盘，导致经此路径运行的构建被打断后无可续检查点。
    // 这里镜像 harness 的 onCheckpoint，使无论走哪条路径，被打断的构建都留下
    // 可被 resumeAdvisor 发现 / 一键续作的检查点。全 best-effort，尊重同一开关。
    const boulderResumeEnabled = !['0', 'false', 'off', 'no'].includes(
      String(process.env.KHY_BOULDER_RESUME || 'true').trim().toLowerCase(),
    );
    const boulderCwd = process.env.KHYQUANT_CWD || process.cwd();
    const boulderTaskId = `qe-${Date.now().toString(36)}`;
    // 仅当本回合确实落过检查点（真多轮任务）才在收口时清除，避免一条无关的轻量
    // 提问把先前被打断构建的检查点误清。
    let boulderCheckpointed = false;
    const _boulderCheckpoint = boulderResumeEnabled ? (info) => {
      try {
        const { saveBoulderState } = require('./boulderState');
        let modes = [];
        try { modes = require('./intentGate').detectModes(userMessage).modes; } catch { /* optional */ }
        boulderCheckpointed = true;
        saveBoulderState(boulderCwd, {
          taskId: boulderTaskId,
          userMessage,
          toolCallLog: info.toolCallLog,
          iterations: (info.iteration || 0) + (info._totalPreviousIterations || 0),
          continuationRound: info._continuationRound || 0,
          activatedModes: modes,
          status: 'in_progress',
          conversationMessages: info.messages || info.conversationMessages || [],
          contextSummary: info.contextSummary || '',
          fileReadHashes: info.fileReadHashes || null,
        });
      } catch { /* best-effort — 绝不打断主循环 */ }
    } : undefined;

    const runPromise = toolUseLoop.runToolUseLoop(processedMessage, {
      chat,
      chatOpts: {},
      maxIterations: this._maxTurns,
      initialMessages: priorMessages,
      onCheckpoint: _boulderCheckpoint,
      // Authenticated user (when the caller carries identity) so preference-aware
      // tools (e.g. image_generate per-user model) resolve correctly; undefined
      // on the CLI/anonymous path → global env/auto fallback, zero behavior change.
      userId: options.userId,
      // Loop-level interactive channel (preflight tool approval); distinct from
      // the chat-streamed control_request above and fired at a different moment.
      onControlRequest: options.onControlRequest,
      onToolCall: (toolName, toolParams) => {
        pushEvent({ type: 'tool_call', data: { name: toolName, params: toolParams || {} } });
      },
      onToolResult: (toolName, toolParams, result, iteration, elapsed) => {
        pushEvent({
          type: 'tool_result',
          data: { name: toolName, params: toolParams || {}, result, elapsed, iteration },
        });
      },
      onCost: (tokenUsage) => {
        this._totalTokens += tokenUsage.totalTokens || 0;
        pushEvent({ type: 'cost', data: tokenUsage });
      },
      onThinking: (text) => {
        if (text) pushEvent({ type: 'thinking', data: text });
      },
    })
      .then((result) => { outcome = { ok: true, result }; })
      .catch((err) => { outcome = { ok: false, error: err }; })
      .finally(() => { closeQueue(); });

    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const ev = await nextEvent();
      if (!ev) break;
      yield ev;
    }

    await runPromise;

    if (!outcome) {
      throw new Error('Tool loop returned no outcome');
    }
    if (!outcome.ok) {
      throw outcome.error || new Error('Tool loop execution failed');
    }

    const finalResult = outcome.result || {};
    const reply = String(finalResult.finalResponse || '');
    const toolCallLog = Array.isArray(finalResult.toolCallLog) ? finalResult.toolCallLog : [];

    // 构建正常收口：清除检查点，避免已完成的任务被启动横幅误报为「未完成」。
    // 仅当本回合确实落过检查点（真多轮任务）时清；轻量提问不触碰先前检查点。fail-soft。
    if (boulderResumeEnabled && boulderCheckpointed) {
      try { require('./boulderState').clearBoulderState(boulderCwd); } catch { /* best-effort */ }
    }
    const commands = toolCallLog
      .map((entry) => {
        const tool = String(entry?.tool || '').trim();
        if (!tool) return '';
        let serialized = '{}';
        try {
          serialized = JSON.stringify(entry.params || {});
        } catch {
          serialized = '{"error":"unserializable params"}';
        }
        return `${tool}(${serialized})`;
      })
      .filter(Boolean);

    // Atomic-turn commit (DESIGN-ARCH-046): persist a real answer; on an
    // error/fallback turn roll the turn back so the canned text never becomes
    // replayed context (the "one error → repeat forever" pollution).
    require('./chatStateIsolation').commitTurn(this._messages, {
      reply,
      finalResult,
      maxHistory: this._maxHistory,
      historyMark: this._turnHistoryMark,
    });

    this._postProcess(userMessage, reply);

    // ── 可维护性元数据（种子文档）──────────────────────────────────
    // 与 agenticHarnessService 同一保证：khy 生成项目必须自带 .ai/ 元数据。
    // 触发条件 + 幂等 + fail-soft 全在 maybeGenerateAfterRun 内；无文件写入时极廉价早退。
    let metadataInfo = null;
    try {
      const projectMetadataService = require('./projectMetadataService');
      const metaCwd = process.env.KHYQUANT_CWD || process.cwd();
      const metaResult = await projectMetadataService.maybeGenerateAfterRun(metaCwd, toolCallLog, {});
      if (metaResult && metaResult.generated) {
        metadataInfo = { root: metaResult.root, files: metaResult.files };
      }
    } catch {
      // best-effort; never disrupt the response stream.
    }

    // Structured turn envelope (我希望Khy-os是结构化输出): a machine-consumable view
    // of the finished turn derived PURELY from structured signals (toolCallLog /
    // error_code), never from scraping `reply`. Additive — sits beside the prose.
    // Disable with KHY_STRUCTURED_OUTPUT=0 if a consumer ever needs the lean shape.
    let structured = null;
    if (process.env.KHY_STRUCTURED_OUTPUT !== '0' && process.env.KHY_STRUCTURED_OUTPUT !== 'false') {
      try {
        structured = require('./structuredResults/turnEnvelope')
          .buildTurnEnvelope(finalResult, { summary: reply });
      } catch { /* envelope is best-effort; never block the response */ }
    }

    yield {
      type: 'done',
      data: {
        reply,
        commands,
        provider: finalResult.provider,
        tokenUsage: finalResult.tokenUsage,
        effort: finalResult.effort,
        iterations: finalResult.iterations,
        toolCallLog,
        ...(structured ? { structured } : {}),
        ...(metadataInfo ? { maintainabilityMetadata: metadataInfo } : {}),
      },
    };
  }


  /**
   * Run non-critical post-processing hooks.
   * @param {string} userMessage
   * @param {string} reply
   * @private
   */
  _postProcess(userMessage, reply) {
    try {
      const { extractKnowledge } = require('./knowledgeTeachingService');
      extractKnowledge(userMessage, reply);
    } catch (err) {
      logger.debug(`queryEngine._postProcess: knowledge extraction skipped: ${err.message}`);
    }

    try {
      const { recordInteraction: recordHabit } = require('./usageHabitService');
      recordHabit(userMessage);
    } catch (err) {
      logger.debug(`queryEngine._postProcess: habit recording skipped: ${err.message}`);
    }
  }

  /**
   * Build the full system prompt with all enrichment layers.
   * @param {string} userMessage
   * @returns {string}
   * @private
   */
  _buildSystemPrompt(userMessage, processedMessage = '', intentContext = null) {
    // The system prompt is already constructed inside ai.chat().
    // QueryEngine delegates to ai.chat() which handles prompt construction.
    // This method exists as a hook for future decoupling.
    const directive = String(intentContext?.systemPrompt || '').trim();
    if (directive) return directive;
    try {
      const fallback = _buildIntentAssuranceContext(userMessage, processedMessage);
      return String(fallback.systemPrompt || '').trim();
    } catch {
      return '';
    }
  }

  /**
   * Build a transport-agnostic chat facade from the inversion ports instead of
   * reaching up into the cli ai module (DESIGN-ARCH-021). `chat` comes from
   * aiChatPort and `getEffort` from aiConversationPort; both are self-registered
   * by the cli layer on load. In a non-CLI process (backend-server / headless)
   * `chat` is absent, so we throw a structured error the streaming caller surfaces
   * — strictly more correct than dragging the whole TUI-coupled CLI into a
   * headless process. `getEffort` degrades to undefined (caller already does
   * `options.effort || ai.getEffort()`).
   * @private
   */
  _aiChatFacade() {
    const { getAiChat } = require('./aiChatPort');
    const { getAiConversation } = require('./aiConversationPort');
    const chat = getAiChat();
    if (typeof chat !== 'function') {
      throw new Error('AI chat provider not registered (CLI not loaded)');
    }
    const conv = getAiConversation();
    return {
      chat,
      getEffort: () => (conv && typeof conv.getEffort === 'function' ? conv.getEffort() : undefined),
    };
  }

  /**
   * Save conversation to disk.
   * @returns {string|null} File path or null
   */
  saveConversation() {
    try {
      const conv = require('./aiConversationPort').getAiConversation();
      return conv && typeof conv.saveConversation === 'function' ? conv.saveConversation() : null;
    } catch { return null; }
  }

  /**
   * Restore the most recently saved conversation into ai.js history.
   *
   * NOTE: the `file` argument is currently not honored — ai.js exposes only
   * `loadLastConversation()` (load by explicit path is not implemented), so the
   * most recent autosaved conversation is always loaded regardless of `file`.
   * Kept in the signature for forward compatibility; document the limitation
   * rather than silently ignore it.
   *
   * @param {string} [file] - Reserved; not yet used (see note above).
   */
  loadConversation(file) {
    try {
      const conv = require('./aiConversationPort').getAiConversation();
      if (conv && typeof conv.loadLastConversation === 'function') conv.loadLastConversation();
    } catch (err) {
      logger.debug(`queryEngine.loadConversation failed: ${err.message}`);
    }
  }

  /**
   * Clear conversation history (both engine and ai.js).
   */
  clearHistory() {
    this._messages = [];
    this._totalTokens = 0;
    try {
      const conv = require('./aiConversationPort').getAiConversation();
      if (conv && typeof conv.clearHistory === 'function') conv.clearHistory();
    } catch (err) {
      logger.debug(`queryEngine.clearHistory: conversation clearHistory failed: ${err.message}`);
    }
  }

  /**
   * Abort the current submitMessage loop.
   */
  abort() {
    this._aborted = true;
  }

  /**
   * Get accumulated token usage for this engine instance.
   * @returns {{ totalTokens: number }}
   */
  getTokenUsage() {
    return { totalTokens: this._totalTokens };
  }
}

// ── Feature flag ──────────────────────────────────────────────────

/**
 * Check if QueryEngine is enabled via KHY_QUERY_ENGINE env var.
 * @returns {boolean}
 */
function isEnabled() {
  return process.env.KHY_QUERY_ENGINE === 'true';
}

// ── Exports ───────────────────────────────────────────────────────

module.exports = { QueryEngine, isEnabled };
