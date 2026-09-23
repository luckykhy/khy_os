/**
 * Compact Pipeline — multi-stage message compression.
 *
 * Prevents token overflow before it happens, and recovers from 413 errors
 * by progressively compressing the conversation history.
 *
 * Stages (lightest → heaviest):
 *   1.   Tool Result Budget — truncate oversized tool outputs, persist large results to disk
 *   1.5  SnipCompact — truncate old assistant responses (>2000 chars → 500 chars)
 *   2.   Microcompact — deduplicate, fold old tool results to summaries
 *   2.5  ContextCollapse — fold consecutive tool interaction chains (≥3 rounds)
 *   3.   Autocompact — AI-generated summary replacing old messages
 *
 * Each stage is independent. The pipeline runner chains them in order,
 * passing freed-token counts forward so later stages can make informed
 * decisions.
 *
 * Stage 1 (tool-result persistence) and Stages 1.5/2/2.5 (message folding) are
 * behavior-neutral pure leaves re-bound here; this module retains the shared
 * circuit-breaker state and the AI autocompact + pipeline runner.
 */

const AUTOCOMPACT_THRESHOLD = 0.8; // 80% of budget triggers autocompact
// @deprecated 显示侧不要再用这个比例。它是「占 maxTokens 预算」的比例,且唯一使用者
// runCompactPipeline 已无调用点(死码)。底栏倒计时的真实真源是
// services/contextRouter.autoCompactTriggerTokens(budget)(routeContextStrategy 的代数逆)。

// ── Autocompact circuit breaker ────────────────────────────────────
// Stop retrying after N consecutive failures to prevent API spam.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
let _consecutiveAutocompactFailures = 0;

// Stage 1: tool-result persistence — pure leaf, re-bound so the public surface
// below resolves to the SAME function/constant identities (byte-identical).
const {
  _persistToolResult,
  applyToolResultBudget,
  persistOversizedToolResults,
  PERSIST_THRESHOLD_CHARS,
  PERSIST_PREVIEW_CHARS,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
} = require('./toolResultPersistence');

// Stages 1.5/2/2.5: message-folding passes — pure leaf. KEEP_RECENT_TURNS lives
// here and is also used by autocompact below.
const {
  KEEP_RECENT_TURNS,
  SNIP_THRESHOLD_CHARS,
  SNIP_KEEP_CHARS,
  COLLAPSE_MIN_CHAIN_LENGTH,
  snipCompact,
  microcompact,
  contextCollapse,
} = require('./compactionStages');

// ── Stage 3: Autocompact ─────────────────────────────────────────────

const COMPACT_PROMPT = `Summarize the conversation below into a concise context message.
Keep: key decisions, important data points, active tasks, and tool results that matter.
Drop: greetings, thinking steps, failed attempts, verbose tool outputs.
Output only the summary, no explanation.`;

/**
 * Generate an AI summary of old messages, replacing them with a single
 * context message. Only triggered when estimated tokens exceed threshold.
 *
 * @param {Array} messages
 * @param {object} deps - { callModel, estimateTokens }
 * @param {object} config - QueryConfig snapshot
 * @param {object} [options]
 * @param {boolean} [options.force] - Force autocompact regardless of threshold
 * @returns {Promise<{ messages: Array, freedChars: number, summaryGenerated: boolean }>}
 */
async function autocompact(messages, deps, config, options = {}) {
  // Estimate current token usage
  const totalText = messages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n');
  const estimatedTokens = deps.estimateTokens
    ? deps.estimateTokens(totalText)
    : Math.ceil(totalText.length / 3);

  const threshold = config.maxTokens * AUTOCOMPACT_THRESHOLD;

  if (!options.force && estimatedTokens < threshold) {
    return { messages, freedChars: 0, summaryGenerated: false };
  }

  // Circuit breaker: prefer per-session counter, fallback to global
  const sessionFailures = options._sessionAutocompactFailures || _consecutiveAutocompactFailures;
  if (sessionFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return {
      messages,
      freedChars: 0,
      summaryGenerated: false,
      circuitBroken: true,
      _sessionAutocompactFailures: sessionFailures,
    };
  }

  if (messages.length <= KEEP_RECENT_TURNS * 2) {
    return { messages, freedChars: 0, summaryGenerated: false };
  }

  // Smart split: use contextCompressor's split-point algorithm if available
  let oldMessages, recentMessages;
  try {
    const {
      findCompressSplitPoint,
      slimForCompression,
      buildConversationBridge,
    } = require('../../../contextCompressor');
    const estFn = deps.estimateTokens || ((text) => Math.ceil((text || '').length / 3));
    const totalText = messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    const totalTokens = estFn(totalText);
    const splitIdx = findCompressSplitPoint(messages, (text) => estFn(text || ''), totalTokens);
    if (splitIdx > 0 && splitIdx < messages.length) {
      const { slimmed } = slimForCompression(messages.slice(0, splitIdx));
      oldMessages = slimmed;
      // Apply conversation bridge to ensure valid role alternation after split
      recentMessages = buildConversationBridge(messages.slice(splitIdx));
    } else {
      oldMessages = messages.slice(0, -KEEP_RECENT_TURNS * 2);
      recentMessages = messages.slice(-KEEP_RECENT_TURNS * 2);
    }
  } catch {
    // Fallback to simple split
    oldMessages = messages.slice(0, -KEEP_RECENT_TURNS * 2);
    recentMessages = messages.slice(-KEEP_RECENT_TURNS * 2);
  }

  // Build the text to summarize
  const oldText = oldMessages
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[non-text]'}`)
    .join('\n')
    .slice(0, 8000); // Cap input to avoid recursive overflow

  // 注入任务快照到摘要输入
  let taskSnapshot = '';
  try {
    const ts = require('../../../../tools/_taskStore');
    taskSnapshot = ts.snapshot();
  } catch {}
  const textForSummary = taskSnapshot ? oldText + '\n\n[Current tasks]\n' + taskSnapshot : oldText;

  // Call AI for summary (use low effort to minimize cost)
  let summary;
  try {
    const result = await deps.callModel(`${COMPACT_PROMPT}\n\n${textForSummary}`, {
      effort: 'low',
      _isFollowUp: true,
    });
    summary = result?.reply || result?.content;
  } catch {
    // AI summary failed — increment both counters
    _consecutiveAutocompactFailures++;
    return {
      messages,
      freedChars: 0,
      summaryGenerated: false,
      _sessionAutocompactFailures: (options._sessionAutocompactFailures || 0) + 1,
    };
  }

  if (!summary || summary.length < 20) {
    _consecutiveAutocompactFailures++;
    return {
      messages,
      freedChars: 0,
      summaryGenerated: false,
      _sessionAutocompactFailures: (options._sessionAutocompactFailures || 0) + 1,
    };
  }

  // Success — reset both counters
  _consecutiveAutocompactFailures = 0;

  // Replace old messages with the summary
  const summaryMessage = {
    role: 'user',
    content: `[Conversation context summary]\n${summary}`,
  };

  // 注入任务快照为独立消息
  const compactedMessages = taskSnapshot
    ? [
        summaryMessage,
        { role: 'assistant', content: '[Active tasks — resume from here]\n' + taskSnapshot },
        ...recentMessages,
      ]
    : [summaryMessage, ...recentMessages];

  const freedChars = oldText.length - summary.length;
  return {
    messages: compactedMessages,
    freedChars: Math.max(0, freedChars),
    summaryGenerated: true,
    _sessionAutocompactFailures: 0,
  };
}

// ── Pipeline Runner ──────────────────────────────────────────────────

/**
 * Run the full compact pipeline: budget → snipCompact → microcompact → contextCollapse → autocompact.
 * 五层渐进压缩（借鉴 Claude Code），从最轻到最重依次尝试。
 *
 * @param {Array} messages
 * @param {object} deps - { callModel, estimateTokens }
 * @param {object} config - QueryConfig snapshot
 * @param {object} [options]
 * @param {boolean} [options.forceAutocompact] - Force stage 5 (for 413/prompt_too_long recovery)
 * @returns {Promise<{ messages: Array, totalFreedChars: number, stagesRun: string[] }>}
 */
async function runCompactPipeline(messages, deps, config, options = {}) {
  const stagesRun = [];
  let totalFreedChars = 0;
  let current = messages;

  // Signal HUD that compaction is starting — via the neutral UI port, no reverse
  // require to cli/hudRenderer (DESIGN-ARCH-021, Batch 2). Silent no-op headless.
  const estimatedTokensBefore = deps.estimateTokens
    ? deps.estimateTokens(
        messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
      )
    : 0;
  require('../../../compactionUiPort').signalCompactingStart(estimatedTokensBefore);

  // Stage 1: Tool result budget
  const s1 = applyToolResultBudget(current);
  current = s1.messages;
  totalFreedChars += s1.freedChars;
  if (s1.freedChars > 0) {
    stagesRun.push('toolResultBudget');
  }

  // Stage 1.5: SnipCompact — 截断非最近轮次的长 assistant 文本
  const s15 = snipCompact(current);
  current = s15.messages;
  totalFreedChars += s15.freedChars;
  if (s15.freedChars > 0) {
    stagesRun.push('snipCompact');
  }

  // Stage 2: Microcompact
  const s2 = microcompact(current);
  current = s2.messages;
  totalFreedChars += s2.freedChars;
  if (s2.freedChars > 0) {
    stagesRun.push('microcompact');
  }

  // Stage 2.5: Context Collapse — 折叠连续工具交互链
  const s25 = contextCollapse(current);
  current = s25.messages;
  totalFreedChars += s25.freedChars;
  if (s25.collapsedChains > 0) {
    stagesRun.push('contextCollapse');
  }

  // Stage 3: Autocompact (only if needed or forced)
  const s3 = await autocompact(current, deps, config, {
    force: options.forceAutocompact,
    _sessionAutocompactFailures: options._sessionAutocompactFailures,
  });
  current = s3.messages;
  totalFreedChars += s3.freedChars;
  if (s3.summaryGenerated) {
    stagesRun.push('autocompact');
  }

  // Signal HUD that compaction is finished — via the neutral UI port (B2).
  require('../../../compactionUiPort').signalCompactingDone();

  return {
    messages: current,
    totalFreedChars,
    stagesRun,
    _sessionAutocompactFailures: s3._sessionAutocompactFailures,
  };
}

/**
 * Reset the autocompact circuit breaker (e.g. for new sessions).
 */
function resetAutocompactCircuitBreaker() {
  _consecutiveAutocompactFailures = 0;
}

module.exports = {
  applyToolResultBudget,
  snipCompact,
  microcompact,
  contextCollapse,
  autocompact,
  runCompactPipeline,
  persistOversizedToolResults,
  resetAutocompactCircuitBreaker,
  // Constants for testing
  PERSIST_THRESHOLD_CHARS,
  PERSIST_PREVIEW_CHARS,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  SNIP_THRESHOLD_CHARS,
  SNIP_KEEP_CHARS,
  COLLAPSE_MIN_CHAIN_LENGTH,
  // Single source of truth for the auto-compact trigger ratio (0.8 = fires
  // at 80% of budget). Exported so the HUD "% until auto-compact" countdown
  // (cli/contextWarning.js) measures against khy's REAL trigger, not a
  // guessed threshold — keeps the displayed countdown honest.
  AUTOCOMPACT_THRESHOLD,
  // Exported for use by queryEngine structured result builder
  persistToolResult: _persistToolResult,
};
