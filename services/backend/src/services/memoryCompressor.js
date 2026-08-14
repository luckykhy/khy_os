'use strict';

/**
 * memoryCompressor.js — Y-code 风格会话记忆压缩服务。
 *
 * 基于 Y-code core/memory_compressor.py 的 compress_session_memory()，
 * 适配 Khyos 服务端场景。
 *
 * 核心能力：
 *  1. LLM-based 会话历史压缩：保留最近 N 条消息，总结旧消息
 *  2. 工具调用组边界安全：防止拆散 tool_call / tool_result 对
 *  3. 并发安全：会话级重入锁 + 乐观边界校验（防止新消息被静默跳过）
 *  4. 可配置参数：保留条数、摘要长度、截断阈值
 *
 * 使用方式：
 *  const result = await memoryCompressor.compress(session, conversation, llmClient, opts);
 *  // Returns: { compressed: boolean, summary?: string }
 */

const getAppHome = require('../utils/dataHome');
const simpleTokenEstimate = require('../utils/simpleTokenEstimate');

// ─── Defaults ──────────────────────────────────────────────────────────────

const DEFAULTS = {
  retainCount: 8,
  retainCountForce: 4,
  toolResultTruncateThresholdChars: 2000,
  toolResultPreviewLimitChars: 800,
  toolResultTokenLimit: 600,
  summaryLengthFirst: 250,
  summaryLengthMerge: 350,
};

// ─── Reentrant guard ────────────────────────────────────────────────────────

const _guard = new Map(); // sessionId → boolean (in-flight marker)

// ─── Main entry ────────────────────────────────────────────────────────────

/**
 * Compress conversation history of a session using LLM summarization.
 *
 * @param {object} session - Session model { id, memory_summary, conversation_id }
 * @param {object} conversation - Conversation store with .getMessages() / .updateSummary()
 * @param {object} llmClient - LLM client with .complete(messages, opts) returning { content }
 * @param {object} [options]
 * @param {function} [options.emit] - Optional progress callback (msg: string) => void
 * @param {boolean} [options.force] - Force compression even with few messages
 * @param {object} [options.config] - Override defaults
 * @returns {{ compressed: boolean, summary?: string, messagesSummarized?: number, reason?: string }}
 */
async function compress(session, conversation, llmClient, options) {
  const opts = options || {};
  const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
  const force = !!opts.force;
  const config = { ...DEFAULTS, ...(opts.config || {}) };

  const sessionId = String(session.id || session.conversation_id || '');

  // Reentrant guard
  if (_guard.has(sessionId)) {
    emit('记忆压缩已在进行中，本次请求已跳过。');
    return { compressed: false, reason: 'already_compressing' };
  }
  _guard.set(sessionId, true);

  try {
    return await _doCompress(session, conversation, llmClient, config, force, emit);
  } finally {
    _guard.delete(sessionId);
  }
}

// ─── Internal ──────────────────────────────────────────────────────────────

async function _doCompress(session, conversation, llmClient, config, force, emit) {
  try {
    // 1. Read all messages
    const messages = await conversation.getMessages({
      afterMessageId: session.summarized_until_msg_id || 0,
    });

    if (!messages || messages.length === 0) {
      return { compressed: false, reason: 'no_messages' };
    }

    // 2. Determine retain count
    const retainCount = force ? config.retainCountForce : config.retainCount;

    if (messages.length <= retainCount + 2 && !force) {
      emit(`当前会话活跃对话过少（少于 ${retainCount + 2} 条），无需压缩。`);
      return { compressed: false, reason: 'too_few_messages' };
    }

    // 3. Split: messages to summarize vs messages to retain
    const messagesToSummarize = messages.slice(0, messages.length - retainCount);

    // Safety: ensure tool_call/tool_result pairs stay together
    // If the first retained message is a tool result, its matching tool_call
    // was pushed into the summarize zone — pull it back.
    const retained = messages.slice(messages.length - retainCount);
    let extra = 0;
    while (extra < retained.length - 1 && retained[extra] && retained[extra].role === 'tool') {
      extra++;
    }
    const effectiveSummarizeCount = messages.length - retainCount + extra;
    const finalMessagesToSummarize = messages.slice(0, effectiveSummarizeCount);
    const finalRetained = messages.slice(effectiveSummarizeCount);

    if (finalMessagesToSummarize.length === 0) {
      return { compressed: false, reason: 'nothing_to_summarize' };
    }

    // 4. Build chat log for summarization
    const oldSummary = session.memory_summary || '';
    const chatLog = _buildChatLog(finalMessagesToSummarize, config);

    if (!chatLog.trim()) {
      return { compressed: false, reason: 'empty_chat_log' };
    }

    // 5. Build summarization prompt
    const summaryLimit = oldSummary ? config.summaryLengthMerge : config.summaryLengthFirst;

    const prompt = _buildSummaryPrompt(chatLog, oldSummary, summaryLimit);

    // 6. Call LLM (prefer cheaper secondary model)
    emit('正在智能压缩并整合长对话记忆...');

    const summary = await _callSummaryLLM(llmClient, prompt);

    if (!summary || !summary.trim()) {
      return { compressed: false, reason: 'empty_summary' };
    }

    // 7. Persist
    const maxSummarizedId = finalMessagesToSummarize[finalMessagesToSummarize.length - 1].id;

    await conversation.updateSummary(session.id, summary.trim(), maxSummarizedId, {
      oldBoundary: session.summarized_until_msg_id,
    });

    emit(`记忆压缩完成，总结 ${finalMessagesToSummarize.length} 条对话。`);
    return {
      compressed: true,
      summary: summary.trim(),
      messagesSummarized: finalMessagesToSummarize.length,
    };
  } catch (error) {
    emit(`记忆压缩失败: ${error.message}`);
    return { compressed: false, reason: 'error', error: error.message };
  }
}

// ─── Private: chat log builder ──────────────────────────────────────────────

function _buildChatLog(messages, config) {
  const lines = [];

  for (const msg of messages) {
    const role = msg.role;

    // Skip system messages (runtime context scaffolding)
    if (role === 'system') {
      continue;
    }

    let content = String(msg.content || '');
    if (!content) {
      continue;
    }

    // Strip thinking tags to reduce token burden
    content = content.replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/g, '').trim();
    if (!content) {
      continue;
    }

    // Truncate long tool results
    if (role === 'tool') {
      content = _truncateToolResult(content, config);
    }

    const roleLabel = role === 'user' ? '用户' : role === 'assistant' ? '助手' : '工具结果';
    lines.push(`${roleLabel}: ${content}`);
  }

  return lines.join('\n\n');
}

function _truncateToolResult(content, config) {
  const threshold = config.toolResultTruncateThresholdChars;
  const previewLimit = config.toolResultPreviewLimitChars;
  const tokenLimit = config.toolResultTokenLimit;

  const tokenEst = simpleTokenEstimate(content);

  if (content.length <= threshold && tokenEst <= tokenLimit) {
    return content;
  }

  const headLen = Math.floor(previewLimit / 2);
  const tailLen = previewLimit - headLen;
  const head = content.slice(0, headLen);
  const tail = content.length > previewLimit ? content.slice(-tailLen) : '';
  const omitted = content.length - previewLimit;
  const omittedTokens = simpleTokenEstimate(content) - simpleTokenEstimate(head + tail);

  return `${head}\n... [已省略 ${omitted} 字符 / 约 ${omittedTokens} token 的工具结果] ...\n${tail}`;
}

// ─── Private: prompt builder ────────────────────────────────────────────────

function _buildSummaryPrompt(chatLog, oldSummary, summaryLimit) {
  if (oldSummary) {
    return (
      '你是一个高度专业的记忆管理器。请根据【前期历史记忆摘要】和最新的【追加对话记录】，进行梳理和整合，生成一个全新的、合并后的中文背景记忆摘要。\n' +
      '新的记忆摘要必须完整包含前期和新近的所有关键事实：\n' +
      '1. 曾经讨论的技术决策和确定的技术方案；\n' +
      '2. 已经修改或创建的代码文件（包含文件名）；\n' +
      '3. 当前遗留、尚在排查的 Bug 或者是未完工的待办开发任务；\n' +
      '4. 用户当前正在进行的最终目标。\n' +
      '要求：\n' +
      `- 保持极度精炼，整体字数严格控制在 ${summaryLimit} 字以内，千万不要长篇大论。\n` +
      '- 直接输出合并后的摘要内容，不要带废话，也不要带任何 Markdown 标题、说明性前言或结尾词。\n\n' +
      `【前期历史记忆摘要】\n${oldSummary}\n\n` +
      `【追加对话记录】\n${chatLog}\n\n` +
      '全新合并后的记忆摘要：'
    );
  }

  return (
    '你是一个高度专业的记忆管理器。请为以下一段长对话记录生成一个简短、结构清晰的中文背景记忆摘要。\n' +
    '你的摘要需要准确概括：\n' +
    '1. 关键讨论主题和技术决策；\n' +
    '2. 曾经修改或创建的关键代码文件名称；\n' +
    '3. 目前未解决的 Bug、排查中的问题或未完工的待办事项；\n' +
    '4. 用户当前正在进行的目标。\n' +
    '要求：\n' +
    `- 保持极其简练，字数严格控制在 ${summaryLimit} 字以内。\n` +
    '- 不要带任何废话、Markdown标题或介绍，直接输出摘要内容。\n\n' +
    `[对话历史记录]\n${chatLog}\n\n` +
    '记忆摘要：'
  );
}

// ─── Private: LLM call ──────────────────────────────────────────────────────

async function _callSummaryLLM(llmClient, prompt) {
  // Try with optional secondary model support
  const messages = [{ role: 'user', content: prompt }];

  try {
    const response = await llmClient.complete(messages, {
      model: llmClient.secondaryModel || llmClient.model,
      max_tokens: 512,
      temperature: 0.1,
      tool_contract: 'no-tools',
    });

    let summary = String(response.content || '').trim();

    // Clean up LLM artifacts
    summary = summary.replace(/^记忆摘要[：:]\s*/, '');
    summary = summary.replace(/```/g, '').trim();

    return summary;
  } catch (error) {
    throw new Error(`LLM summary call failed: ${error.message}`);
  }
}

// ─── Module exports ────────────────────────────────────────────────────────

module.exports = {
  compress,
  DEFAULTS,
};
