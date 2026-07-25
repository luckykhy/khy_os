'use strict';

/**
 * Gateway generation helpers (extracted from cli/ai.js).
 *
 * A conversation-state-free cluster used around a gateway generation attempt: build a user-facing
 * fallback reply from collected tool results (_buildToolFallbackReply + _salvageRecentToolResult /
 * _extractPlan / _buildWorkSummary / _toolProgressLabel), run a natural tool call under an idle
 * timeout (_runNaturalToolCallWithIdleTimeout), format gateway failure details
 * (_formatGatewayFailureDetails), perform a direct (non-streaming) generation (_directGenerate), and
 * gate task-self-awareness injection (_shouldInjectTaskSelfAwareness).
 *
 * Relocated verbatim (byte-identical bodies) into a same-directory sibling leaf so in-body relative
 * require() paths resolve identically; the host re-imports the entry points by the same names. The
 * bodies touch no mutable conversation/session state; they reference the shared khyUpgradeRuntime +
 * foldOutput singletons (re-required here) and four host accessors (audit-trace context, the two
 * standalone-LLM loggers, and getService) injected via setAiGatewayGenerateHelpersDeps to avoid a
 * require cycle back into ai.js. The leaf performs IO (service calls, logging), so it does NOT
 * self-declare as a pure zero-IO leaf.
 */

const runtime = require('../services/khyUpgradeRuntime');
const { foldOutput } = require('./toolDisplayPolicy');
// _shouldInjectTaskSelfAwareness sizes the request via the task-scale helper, which lives in the
// sibling aiRequestParsers leaf (also extracted from cli/ai.js; no require cycle — it only pulls in
// khyUpgradeRuntime). Re-require it here by the same name so the moved body stays byte-identical.
const { _resolveTaskScale } = require('./aiRequestParsers');

// Host accessors injected at load (all hoisted function declarations, so the setter is load-safe).
let _resolveAuditTraceContext = null;
let _logStandaloneLlmRequest = null;
let _logStandaloneLlmResponse = null;
let getService = null;
function setAiGatewayGenerateHelpersDeps(deps = {}) {
  if (typeof deps._resolveAuditTraceContext === 'function') _resolveAuditTraceContext = deps._resolveAuditTraceContext;
  if (typeof deps._logStandaloneLlmRequest === 'function') _logStandaloneLlmRequest = deps._logStandaloneLlmRequest;
  if (typeof deps._logStandaloneLlmResponse === 'function') _logStandaloneLlmResponse = deps._logStandaloneLlmResponse;
  if (typeof deps.getService === 'function') getService = deps.getService;
}

/**
 * Build a user-friendly reply from collected tool results when the
 * follow-up AI generation fails (timeout, error, empty response).
 * This ensures the user always sees the tool output instead of raw
 * <tool_call> tags or an empty reply.
 */
function _buildToolFallbackReply(toolResults) {
  if (!toolResults || toolResults.length === 0) return '';
  const parts = [];
  for (const tr of toolResults) {
    const text = tr.result.replace(/^\[Tool:\S+\]\s*/, '');
    const action = String(tr.action || '').toLowerCase();
    if (tr.success) {
      // Summarize differently based on tool type
      if (action === 'grep' || action === 'glob') {
        // File list tools: show list compactly, cap at 20 entries
        const lines = text.split('\n').filter(l => l.trim());
        const header = lines[0] && /^Found \d+/.test(lines[0]) ? lines.shift() : null;
        const { lines: foldedFiles } = foldOutput(lines, { maxLines: 20, foldHead: 20, foldTail: 0 });
        let summary = header ? header + '\n' : '';
        summary += foldedFiles.map(f => `- ${f.trim()}`).join('\n');
        parts.push(summary);
      } else if (action === 'read') {
        // Read: show first 500 chars only, encourage model to analyze
        parts.push(text.length > 500 ? text.slice(0, 500) + '\n...(file content truncated)' : text);
      } else {
        parts.push(text.length > 800 ? text.slice(0, 800) + '\n...(truncated)' : text);
      }
    } else {
      parts.push(text.length > 300 ? text.slice(0, 300) + '...' : text);
    }
  }
  const raw = parts.join('\n\n').trim();
  if (!raw) return '';

  // 自明工具（open_app/shell_command 等）成功后不需要冗余汇报
  const SELF_EVIDENT_TOOLS = new Set(['open_app', 'open_url', 'open_browser', 'shell_command', 'run_command']);
  const allSelfEvident = toolResults.every(tr => tr.success && SELF_EVIDENT_TOOLS.has(String(tr.action || '').toLowerCase()));
  if (allSelfEvident) return '';

  const toolNames = [...new Set(toolResults.map(t => t.action).filter(Boolean))];
  const header = toolNames.length
    ? `执行了 ${toolNames.join('、')}，结果如下：`
    : '工具执行结果：';
  return `${header}\n\n${raw}`;
}

/**
 * 空响应救援：模型返回空内容时，从最近的会话历史里捞回上一次「成功」的工具结果。
 *
 * 现象（实测）：用户连续执行工具（如 `pip cache purge`）后追问「结果呢」，弱模型把
 * 输出预算耗在思考里 / 被 max_tokens 截断，最终回复为空 —— 旧逻辑直接抛「未返回有效
 * 回复」，但工具其实已成功执行、结果就在历史里。本函数把那条结果直接回显，避免「执行
 * 成功却报截断」的观感。
 *
 * 仅回溯最近 `maxLookback` 条消息（默认 6），确保捞回的是「刚刚这步」的结果而非陈旧
 * 上下文；失败结果（ERROR: 开头）不冒充成功汇报，返回 null 交由下游走正常错误路径。
 *
 * @param {Array<{role:string,content:string}>} messages
 * @param {{maxLookback?:number}} [opts]
 * @returns {string|null}
 */
function _salvageRecentToolResult(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const maxLookback = Number.isFinite(opts.maxLookback) ? opts.maxLookback : 6;
  const start = Math.max(0, messages.length - maxLookback);
  for (let i = messages.length - 1; i >= start; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (!content.startsWith('[Tool Result]')) continue;
    // 形如 "[Tool Result]\n[Tool:shellCommand] <text>"
    const body = content.replace(/^\[Tool Result\]\s*/, '');
    const mt = body.match(/^\[Tool:(\S+)\]\s*([\s\S]*)$/);
    const action = mt ? mt[1] : null;
    let text = (mt ? mt[2] : body).trim();
    if (!text || /^ERROR:/i.test(text)) return null;
    const TAIL = 1200;
    if (text.length > TAIL) text = `…${text.slice(-TAIL)}`;
    const head = action ? `上一步已执行 ${action}，工具实际输出如下：` : '上一步工具执行结果如下：';
    return `${head}\n\n${text}`;
  }
  return null;
}

/**
 * Extract [Plan] line from model's initial response.
 * Returns { plan, cleaned } where plan is the extracted text (or null)
 * and cleaned is the reply with the [Plan] line removed.
 */
function _extractPlan(reply) {
  const match = reply.match(/^\[Plan\]\s*(.+)$/m);
  if (!match) return { plan: null, cleaned: reply };
  const plan = match[1].trim();
  const cleaned = reply.replace(match[0], '').trim();
  return { plan, cleaned };
}

/**
 * Build a structured work summary from collected tool results.
 * Used when the model doesn't provide its own [Summary].
 */
function _buildWorkSummary(collectedToolResults) {
  if (!collectedToolResults || collectedToolResults.length === 0) return null;
  const actions = collectedToolResults.map(t => t.action).filter(Boolean);
  const unique = [...new Set(actions)];
  const succeeded = collectedToolResults.filter(t => t.success).length;
  const failed = collectedToolResults.length - succeeded;
  let summary = `Used ${unique.join(', ')} (${succeeded} succeeded`;
  if (failed > 0) summary += `, ${failed} failed`;
  summary += ')';
  return summary;
}

/**
 * Human-readable description for a tool action being executed.
 */
function _toolProgressLabel(action, arg) {
  const a = String(action || '').toLowerCase();
  if (a === 'read') return `Reading ${arg && arg.file_path ? require('path').basename(arg.file_path) : 'file'}...`;
  if (a === 'write') return `Writing ${arg && arg.file_path ? require('path').basename(arg.file_path) : 'file'}...`;
  if (a === 'edit') return `Editing ${arg && arg.file_path ? require('path').basename(arg.file_path) : 'file'}...`;
  if (a === 'glob') return `Searching files${arg && arg.pattern ? ` (${arg.pattern})` : ''}...`;
  if (a === 'grep') return `Searching code${arg && arg.pattern ? ` (${arg.pattern})` : ''}...`;
  if (a === 'shellcommand' || a === 'bash') return `Running command...`;
  if (a === 'web_search' || a === 'websearch') {
    const query = typeof arg === 'object' ? (arg.query || '') : String(arg || '');
    return query ? `Searching web: ${query.slice(0, 60)}...` : 'Searching web...';
  }
  if (a === 'quote') {
    const symbol = typeof arg === 'object' ? (arg.symbol || '') : String(arg || '');
    return symbol ? `Fetching quote: ${symbol}` : 'Fetching quote...';
  }
  if (a === 'data_fetch') return `Fetching data...`;
  return `Executing ${action}...`;
}

async function _runNaturalToolCallWithIdleTimeout(call, options = {}) {
  const idleTimeoutMsRaw = parseInt(String(options.idleTimeoutMs || ''), 10);
  const idleTimeoutMs = Number.isFinite(idleTimeoutMsRaw) && idleTimeoutMsRaw > 0
    ? idleTimeoutMsRaw
    : 120000;
  const onActivity = typeof options.onActivity === 'function' ? options.onActivity : null;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  let lastActivityEventAt = 0;
  const minActivityEventGapMs = Math.max(250, parseInt(String(process.env.KHY_TOOL_ACTIVITY_EVENT_GAP_MS || '1200'), 10) || 1200);

  let timeoutReject = null;
  let watchdog = null;
  try {
    const { startWatchdog } = require('../services/resourceGuard');
    watchdog = startWatchdog(
      `natural-tool:${String(call && call.action ? call.action : 'tool')}`,
      idleTimeoutMs,
      (_operationName, elapsedSec) => {
        if (!timeoutReject) return;
        const reject = timeoutReject;
        timeoutReject = null;
        reject(new Error(`Tool execution idle timeout after ${elapsedSec}s`));
      }
    );
  } catch {
    watchdog = null;
  }

  const touch = (payload) => {
    try {
      if (watchdog) watchdog.touch();
    } catch { /* non-critical */ }
    if (onActivity) {
      const now = Date.now();
      if (now - lastActivityEventAt >= minActivityEventGapMs || payload === 'start' || payload === 'done') {
        lastActivityEventAt = now;
        try { onActivity(payload); } catch { /* non-critical */ }
      }
    }
  };

  const progress = (payload) => {
    touch(payload);
    if (onProgress) {
      try { onProgress(payload); } catch { /* non-critical */ }
    }
  };

  touch('start');

  const execution = runtime.runNaturalToolCall(call, {
    onActivity: touch,
    onProgress: progress,
  });

  if (!watchdog) {
    const result = await execution;
    touch('done');
    return result;
  }

  const idleTimeoutPromise = new Promise((_, reject) => {
    timeoutReject = reject;
  });

  try {
    const result = await Promise.race([execution, idleTimeoutPromise]);
    touch('done');
    return result;
  } finally {
    timeoutReject = null;
    try {
      if (watchdog) watchdog.done();
    } catch { /* non-critical */ }
  }
}

function _formatGatewayFailureDetails(result) {
  if (!result || !Array.isArray(result.attempts) || result.attempts.length === 0) return '';
  const failed = result.attempts.filter(a => a && a.success === false);
  if (failed.length === 0) return '';

  const normalizeAdapterSig = (raw) => {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return 'adapter';
    if (s === 'localllm' || s === 'local llm' || s.includes('local (') || s.includes('本地模型')) return 'localllm';
    if (s === 'codex' || s.includes('openai codex')) return 'codex';
    if (s === 'claude' || s.includes('anthropic')) return 'claude';
    if (s === 'ollama' || s.includes('ollama')) return 'ollama';
    if (s === 'api' || s.includes('multifree')) return 'api';
    if (s === 'relay' || s.includes('relay')) return 'relay';
    return s;
  };

  const lines = [];
  const seen = new Set();
  let uniqueFailedCount = 0;
  for (const attempt of failed) {
    const adapter = String(attempt.adapterKey || attempt.provider || 'adapter').trim();
    const adapterSig = normalizeAdapterSig(attempt.adapterKey || attempt.provider || 'adapter');
    const statusCode = attempt.statusCode ? String(attempt.statusCode) : '';
    const status = statusCode ? ` (${statusCode})` : '';
    const kindCode = String(attempt.errorType || '').trim().toLowerCase();
    const kind = kindCode ? ` [${kindCode}]` : '';
    const err = String(attempt.error || 'unknown error')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
    const sig = `${adapterSig}|${statusCode}|${kindCode}|${err}`;
    if (!err || seen.has(sig)) continue;
    seen.add(sig);
    uniqueFailedCount += 1;
    if (lines.length < 6) {
      lines.push(`- ${adapter}${status}${kind}: ${err}`);
    }
  }

  if (lines.length === 0) return '';
  if (uniqueFailedCount > lines.length) {
    lines.push(`- ... 还有 ${uniqueFailedCount - lines.length} 条失败记录`);
  }
  return `真实失败原因:\n${lines.join('\n')}`;
}

async function _directGenerate(conversationPrompt, userMessage, opts, effortPreset) {
  const traceCtx = _resolveAuditTraceContext(opts);
  const startedAt = Date.now();
  _logStandaloneLlmRequest(traceCtx, conversationPrompt, opts, {
    source: 'ai-direct',
    requestedModel: effortPreset?.label || opts.model || 'direct-fallback',
    preferredAdapter: opts.preferredAdapter || opts.adapter || 'direct-fallback',
    localPath: 'multiFreeService.generateResponse',
  });
  const svc = getService();
  const status = svc.getStatus();
  if (!status.available) {
    const unavailable = {
      success: false,
      errorType: 'network',
      content: '所有 AI 通道不可用。',
    };
    _logStandaloneLlmResponse(traceCtx, unavailable, {
      source: 'ai-direct',
      provider: 'multiFreeService',
      adapter: 'direct-fallback',
      durationMs: Date.now() - startedAt,
      localPath: 'multiFreeService.generateResponse',
    });
    return unavailable;
  }
  const result = await svc.generateResponse(conversationPrompt, {
    temperature: runtime.lockTemperature(userMessage),
    top_p: runtime.lockTopP(userMessage),
    maxTokens: effortPreset.maxTokens,
    images: opts.images,
  });
  _logStandaloneLlmResponse(traceCtx, result, {
    source: 'ai-direct',
    provider: result?.provider || 'multiFreeService',
    adapter: result?.provider || 'direct-fallback',
    durationMs: Date.now() - startedAt,
    localPath: 'multiFreeService.generateResponse',
  });
  return result;
}

function _shouldInjectTaskSelfAwareness(userMessage = '', opts = {}) {
  const gate = String(process.env.KHY_TASK_SELF_AWARENESS || 'true').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(gate)) return false;
  if (opts && opts.disableTaskSelfAwareness === true) return false;

  const text = String(userMessage || '').trim();
  if (!text) return false;

  const scale = _resolveTaskScale(text, opts);
  if (scale !== 'small') return true;

  // Small tasks only inject when user explicitly asks for capability-awareness.
  return /自我认知|能力边界|能力|局限|can you do|what can you|capability|limitations?/i.test(text);
}


module.exports = {
  _buildToolFallbackReply,
  _salvageRecentToolResult,
  _extractPlan,
  _buildWorkSummary,
  _toolProgressLabel,
  _runNaturalToolCallWithIdleTimeout,
  _formatGatewayFailureDetails,
  _directGenerate,
  _shouldInjectTaskSelfAwareness,
  setAiGatewayGenerateHelpersDeps,
};
