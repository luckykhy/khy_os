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
 */

const DEFAULT_MAX_RESULT_CHARS = 5000;
const AUTOCOMPACT_THRESHOLD = 0.8; // 80% of budget triggers autocompact
const KEEP_RECENT_TURNS = 6;       // Preserve this many recent turn pairs (raised from 4 to retain more task context)

// ── Autocompact circuit breaker ────────────────────────────────────
// Stop retrying after N consecutive failures to prevent API spam.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
let _consecutiveAutocompactFailures = 0;

// ── Tool result persistence ────────────────────────────────────────
// Large tool results are saved to disk with a short preview in-message.
// This prevents context window blowup from verbose tool outputs.
const PERSIST_THRESHOLD_CHARS = 50_000;  // Results > 50K chars → disk
const PERSIST_PREVIEW_CHARS = 2_000;     // Keep 2K preview inline

// ── Per-message aggregation budget ─────────────────────────────────
// Total chars of tool results allowed per single message before persistence.
const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;

// ── Stage 1: Tool Result Budget ──────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Persist a large tool result to disk, returning a preview + file path.
 * @param {string} content - Full tool result content
 * @param {string} toolName - Tool that produced this result
 * @returns {{ preview: string, filePath: string }}
 */
function _persistToolResult(content, toolName) {
  const dir = path.join(os.tmpdir(), 'khy-tool-results');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

  const id = `${toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const filePath = path.join(dir, `${id}.txt`);
  try {
    fs.writeFileSync(filePath, content, 'utf8');
  } catch { return null; }

  const preview = content.slice(0, PERSIST_PREVIEW_CHARS);
  return { preview, filePath };
}

/**
 * Truncate tool result messages that exceed the character budget.
 * Large results (>50K chars) are persisted to disk with a preview.
 * Per-message aggregation budget (200K chars) prevents context blowup.
 *
 * @param {Array} messages - Conversation messages
 * @param {number} [maxChars=5000] - Max chars per tool result
 * @returns {{ messages: Array, freedChars: number, persistedCount: number }}
 */
function applyToolResultBudget(messages, maxChars = DEFAULT_MAX_RESULT_CHARS) {
  let freedChars = 0;
  let persistedCount = 0;
  let perMessageAccum = 0;

  const result = messages.map((msg) => {
    if (msg.role !== 'user' && msg.role !== 'assistant') return msg;

    const content = msg.content;
    if (typeof content !== 'string') return msg;

    // Detect tool result patterns
    if (!content.includes('[Tool execution results]') &&
        !content.startsWith('Result:')) {
      return msg;
    }

    perMessageAccum += content.length;

    // Per-message aggregation budget: if total tool results in one message
    // exceed 200K chars, persist the excess to disk
    if (perMessageAccum > MAX_TOOL_RESULTS_PER_MESSAGE_CHARS && content.length > PERSIST_THRESHOLD_CHARS) {
      const persisted = _persistToolResult(content, 'aggregate');
      if (persisted) {
        persistedCount++;
        const replacement = `${persisted.preview}\n\n<persisted-output path="${persisted.filePath}" original-length="${content.length}" />\n(Full output saved to disk. Use ReadFile to access if needed.)`;
        freedChars += content.length - replacement.length;
        return { ...msg, content: replacement };
      }
    }

    // Large result persistence (>50K chars)
    if (content.length > PERSIST_THRESHOLD_CHARS) {
      const persisted = _persistToolResult(content, 'tool');
      if (persisted) {
        persistedCount++;
        const replacement = `${persisted.preview}\n\n<persisted-output path="${persisted.filePath}" original-length="${content.length}" />\n(Full output saved to disk. Use ReadFile to access if needed.)`;
        freedChars += content.length - replacement.length;
        return { ...msg, content: replacement };
      }
    }

    // Standard truncation
    if (content.length <= maxChars) return msg;

    const truncated = content.slice(0, maxChars) +
      `\n... (truncated from ${content.length} chars)`;
    freedChars += content.length - truncated.length;
    return { ...msg, content: truncated };
  });

  return { messages: result, freedChars, persistedCount };
}

/**
 * s08 L3 "budget" preservation pass — the one piece the live `cli/ai.js`
 * compaction path was missing.
 *
 * KHY's live context path (contextRouter.truncateToolResults + sliding window)
 * TRUNCATES or drops oversized tool results, so anything past the cap is lost
 * for good. Claude Code instead PERSISTS the full output to disk and leaves a
 * `<persisted-output path=… />` marker plus a preview, so the model can fetch
 * the complete result later with ReadFile. This function supplies exactly that
 * preservation step, to run BEFORE truncation/sliding-window so those stages
 * only ever shrink the short marker, never discard real data.
 *
 * It is deliberately narrow: it ONLY persists results larger than
 * PERSIST_THRESHOLD_CHARS and replaces them in-place with a marker. It performs
 * no truncation of its own (that stays the routing layer's job) and is
 * idempotent — a marker already contains `<persisted-output ` so a re-run skips
 * it. Both KHY tool-result encodings are handled:
 *   A) string content carrying an "[Tool execution results]" / "Result:" block
 *   B) structured tool_result blocks (role:'user', content: array of blocks)
 *
 * @param {Array} messages - conversation messages (mutated in place)
 * @returns {{ messages: Array, persistedCount: number, freedChars: number }}
 */
function persistOversizedToolResults(messages) {
  if (!Array.isArray(messages)) return { messages, persistedCount: 0, freedChars: 0 };

  let persistedCount = 0;
  let freedChars = 0;

  const buildMarker = (persisted, originalLength) =>
    `${persisted.preview}\n\n<persisted-output path="${persisted.filePath}" original-length="${originalLength}" />\n(Full output saved to disk. Use ReadFile to access if needed.)`;

  for (const msg of messages) {
    if (!msg) continue;
    const content = msg.content;

    // Form A: string content carrying a tool-execution-results block.
    if (typeof content === 'string') {
      const looksLikeToolResult =
        content.includes('[Tool execution results]') || content.startsWith('Result:');
      if (looksLikeToolResult &&
          content.length > PERSIST_THRESHOLD_CHARS &&
          !content.includes('<persisted-output ')) {
        const persisted = _persistToolResult(content, 'tool');
        if (persisted) {
          const marker = buildMarker(persisted, content.length);
          freedChars += content.length - marker.length;
          msg.content = marker;
          persistedCount++;
        }
      }
      continue;
    }

    // Form B: structured tool_result blocks (role:'user', content: array).
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'tool_result' &&
            typeof block.content === 'string' &&
            block.content.length > PERSIST_THRESHOLD_CHARS &&
            !block.content.includes('<persisted-output ')) {
          const persisted = _persistToolResult(block.content, 'tool');
          if (persisted) {
            const marker = buildMarker(persisted, block.content.length);
            freedChars += block.content.length - marker.length;
            block.content = marker;
            persistedCount++;
          }
        }
      }
    }
  }

  return { messages, persistedCount, freedChars };
}

const SNIP_THRESHOLD_CHARS = 2000; // assistant 文本超过此长度时截断
const SNIP_KEEP_CHARS = 500;       // 截断后保留的前缀字符数

/**
 * 截断非最近轮次中过长的 assistant 文本。
 * 借鉴 Claude Code 的 snipCompact 策略 — 保留头部要点，丢弃冗长推理过程。
 *
 * @param {Array} messages
 * @returns {{ messages: Array, freedChars: number }}
 */
function snipCompact(messages) {
  if (messages.length <= KEEP_RECENT_TURNS * 2) {
    return { messages, freedChars: 0 };
  }

  let freedChars = 0;
  const recentBoundary = messages.length - KEEP_RECENT_TURNS * 2;

  const result = messages.map((msg, i) => {
    if (i >= recentBoundary) return msg;
    if (msg.role !== 'assistant') return msg;
    if (typeof msg.content !== 'string') return msg;
    if (msg.content.length <= SNIP_THRESHOLD_CHARS) return msg;

    const snipped = msg.content.slice(0, SNIP_KEEP_CHARS)
      + `\n\n[...snipped ${msg.content.length - SNIP_KEEP_CHARS} chars — old assistant response truncated for context budget]`;
    freedChars += msg.content.length - snipped.length;
    return { ...msg, content: snipped };
  });

  return { messages: result, freedChars };
}

// ── Stage 2: Microcompact ────────────────────────────────────────────

/**
 * Remove duplicate tool results and fold old context into summaries.
 *
 * - Consecutive identical tool results are deduplicated.
 * - Tool results older than KEEP_RECENT_TURNS turns are collapsed to
 *   one-line summaries.
 *
 * @param {Array} messages
 * @returns {{ messages: Array, freedChars: number }}
 */
function microcompact(messages) {
  if (messages.length <= KEEP_RECENT_TURNS * 2) {
    return { messages, freedChars: 0 };
  }

  let freedChars = 0;
  const recentBoundary = messages.length - KEEP_RECENT_TURNS * 2;
  const result = [];
  let prevHash = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Only compress messages before the recent boundary
    if (i < recentBoundary && msg.role === 'user' && typeof msg.content === 'string') {
      // Check for tool result content
      if (msg.content.includes('[Tool execution results]')) {
        // Extract tool names for summary
        const toolNames = [];
        const toolRegex = /Tool:\s*(\w+)/g;
        let match;
        while ((match = toolRegex.exec(msg.content)) !== null) {
          toolNames.push(match[1]);
        }

        const summary = toolNames.length > 0
          ? `[Tools executed: ${toolNames.join(', ')} — results omitted for brevity]`
          : '[Tool results omitted for brevity]';

        freedChars += msg.content.length - summary.length;
        result.push({ ...msg, content: summary });
        continue;
      }
    }

    // Deduplicate consecutive identical messages
    const hash = msg.role + ':' + (typeof msg.content === 'string' ? msg.content : '');
    if (hash === prevHash) {
      freedChars += (typeof msg.content === 'string' ? msg.content.length : 0);
      continue;
    }
    prevHash = hash;

    result.push(msg);
  }

  return { messages: result, freedChars };
}

// ── Stage 2.5: Context Collapse ─────────────────────────────────────

const COLLAPSE_MIN_CHAIN_LENGTH = 3; // 至少连续 3 轮工具交互链才折叠

/**
 * 折叠连续的工具调用-结果交互链为结构化摘要。
 * 借鉴 Claude Code 的 contextCollapse — 多轮工具循环（如反复编辑+grep+read）
 * 压缩为简洁的交互链摘要，保留最终结果。
 *
 * @param {Array} messages
 * @returns {{ messages: Array, freedChars: number, collapsedChains: number }}
 */
function contextCollapse(messages) {
  if (messages.length <= KEEP_RECENT_TURNS * 2 + COLLAPSE_MIN_CHAIN_LENGTH * 2) {
    return { messages, freedChars: 0, collapsedChains: 0 };
  }

  let freedChars = 0;
  let collapsedChains = 0;
  const recentBoundary = messages.length - KEEP_RECENT_TURNS * 2;
  const result = [];
  let chainStart = -1;
  let chainTools = [];

  function isToolInteraction(msg) {
    if (typeof msg.content !== 'string') return false;
    return msg.content.includes('[Tool execution results]') ||
           msg.content.includes('Tool:') ||
           /^\s*\{.*"tool_use"/.test(msg.content);
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (i >= recentBoundary) {
      // 刷出剩余链
      if (chainStart >= 0 && chainTools.length >= COLLAPSE_MIN_CHAIN_LENGTH) {
        const chainMsgs = messages.slice(chainStart, i);
        const lastMsg = chainMsgs[chainMsgs.length - 1];
        const summary = `[Tool interaction chain: ${chainTools.join(' → ')} — ${chainMsgs.length} messages collapsed]\n` +
          `Final result: ${(typeof lastMsg.content === 'string' ? lastMsg.content : '').slice(0, 300)}`;
        const chainChars = chainMsgs.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
        freedChars += chainChars - summary.length;
        collapsedChains++;
        result.push({ role: 'user', content: summary });
      } else if (chainStart >= 0) {
        result.push(...messages.slice(chainStart, i));
      }
      chainStart = -1;
      chainTools = [];
      result.push(msg);
      continue;
    }

    if (isToolInteraction(msg)) {
      if (chainStart < 0) chainStart = i;
      // 提取工具名
      const toolMatch = msg.content.match(/Tool:\s*(\w+)/);
      if (toolMatch && !chainTools.includes(toolMatch[1])) {
        chainTools.push(toolMatch[1]);
      }
    } else {
      // 链结束
      if (chainStart >= 0 && chainTools.length >= COLLAPSE_MIN_CHAIN_LENGTH) {
        const chainMsgs = messages.slice(chainStart, i);
        const lastMsg = chainMsgs[chainMsgs.length - 1];
        const summary = `[Tool interaction chain: ${chainTools.join(' → ')} — ${chainMsgs.length} messages collapsed]\n` +
          `Final result: ${(typeof lastMsg.content === 'string' ? lastMsg.content : '').slice(0, 300)}`;
        const chainChars = chainMsgs.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
        freedChars += chainChars - summary.length;
        collapsedChains++;
        result.push({ role: 'user', content: summary });
      } else if (chainStart >= 0) {
        result.push(...messages.slice(chainStart, i));
      }
      chainStart = -1;
      chainTools = [];
      result.push(msg);
    }
  }

  return { messages: result, freedChars, collapsedChains };
}

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
  const totalText = messages.map((m) =>
    typeof m.content === 'string' ? m.content : ''
  ).join('\n');
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
    return { messages, freedChars: 0, summaryGenerated: false, circuitBroken: true, _sessionAutocompactFailures: sessionFailures };
  }

  if (messages.length <= KEEP_RECENT_TURNS * 2) {
    return { messages, freedChars: 0, summaryGenerated: false };
  }

  // Smart split: use contextCompressor's split-point algorithm if available
  let oldMessages, recentMessages;
  try {
    const { findCompressSplitPoint, slimForCompression, buildConversationBridge } = require('../contextCompressor');
    const estFn = deps.estimateTokens || ((text) => Math.ceil((text || '').length / 3));
    const totalText = messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
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
  try { const ts = require('../../tools/_taskStore'); taskSnapshot = ts.snapshot(); } catch {}
  const textForSummary = taskSnapshot
    ? oldText + '\n\n[Current tasks]\n' + taskSnapshot
    : oldText;

  // Call AI for summary (use low effort to minimize cost)
  let summary;
  try {
    const result = await deps.callModel(
      `${COMPACT_PROMPT}\n\n---\n${textForSummary}`,
      { effort: 'low', _isFollowUp: true }
    );
    summary = result?.reply || result?.content;
  } catch {
    // AI summary failed — increment both counters
    _consecutiveAutocompactFailures++;
    return { messages, freedChars: 0, summaryGenerated: false, _sessionAutocompactFailures: (options._sessionAutocompactFailures || 0) + 1 };
  }

  if (!summary || summary.length < 20) {
    _consecutiveAutocompactFailures++;
    return { messages, freedChars: 0, summaryGenerated: false, _sessionAutocompactFailures: (options._sessionAutocompactFailures || 0) + 1 };
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
    ? [summaryMessage, { role: 'assistant', content: '[Active tasks — resume from here]\n' + taskSnapshot }, ...recentMessages]
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
    ? deps.estimateTokens(messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n'))
    : 0;
  require('../compactionUiPort').signalCompactingStart(estimatedTokensBefore);

  // Stage 1: Tool result budget
  const s1 = applyToolResultBudget(current);
  current = s1.messages;
  totalFreedChars += s1.freedChars;
  if (s1.freedChars > 0) stagesRun.push('toolResultBudget');

  // Stage 1.5: SnipCompact — 截断非最近轮次的长 assistant 文本
  const s15 = snipCompact(current);
  current = s15.messages;
  totalFreedChars += s15.freedChars;
  if (s15.freedChars > 0) stagesRun.push('snipCompact');

  // Stage 2: Microcompact
  const s2 = microcompact(current);
  current = s2.messages;
  totalFreedChars += s2.freedChars;
  if (s2.freedChars > 0) stagesRun.push('microcompact');

  // Stage 2.5: Context Collapse — 折叠连续工具交互链
  const s25 = contextCollapse(current);
  current = s25.messages;
  totalFreedChars += s25.freedChars;
  if (s25.collapsedChains > 0) stagesRun.push('contextCollapse');

  // Stage 3: Autocompact (only if needed or forced)
  const s3 = await autocompact(current, deps, config, {
    force: options.forceAutocompact,
    _sessionAutocompactFailures: options._sessionAutocompactFailures,
  });
  current = s3.messages;
  totalFreedChars += s3.freedChars;
  if (s3.summaryGenerated) stagesRun.push('autocompact');

  // Signal HUD that compaction is finished — via the neutral UI port (B2).
  require('../compactionUiPort').signalCompactingDone();

  return {
    messages: current, totalFreedChars, stagesRun,
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
