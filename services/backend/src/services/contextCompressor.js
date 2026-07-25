'use strict';

/**
 * contextCompressor.js — Unified context compression with smart split-point.
 *
 * Replaces the naive tail-greedy cutoff in buildSlidingWindow with a
 * Qwen-inspired 4-phase split-point algorithm, base64 stripping, and
 * conversation bridge synthesis.
 *
 * Key features:
 *   1. findCompressSplitPoint — 4-phase fallback for clean message splits
 *   2. slimForCompression — base64 image stripping + oversized result truncation
 *   3. buildConversationBridge — role alternation repair after split
 *   4. compress — unified entry point orchestrating all steps
 *
 * Constants:
 *   COMPRESSION_TOKEN_THRESHOLD = 0.70 (trigger at 70% usage)
 *   COMPRESSION_PRESERVE_RATIO  = 0.30 (keep last 30%)
 *   MIN_COMPRESSION_FRACTION    = 0.05 (at least 5% must be compressed)
 *   TOOL_ROUND_RETAIN_COUNT     = 2    (keep last 2 tool call rounds intact)
 *   IMAGE_DATA_ESTIMATE_CHARS   = 6400 (flat estimate per stripped image)
 *   MAX_TOOL_RESULT_CHARS       = 5000 (truncate tool results beyond this)
 */

// ── Constants ───────────────────────────────────────────────────────────

const COMPRESSION_TOKEN_THRESHOLD = 0.70;
const COMPRESSION_PRESERVE_RATIO  = 0.30;
const MIN_COMPRESSION_FRACTION    = 0.05;
const TOOL_ROUND_RETAIN_COUNT     = 2;
const IMAGE_DATA_ESTIMATE_CHARS   = 6400;
const MAX_TOOL_RESULT_CHARS       = 5000;

// A5: 反抖动常量
const COMPRESSION_COOLDOWN_MS     = 30000;   // 两次压缩最小间隔 30s
const LOW_EFFICIENCY_THRESHOLD    = 0.10;    // 压缩效率低于 10% 视为低效
const MAX_CONSECUTIVE_LOW_EFF     = 2;       // 连续低效 N 次后跳过

// A5: 反抖动状态
let _lastCompressionTs      = 0;
let _consecutiveLowEff      = 0;
// A5: session 恢复标记
let _sessionJustResumed     = false;

// ── Base64 data URL pattern ──────────────────────────────────────────────

const BASE64_DATA_RE = /data:([^;]+);base64,[A-Za-z0-9+/=]{100,}/g;

// ── Role helpers ──────────────────────────────────────────────────────────

/**
 * Check if a message has tool-call content (assistant requesting a tool).
 */
function _hasToolCall(msg) {
  if (!msg) return false;
  // OpenAI format: tool_calls array
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
  // KHY/Claude format: function_call field
  if (msg.function_call) return true;
  // Embedded in content as <tool_call> tags
  if (typeof msg.content === 'string' && msg.content.includes('<tool_call>')) return true;
  return false;
}

/**
 * Check if a message is a tool/function result.
 */
function _isToolResult(msg) {
  if (!msg) return false;
  if (msg.role === 'tool' || msg.role === 'function') return true;
  // Anthropic format: role='user' with tool_result content blocks
  if (msg.role === 'user' && Array.isArray(msg.content)) {
    return msg.content.some(b => b && b.type === 'tool_result');
  }
  return false;
}

/**
 * Check if a message is a user message (clean split boundary).
 */
function _isUserMessage(msg) {
  return msg && msg.role === 'user';
}

// ── findCompressSplitPoint ──────────────────────────────────────────────

/**
 * Find the optimal index to split messages into [old, kept] for compression.
 *
 * 4-phase fallback:
 *   Phase 1: Character estimation → locate target position
 *   Phase 2: Forward scan from target for a clean user-message boundary
 *   Phase 3: Fallback handling for special last-entry roles
 *   Phase 4: splitRetainingTrailingPairs for in-flight tool chains
 *
 * @param {Array} messages - Full message array
 * @param {function} estimateTokensFn - (text: string) => number
 * @param {number} totalTokens - Current total token count
 * @param {number} [targetFraction] - Fraction of messages to compress (0..1)
 * @returns {number} Split index: messages[0..split-1] = old, messages[split..] = kept
 */
function findCompressSplitPoint(messages, estimateTokensFn, totalTokens, targetFraction) {
  const fraction = targetFraction ?? (1 - COMPRESSION_PRESERVE_RATIO);
  const targetTokens = totalTokens * fraction;

  if (messages.length <= 2) return 0;

  // Skip system messages at the start
  let firstNonSystem = 0;
  while (firstNonSystem < messages.length && messages[firstNonSystem].role === 'system') {
    firstNonSystem++;
  }
  if (firstNonSystem >= messages.length - 1) return 0;

  // ── Phase 1: Character estimation to locate target position ────────
  let accum = 0;
  let rawTarget = firstNonSystem;

  for (let i = firstNonSystem; i < messages.length; i++) {
    const tokens = estimateTokensFn(messages[i].content || '');
    accum += tokens;
    if (accum >= targetTokens) {
      rawTarget = i + 1; // split AFTER this message
      break;
    }
  }

  // Clamp: don't compress everything — keep at least a few messages
  const maxSplit = messages.length - Math.max(2, Math.ceil(messages.length * COMPRESSION_PRESERVE_RATIO));
  rawTarget = Math.min(rawTarget, maxSplit);
  rawTarget = Math.max(rawTarget, firstNonSystem + 1);

  // ── Phase 2: Scan forward for a clean user-message boundary ────────
  // Avoid splitting in the middle of a tool-call / tool-result pair.
  let splitIdx = rawTarget;

  for (let i = rawTarget; i < maxSplit; i++) {
    if (_isUserMessage(messages[i]) && !_isToolResult(messages[i + 1])) {
      // Clean boundary: user message not immediately followed by a tool result
      splitIdx = i;
      break;
    }
  }

  // If forward scan didn't find a clean boundary, scan backward
  if (splitIdx === rawTarget && !_isUserMessage(messages[rawTarget])) {
    for (let i = rawTarget - 1; i >= firstNonSystem + 1; i--) {
      if (_isUserMessage(messages[i])) {
        splitIdx = i;
        break;
      }
    }
  }

  // ── Phase 3: Handle special cases at the split boundary ────────────
  // If the message just before splitIdx is an assistant with tool_call,
  // include the tool_call AND its tool result(s) on the "old" side.
  if (splitIdx > 0) {
    const beforeSplit = messages[splitIdx - 1];
    if (beforeSplit && _hasToolCall(beforeSplit)) {
      // Walk forward past all consecutive tool results
      let j = splitIdx;
      while (j < messages.length && _isToolResult(messages[j])) {
        j++;
      }
      if (j <= maxSplit) {
        splitIdx = j;
      }
    }
  }

  // ── Phase 4: Retain trailing tool-call pairs ───────────────────────
  // Protect the last N complete tool-call rounds from compression.
  splitIdx = _retainTrailingToolRounds(messages, splitIdx, TOOL_ROUND_RETAIN_COUNT);

  return Math.max(firstNonSystem, Math.min(splitIdx, maxSplit));
}

/**
 * Walk backward from splitIdx and ensure the last N tool-call rounds
 * (assistant+tool_call → tool result(s)) are on the "kept" side.
 *
 * @param {Array} messages
 * @param {number} splitIdx
 * @param {number} retainCount
 * @returns {number} Adjusted split index
 */
function _retainTrailingToolRounds(messages, splitIdx, retainCount) {
  let roundsSeen = 0;
  let adjusted = splitIdx;

  for (let i = messages.length - 1; i >= splitIdx && roundsSeen < retainCount; i--) {
    if (_hasToolCall(messages[i])) {
      roundsSeen++;
      adjusted = Math.min(adjusted, i);
    }
  }

  return adjusted;
}

// ── slimForCompression ──────────────────────────────────────────────────

/**
 * Prepare messages for compression by stripping heavy content.
 *
 * - Replaces base64 data URLs with [image: mime/type] placeholders
 * - Truncates oversized tool results to MAX_TOOL_RESULT_CHARS
 *
 * @param {Array} messages - Messages to slim (typically the "old" slice)
 * @returns {{ slimmed: Array, strippedImageCount: number, freedChars: number }}
 */
function slimForCompression(messages) {
  let strippedImageCount = 0;
  let freedChars = 0;

  const slimmed = messages.map((msg) => {
    if (typeof msg.content !== 'string') return msg;

    let content = msg.content;
    const originalLen = content.length;

    // Strip base64 data URLs
    content = content.replace(BASE64_DATA_RE, (match, mime) => {
      strippedImageCount++;
      return `[image: ${mime}]`;
    });

    // Truncate oversized tool results
    if (content.length > MAX_TOOL_RESULT_CHARS &&
        (msg.role === 'tool' || msg.role === 'function' ||
         content.includes('[Tool execution results]'))) {
      content = content.slice(0, MAX_TOOL_RESULT_CHARS)
        + `\n... (truncated from ${originalLen} chars for compression)`;
    }

    if (content.length < originalLen) {
      freedChars += originalLen - content.length;
      return { ...msg, content };
    }
    return msg;
  });

  return { slimmed, strippedImageCount, freedChars };
}

/**
 * Strip base64 data URLs from a single string.
 * Exported for reuse by contextPruner.
 *
 * @param {string} text
 * @returns {{ text: string, strippedCount: number }}
 */
function stripBase64(text) {
  if (!text || typeof text !== 'string') return { text: text || '', strippedCount: 0 };
  let count = 0;
  const result = text.replace(BASE64_DATA_RE, (match, mime) => {
    count++;
    return `[image: ${mime}]`;
  });
  return { text: result, strippedCount: count };
}

// ── buildConversationBridge ─────────────────────────────────────────────

/**
 * Ensure the kept messages start with a valid role sequence.
 *
 * After splitting, the first kept message might be:
 *   - assistant → insert synthetic user message before it
 *   - tool/function → insert synthetic user + assistant messages before it
 *
 * This prevents API errors from role alternation violations.
 *
 * @param {Array} keptMessages
 * @param {string} [summaryHint] - Brief context from the compression summary
 * @returns {Array} Messages with bridge prepended if needed
 */
function buildConversationBridge(keptMessages, summaryHint) {
  if (!keptMessages || keptMessages.length === 0) return keptMessages;

  const first = keptMessages[0];

  // If first message is system or user, no bridge needed
  if (first.role === 'system' || first.role === 'user') return keptMessages;

  const bridgeText = summaryHint
    ? `[Continuing from compressed context: ${summaryHint}]`
    : '[Continue from previous context]';

  if (first.role === 'assistant') {
    // Insert a synthetic user message before the assistant
    return [
      { role: 'user', content: bridgeText },
      ...keptMessages,
    ];
  }

  if (_isToolResult(first)) {
    // Tool result without preceding assistant — insert user + assistant bridge
    return [
      { role: 'user', content: bridgeText },
      { role: 'assistant', content: '[Executing tools from previous context...]' },
      ...keptMessages,
    ];
  }

  return keptMessages;
}

// ── compress (main entry) ───────────────────────────────────────────────

/**
 * Unified context compression.
 *
 * @param {Array} messages - Full conversation messages
 * @param {object} opts
 * @param {function} opts.estimateTokensFn - (text: string) => number
 * @param {function} opts.callModelFn - async (text, opts) => { reply }
 * @param {number} opts.contextWindowTokens - Total context budget
 * @param {object} [opts.logger] - Logger instance
 * @returns {Promise<{
 *   compressed: Array,
 *   summaryGenerated: boolean,
 *   freedTokens: number,
 *   splitIndex: number,
 *   strippedImages: number
 * }>}
 */
async function compress(messages, opts) {
  const {
    estimateTokensFn,
    callModelFn,
    contextWindowTokens,
    logger,
    preserveRatioOverride,   // Coordination: caller can raise preserve ratio if prior layers already pruned
  } = opts;
  const effectivePreserveRatio = (typeof preserveRatioOverride === 'number' && preserveRatioOverride > 0)
    ? Math.min(preserveRatioOverride, 0.70)
    : COMPRESSION_PRESERVE_RATIO;

  const noOp = {
    compressed: messages,
    summaryGenerated: false,
    freedTokens: 0,
    splitIndex: 0,
    strippedImages: 0,
  };

  if (!messages || messages.length <= 4) return noOp;

  // ── A5: 反抖动 — 冷却期内跳过 ─────────────────────────────────────
  const now = Date.now();
  if (_lastCompressionTs && (now - _lastCompressionTs) < COMPRESSION_COOLDOWN_MS) {
    if (logger) logger.info('[contextCompressor] 冷却期内，跳过压缩');
    return noOp;
  }
  // A5: 连续低效跳过
  if (_consecutiveLowEff >= MAX_CONSECUTIVE_LOW_EFF) {
    if (logger) logger.info(`[contextCompressor] 连续 ${_consecutiveLowEff} 次低效压缩，跳过`);
    _consecutiveLowEff = 0; // 重置后下次允许尝试
    return noOp;
  }

  // ── A5: session 恢复后跳过首次压缩 ────────────────────────────────
  if (_sessionJustResumed) {
    _sessionJustResumed = false;
    if (logger) logger.info('[contextCompressor] Session 刚恢复，跳过首次压缩');
    return noOp;
  }

  // ── A4: 双重压缩检测 ─────────────────────────────────────────────
  const hasExistingSummary = messages.some(m =>
    typeof m.content === 'string' && (
      m.content.includes('[Compressed context summary]') ||
      m.content.includes('[ContextCompact v2')
    )
  );

  if (hasExistingSummary) {
    if (logger) logger.info('[contextCompressor] 检测到已有摘要，使用增量更新');
    const result = await _incrementalUpdate(messages, opts);
    _lastCompressionTs = Date.now();
    return result;
  }

  // ── Step 1: Estimate current usage ─────────────────────────────────
  let totalTokens = 0;
  for (const msg of messages) {
    totalTokens += estimateTokensFn(msg.content || '');
  }

  const usageRatio = totalTokens / contextWindowTokens;
  if (usageRatio < COMPRESSION_TOKEN_THRESHOLD) return noOp;

  if (logger) {
    logger.info(`[contextCompressor] Usage ${Math.round(usageRatio * 100)}% — triggering compression`);
  }

  // Hook: PreCompact — notify before compression starts
  try {
    const hookSys = require('./hooks/hookSystem');
    const preHr = await hookSys.trigger('PreCompact', { messageCount: messages.length, totalTokens, usageRatio });
    if (preHr.blocked) return noOp;
  } catch { /* hooks optional */ }

  // ── Step 2: Find split point ───────────────────────────────────────
  const splitIndex = findCompressSplitPoint(
    messages,
    estimateTokensFn,
    totalTokens,
    1 - effectivePreserveRatio,  // Coordinated: if prior layers pruned, compress less
  );

  // Check minimum compression fraction
  const oldTokens = messages.slice(0, splitIndex).reduce(
    (sum, m) => sum + estimateTokensFn(m.content || ''), 0
  );
  if (oldTokens / totalTokens < MIN_COMPRESSION_FRACTION) {
    if (logger) logger.info('[contextCompressor] Too little to compress, skipping');
    return noOp;
  }

  const oldMessages = messages.slice(0, splitIndex);
  let keptMessages = messages.slice(splitIndex);

  // ── Step 3: Slim the old messages ──────────────────────────────────
  const { slimmed, strippedImageCount, freedChars } = slimForCompression(oldMessages);

  // ── Step 4: AI summary ─────────────────────────────────────────────
  // For long histories, use chunked extraction: summarize each chunk's key
  // points first, then merge into a single summary. This prevents the old
  // approach of slicing to 8K chars and losing 96%+ of context.
  const CHUNK_CHARS = 12000;
  const MAX_CHUNKS = 4;
  const fullOldText = slimmed
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[non-text]'}`)
    .join('\n');

  let oldText;
  if (fullOldText.length <= CHUNK_CHARS) {
    oldText = fullOldText;
  } else {
    // Extract key points from each chunk
    const chunkTexts = [];
    for (let i = 0; i < Math.min(MAX_CHUNKS, Math.ceil(fullOldText.length / CHUNK_CHARS)); i++) {
      chunkTexts.push(fullOldText.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS));
    }
    // For each chunk, extract structured bullet points (files changed, decisions, errors, outcomes)
    const keyPoints = [];
    for (const chunk of chunkTexts) {
      // Extract file paths, tool calls, errors, and decisions
      const files = [...new Set((chunk.match(/(?:\/[\w./-]+\.\w+)/g) || []).slice(0, 10))];
      const errors = (chunk.match(/(?:error|failed|exception|ERROR)[^\n]{0,80}/gi) || []).slice(0, 3);
      const tools = (chunk.match(/Tool:\s*\w+/g) || []).slice(0, 5);
      if (files.length) keyPoints.push(`Files: ${files.join(', ')}`);
      if (tools.length) keyPoints.push(`Tools used: ${[...new Set(tools)].join(', ')}`);
      if (errors.length) keyPoints.push(`Issues: ${errors.join('; ').slice(0, 200)}`);
    }
    // Combine: first/last chunks for context + extracted key points
    const contextWindow = fullOldText.slice(0, CHUNK_CHARS) +
      (fullOldText.length > CHUNK_CHARS * 2
        ? `\n...[${Math.round((fullOldText.length - CHUNK_CHARS * 2) / 1000)}K chars of intermediate conversation omitted]\n` + fullOldText.slice(-CHUNK_CHARS)
        : '\n' + fullOldText.slice(CHUNK_CHARS));
    const keyPointsSuffix = keyPoints.length > 0
      ? '\n\n[Key points from full history]\n' + keyPoints.join('\n')
      : '';
    oldText = contextWindow.slice(0, CHUNK_CHARS * 2) + keyPointsSuffix;
  }

  // 注入任务快照，确保 AI 摘要包含任务进度
  let taskSnapshot = '';
  try { const ts = require('../tools/_taskStore'); taskSnapshot = ts.snapshot(); } catch {}
  const oldTextWithTasks = taskSnapshot
    ? oldText + '\n\n[Current tasks]\n' + taskSnapshot
    : oldText;

  let summary;
  try {
    const result = await callModelFn(oldTextWithTasks, { effort: 'medium', _isFollowUp: true });
    summary = result?.reply || result?.content || result;
    if (typeof summary !== 'string') summary = null;
  } catch (err) {
    if (logger) logger.warn('[contextCompressor] AI summary failed:', err?.message);
    // Fallback: manual extraction of key points
    summary = _manualExtract(slimmed);
  }

  if (!summary || summary.length < 20) {
    summary = _manualExtract(slimmed);
  }

  // ── Step 5: Build conversation bridge ──────────────────────────────
  const summaryHint = summary.slice(0, 100);
  keptMessages = buildConversationBridge(keptMessages, summaryHint);

  // ── Step 6: Assemble result ────────────────────────────────────────
  // 修复: 用 user 角色存储摘要，避免 system 角色在 messages 数组中
  // 被适配器过滤掉（Anthropic 要求 system 放在顶层参数而非 messages 中）
  const summaryMessage = {
    role: 'user',
    content: `<compressed_context>\nThis is an automated summary of earlier conversation that was compressed to save context space. It is NOT a user message.\n\n${summary}\n</compressed_context>`,
  };

  // 确保角色交替：如果 keptMessages 首条也是 user，插入 assistant 桥接
  let bridgedKept = keptMessages;
  if (keptMessages.length > 0 && keptMessages[0].role === 'user') {
    bridgedKept = [
      { role: 'assistant', content: '[Context resumed from compression]' },
      ...keptMessages,
    ];
  }

  const compressed = [summaryMessage, ...bridgedKept];

  // 注入任务快照为独立消息，确保压缩后 AI 能看到当前任务进度
  if (taskSnapshot) {
    compressed.splice(1, 0, {
      role: 'assistant',
      content: '[Active tasks — resume from here]\n' + taskSnapshot,
    });
  }

  const newTokens = compressed.reduce(
    (sum, m) => sum + estimateTokensFn(m.content || ''), 0
  );

  if (logger) {
    logger.info(
      `[contextCompressor] Compressed ${messages.length} → ${compressed.length} messages, ` +
      `${totalTokens} → ${newTokens} tokens, ${strippedImageCount} images stripped`
    );
  }

  const freedTokens = totalTokens - newTokens;

  // ── A5: 更新反抖动状态 ────────────────────────────────────────────
  _lastCompressionTs = Date.now();
  const efficiency = totalTokens > 0 ? freedTokens / totalTokens : 0;
  if (efficiency < LOW_EFFICIENCY_THRESHOLD) {
    _consecutiveLowEff++;
    if (logger) logger.info(`[contextCompressor] 低效压缩 (${Math.round(efficiency * 100)}%), 连续 ${_consecutiveLowEff} 次`);
  } else {
    _consecutiveLowEff = 0;
  }

  // Hook: PostCompact — notify after compression completes
  try {
    const hookSys = require('./hooks/hookSystem');
    await hookSys.trigger('PostCompact', { freedTokens, splitIndex, summaryGenerated: true, strippedImages: strippedImageCount });
  } catch { /* hooks optional */ }

  // Transparency: print compaction result to terminal via the neutral UI port
  // (no reverse require to cli/aiRenderer; DESIGN-ARCH-021, Batch 2). The CLI
  // renderer self-registers on load; headless/test → silent no-op.
  require('./compactionUiPort').emitCompactionResult({
    beforeTokens: totalTokens,
    afterTokens: newTokens,
    durationMs: 0,
  });

  return {
    compressed,
    summaryGenerated: true,
    freedTokens,
    splitIndex,
    strippedImages: strippedImageCount,
  };
}

// ── A4: 增量摘要更新 ────────────────────────────────────────────────

/**
 * 当消息中已存在压缩摘要时，只更新摘要而不重新全量压缩。
 * 找到现有摘要 → 提取摘要之后的新消息 → 让 LLM 增量更新摘要 → 替换旧摘要。
 *
 * @param {Array} messages
 * @param {object} opts - 同 compress() 的 opts
 * @returns {Promise<{ compressed, summaryGenerated, freedTokens, splitIndex, strippedImages }>}
 */
async function _incrementalUpdate(messages, opts) {
  const { estimateTokensFn, callModelFn, contextWindowTokens, logger, preserveRatioOverride } = opts;
  const _preserveRatio = (typeof preserveRatioOverride === 'number' && preserveRatioOverride > 0)
    ? Math.min(preserveRatioOverride, 0.70)
    : COMPRESSION_PRESERVE_RATIO;

  const noOp = {
    compressed: messages,
    summaryGenerated: false,
    freedTokens: 0,
    splitIndex: 0,
    strippedImages: 0,
  };

  // 找到摘要消息索引
  let summaryIdx = -1;
  let existingSummary = '';
  for (let i = 0; i < messages.length; i++) {
    const content = typeof messages[i].content === 'string' ? messages[i].content : '';
    if (content.includes('[Compressed context summary]') || content.includes('[ContextCompact v2')) {
      summaryIdx = i;
      existingSummary = content;
      break;
    }
  }

  if (summaryIdx < 0) return noOp;

  // 摘要之后的消息
  const afterSummary = messages.slice(summaryIdx + 1);
  if (afterSummary.length <= 4) return noOp; // 太少不值得更新

  // 计算 token
  const totalTokens = messages.reduce((s, m) => s + estimateTokensFn(m.content || ''), 0);
  const usageRatio = totalTokens / contextWindowTokens;
  if (usageRatio < COMPRESSION_TOKEN_THRESHOLD) return noOp;

  // 找到新增消息中的压缩分割点（保留最后 30%）
  const newMsgTokens = afterSummary.reduce((s, m) => s + estimateTokensFn(m.content || ''), 0);
  const keepCount = Math.max(4, Math.ceil(afterSummary.length * _preserveRatio));
  const compressCount = afterSummary.length - keepCount;
  if (compressCount <= 2) return noOp;

  const toCompress = afterSummary.slice(0, compressCount);
  const toKeep = afterSummary.slice(compressCount);

  // 用 LLM 增量更新摘要
  const newText = toCompress
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : '[non-text]'}`)
    .join('\n')
    .slice(0, 12000);

  let updatedSummary = existingSummary;
  if (typeof callModelFn === 'function') {
    try {
      const prompt = `以下是已有的上下文摘要和新增的对话内容。请更新摘要，合并新信息，保留关键决策和上下文。不要重写，只增量追加重要内容。\n\n已有摘要:\n${existingSummary.slice(0, 12000)}\n\n新增对话:\n${newText}`;
      const result = await callModelFn(prompt, { effort: 'medium', _isFollowUp: true });
      const reply = result?.reply || result?.content || result;
      if (typeof reply === 'string' && reply.length > 20) {
        updatedSummary = `[Compressed context summary]\n${reply}`;
      }
    } catch (err) {
      if (logger) logger.warn('[contextCompressor] 增量摘要失败:', err?.message);
    }
  }

  // 组装结果
  const summaryMessage = { role: 'user', content: updatedSummary };

  // 角色桥接
  let bridgedKeep = toKeep;
  if (toKeep.length > 0 && toKeep[0].role === 'user') {
    bridgedKeep = [
      { role: 'assistant', content: '[Context resumed from incremental compression]' },
      ...toKeep,
    ];
  } else if (toKeep.length > 0 && toKeep[0].role !== 'assistant') {
    bridgedKeep = [
      { role: 'assistant', content: '[continued]' },
      ...toKeep,
    ];
  }

  // 保留摘要之前的 system 消息
  const preSummary = messages.slice(0, summaryIdx).filter(m => m.role === 'system');
  const compressed = [...preSummary, summaryMessage, ...bridgedKeep];

  const newTokens = compressed.reduce((s, m) => s + estimateTokensFn(m.content || ''), 0);
  const freedTokens = totalTokens - newTokens;

  if (logger) {
    logger.info(
      `[contextCompressor] 增量更新: ${messages.length} → ${compressed.length} 条, ` +
      `释放 ${freedTokens} tokens`
    );
  }

  return {
    compressed,
    summaryGenerated: true,
    freedTokens,
    splitIndex: summaryIdx + compressCount,
    strippedImages: 0,
  };
}

// ── A5: Session 恢复标记 API ────────────────────────────────────────

/**
 * 标记 session 刚恢复，下次 compress() 调用将跳过。
 */
function markSessionResumed() {
  _sessionJustResumed = true;
}

/**
 * 重置反抖动状态（测试用）。
 */
function resetAntiJitter() {
  _lastCompressionTs = 0;
  _consecutiveLowEff = 0;
  _sessionJustResumed = false;
}

// ── Manual extraction fallback ──────────────────────────────────────────

/**
 * Extract key information when AI summary is unavailable.
 * Takes the last user message and recent assistant decisions.
 *
 * @param {Array} messages
 * @returns {string}
 */
function _manualExtract(messages) {
  const parts = [];
  let lastUserContent = null;

  for (const msg of messages) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      lastUserContent = msg.content;
    }
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
      // Extract first sentence as a decision point
      const firstSentence = msg.content.split(/[。.!！?\n]/)[0];
      if (firstSentence && firstSentence.length > 10 && firstSentence.length < 200) {
        parts.push(firstSentence);
      }
    }
  }

  if (lastUserContent) {
    const trimmed = lastUserContent.length > 300
      ? lastUserContent.slice(0, 300) + '...'
      : lastUserContent;
    parts.unshift(`Last user request: ${trimmed}`);
  }

  if (parts.length === 0) {
    return 'Previous conversation context was compressed. Details are no longer available.';
  }

  // 兜底注入任务快照
  try {
    const ts = require('../tools/_taskStore');
    const s = ts.snapshot();
    if (s) parts.push('[Active tasks]\n' + s);
  } catch {}

  return parts.slice(0, 5).join('\n');
}

// ── Cycle Boundary (B7 — DeepSeek-TUI alignment) ──────────────────────────

/**
 * Cycle boundary threshold in tokens.
 * When active context exceeds this, trigger a full cycle reset with carry-forward.
 * Default: 192K tokens (configurable via KHY_CYCLE_THRESHOLD_TOKENS).
 */
const CYCLE_THRESHOLD_TOKENS = parseInt(process.env.KHY_CYCLE_THRESHOLD_TOKENS, 10) || 192_000;

/**
 * Max carry-forward briefing budget in tokens (~4 chars per token).
 */
const CARRY_FORWARD_BUDGET_TOKENS = 4000;

/**
 * Trigger a cycle boundary: archive the current session and start fresh
 * with a 3-layer carry-forward.
 *
 * Layer 1 (auto-preserved): system prompt, workspace, todos, working set
 * Layer 2 (model-curated briefing): decisions + constraints + hypotheses (≤budget)
 * Layer 3 (archive): full previous cycle saved as JSONL on disk
 *
 * @param {Array} messages - Current conversation messages
 * @param {object} opts
 * @param {function} opts.estimateTokensFn - Token estimator
 * @param {function} [opts.callModelFn]     - AI summarizer
 * @param {string}  [opts.archiveDir]       - Where to save cycle archive
 * @returns {Promise<{ messages: Array, cycleTriggered: boolean, archivePath: string|null }>}
 */
async function triggerCycleBoundary(messages, opts) {
  const { estimateTokensFn, callModelFn, archiveDir } = opts;

  const totalTokens = messages.reduce(
    (sum, m) => sum + estimateTokensFn(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')),
    0
  );

  if (totalTokens < CYCLE_THRESHOLD_TOKENS) {
    return { messages, cycleTriggered: false, archivePath: null };
  }

  // Layer 1: Auto-preserved (system messages)
  const systemMessages = messages.filter(m => m.role === 'system');

  // Layer 1b: Last user message (the goal)
  const lastUser = [...messages].reverse().find(m => m.role === 'user');

  // Layer 2: Model-curated briefing
  let briefing = '';
  const budgetChars = CARRY_FORWARD_BUDGET_TOKENS * 4;
  if (typeof callModelFn === 'function') {
    try {
      const transcript = messages
        .filter(m => m.role !== 'system')
        .map(m => `[${m.role}] ${typeof m.content === 'string' ? m.content.slice(0, 300) : '[non-text]'}`)
        .join('\n')
        .slice(0, 12000);
      const briefingPrompt = `Summarize the key decisions, constraints, hypotheses, and open questions from this session in ≤${budgetChars} characters. Focus on what matters for continuing the task.\n\n${transcript}`;
      const result = await callModelFn(briefingPrompt, { effort: 'low', _isFollowUp: true });
      briefing = typeof result?.reply === 'string' ? result.reply.slice(0, budgetChars) : '';
    } catch { /* fallback to manual */ }
  }
  if (!briefing) {
    // Manual extraction: last 3 assistant messages summarized
    const assistantMsgs = messages.filter(m => m.role === 'assistant');
    briefing = assistantMsgs.slice(-3).map(m => {
      const text = typeof m.content === 'string' ? m.content : '';
      return text.split(/[。.!！?\n]/)[0]?.slice(0, 200) || '';
    }).filter(Boolean).join('; ').slice(0, budgetChars);
  }

  // Layer 3: Archive to disk
  let archivePath = null;
  if (archiveDir) {
    try {
      const fs = require('fs');
      const path = require('path');
      fs.mkdirSync(archiveDir, { recursive: true });
      archivePath = path.join(archiveDir, `cycle_${Date.now()}.jsonl`);
      const lines = messages.map(m => JSON.stringify(m)).join('\n');
      fs.writeFileSync(archivePath, lines, 'utf-8');
    } catch { /* archive is best-effort */ }
  }

  // Build new message array
  const newMessages = [
    ...systemMessages,
    {
      role: 'system',
      content: `<cycle_boundary timestamp="${Date.now()}">\nPrevious session context was archived. Key carry-forward:\n\n${briefing || 'No briefing available.'}\n</cycle_boundary>`,
    },
  ];
  if (lastUser) {
    newMessages.push(lastUser);
  }

  return { messages: newMessages, cycleTriggered: true, archivePath };
}

// ── Working-Set Aware Pinning (B8 — DeepSeek-TUI alignment) ────────────

/**
 * Error patterns that indicate messages worth preserving during compression.
 */
const ERROR_PIN_PATTERNS = /\b(error|Error|ERROR|panic|PANIC|FAIL|fail|exception|Exception|diff --git|fatal|segfault)\b/;

/**
 * Check if a message mentions files from the working set.
 *
 * @param {object} msg - Message object
 * @param {Set<string>|Array<string>} workingSet - File paths in the working set
 * @returns {boolean}
 */
function _isWorkingSetMention(msg, workingSet) {
  if (!workingSet || !msg) return false;
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (!content) return false;
  const paths = workingSet instanceof Set ? workingSet : new Set(workingSet);
  for (const p of paths) {
    if (content.includes(p)) return true;
    // Also match basename (split on both separators for cross-platform paths)
    const basename = p.split(/[\\/]/).pop();
    if (basename && basename.length > 2 && content.includes(basename)) return true;
  }
  return false;
}

/**
 * Check if a message contains error/patch content worth preserving.
 */
function _isErrorMessage(msg) {
  if (!msg) return false;
  const content = typeof msg.content === 'string' ? msg.content : '';
  return ERROR_PIN_PATTERNS.test(content);
}

/**
 * Deduplicate tool results: keep the latest full result per tool+params hash,
 * replace earlier identical calls with a one-liner summary.
 *
 * @param {Array} messages - Full message array
 * @returns {Array} Deduplicated messages
 */
function deduplicateToolResults(messages) {
  // Track tool result hashes: hash → last index
  const seen = new Map(); // hash → { index, summary }
  const toReplace = new Map(); // index → replacement content

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!_isToolResult(msg)) continue;
    // Extract fingerprint: for structured content, use tool_result block text
    let content;
    if (Array.isArray(msg.content)) {
      content = msg.content
        .filter(b => b && b.type === 'tool_result')
        .map(b => typeof b.content === 'string' ? b.content : JSON.stringify(b.content || ''))
        .join('\n');
    } else {
      content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
    }
    // Use first 200 chars as fingerprint (enough to distinguish different results)
    const fingerprint = content.slice(0, 200);
    if (seen.has(fingerprint)) {
      // Replace the earlier occurrence with a one-liner
      const prev = seen.get(fingerprint);
      toReplace.set(prev.index, `[duplicate tool result — see later occurrence]`);
    }
    seen.set(fingerprint, { index: i, summary: content.slice(0, 80) });
  }

  if (toReplace.size === 0) return messages;

  return messages.map((msg, i) => {
    if (!toReplace.has(i)) return msg;
    const replacementText = toReplace.get(i);
    // For structured content (Array<ContentBlock>), replace each tool_result
    // block's inner content while preserving tool_use_id pairing.
    if (Array.isArray(msg.content)) {
      const newContent = msg.content.map(block => {
        if (block && block.type === 'tool_result') {
          return { ...block, content: replacementText };
        }
        return block;
      });
      return { ...msg, content: newContent };
    }
    return { ...msg, content: replacementText };
  });
}

/**
 * Enhanced split point that accounts for working-set and error pinning.
 * Messages matching working-set paths or error patterns are "pinned" and
 * should not be compressed away.
 *
 * @param {Array} messages
 * @param {number} splitIdx - Original split index from findCompressSplitPoint
 * @param {Set<string>|Array<string>} [workingSet]
 * @returns {number} Adjusted split index (potentially lower to protect pinned messages)
 */
function adjustSplitForPins(messages, splitIdx, workingSet) {
  // Walk backward from splitIdx: if pinned messages would be compressed, lower splitIdx
  let adjusted = splitIdx;
  for (let i = splitIdx - 1; i >= 1; i--) {
    const msg = messages[i];
    if (_isWorkingSetMention(msg, workingSet) || _isErrorMessage(msg)) {
      adjusted = i; // protect this message by lowering split
    }
  }
  return adjusted;
}

// ── A1: 统一角色交替守卫 ──────────────────────────────────────────

/**
 * 确保消息数组严格遵循 user/assistant 交替规则。
 * 统一替代所有散落的手动桥接修复。
 *
 * 规则：
 * 1. 开头的 system 消息保持不变
 * 2. 对话部分必须以 user 开始
 * 3. user/assistant 严格交替
 * 4. tool 消息前面必须有 assistant
 * 5. 连续同角色中间插入占位消息
 *
 * @param {Array} messages
 * @returns {Array} 修复后的消息数组
 */
function enforceRoleAlternation(messages) {
  if (!messages || messages.length === 0) return messages;

  // 分离开头的 system 消息
  let sysEnd = 0;
  while (sysEnd < messages.length && messages[sysEnd].role === 'system') sysEnd++;
  const systemMsgs = messages.slice(0, sysEnd);
  const conversation = messages.slice(sysEnd);

  if (conversation.length === 0) return messages;

  const fixed = [];

  for (let i = 0; i < conversation.length; i++) {
    const cur = conversation[i];
    const curRole = String(cur.role || '').toLowerCase();

    // 跳过无效消息
    if (!curRole) continue;

    // 将 system/tool 角色归一化
    let effectiveRole = curRole;
    if (curRole === 'system') effectiveRole = 'user';
    if (curRole === 'tool') effectiveRole = 'user';

    const prev = fixed[fixed.length - 1];
    const prevRole = prev ? String(prev.role || '').toLowerCase() : null;
    // tool 也被 _buildStructuredMessages 转为 user，这里用 effective 判断
    const prevEffective = prevRole === 'system' ? 'user' : (prevRole === 'tool' ? 'user' : prevRole);

    if (fixed.length === 0) {
      // 对话必须以 user 开头
      if (effectiveRole !== 'user') {
        fixed.push({ role: 'user', content: '[continued]' });
      }
    } else if (prevEffective === effectiveRole) {
      // 连续同角色，插入占位
      if (effectiveRole === 'user') {
        fixed.push({ role: 'assistant', content: '[continued]' });
      } else {
        fixed.push({ role: 'user', content: '[continued]' });
      }
    }

    fixed.push(cur);
  }

  return [...systemMsgs, ...fixed];
}

// ── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  compress,
  findCompressSplitPoint,
  slimForCompression,
  stripBase64,
  buildConversationBridge,
  enforceRoleAlternation,
  // A4+A5: 增量摘要 + 反抖动
  markSessionResumed,
  resetAntiJitter,
  // B7: Cycle Boundary
  triggerCycleBoundary,
  CYCLE_THRESHOLD_TOKENS,
  CARRY_FORWARD_BUDGET_TOKENS,
  // B8: Enhanced pinning & deduplication
  deduplicateToolResults,
  adjustSplitForPins,
  // Constants (for testing / override)
  COMPRESSION_TOKEN_THRESHOLD,
  COMPRESSION_PRESERVE_RATIO,
  MIN_COMPRESSION_FRACTION,
  TOOL_ROUND_RETAIN_COUNT,
  IMAGE_DATA_ESTIMATE_CHARS,
  MAX_TOOL_RESULT_CHARS,
  COMPRESSION_COOLDOWN_MS,
  LOW_EFFICIENCY_THRESHOLD,
  BASE64_DATA_RE,
};
