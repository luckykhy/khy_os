'use strict';

/**
 * LocalMemoryRecall — 让模型主动按需召回本地记忆库(对齐 Claude Code 的记忆工具)。
 *
 * khy 此前只在拼提示词时**被动**注入相关记忆;模型无法在对话中途「想起来去翻一下」。
 * 本工具补上主动召回:模型给一个查询,返回最相关的记忆条目(排序 + 正文预览)。
 *
 * 只读,绝不写记忆(写入走 /remember 与既有写安全层)。排序/读盘复用 memdir 单一真源
 * (selectRelevantMemories / searchMemories),整形/门控在纯叶子 localMemoryRecall。
 */

const { defineTool } = require('./_baseTool');

module.exports = defineTool({
  name: 'LocalMemoryRecall',
  description:
    'Recall relevant memories from the local memory store on demand (Claude Code-aligned). '
    + 'Give a query; returns the most relevant remembered facts (ranked, with body previews). '
    + 'Read-only. Use mode="search" for literal substring matching, mode="relevant" (default) for ranked recall.',
  category: 'system',
  risk: 'low',
  aliases: ['recall', 'memoryRecall', 'localMemoryRecall'],
  isReadOnly: () => true,
  isConcurrencySafe: true,
  inputSchema: {
    query: {
      type: 'string',
      required: true,
      description: 'What to recall (a topic, keyword, or question). Chinese or English.',
    },
    limit: {
      type: 'number',
      required: false,
      description: 'Max memories to return (default 5, capped at 20).',
    },
    mode: {
      type: 'string',
      required: false,
      enum: ['relevant', 'search'],
      description: 'relevant = ranked recall (default); search = literal substring match.',
    },
  },
  async execute(params, _context) {
    const leaf = require('../services/localMemoryRecall');
    if (!leaf.isEnabled()) {
      return { success: false, error: 'Local memory recall is disabled (KHY_MEMORY_RECALL_TOOL=off or memory disabled).' };
    }
    const query = String((params && params.query) || '').trim();
    if (!query) return { success: false, error: 'query is required.' };

    let memdir;
    try {
      memdir = require('../memdir');
    } catch (e) {
      return { success: false, error: 'memory store unavailable: ' + ((e && e.message) || e) };
    }

    try {
      const mode = String((params && params.mode) || 'relevant').toLowerCase();
      const limit = leaf.normalizeLimit(params && params.limit);

      if (mode === 'search') {
        const raw = memdir.searchMemories(query) || [];
        const memories = leaf.shapeSearch(raw).slice(0, limit);
        return {
          success: true,
          data: { mode, query, count: memories.length, summary: leaf.buildRecallSummary(query, memories), memories },
        };
      }

      const raw = memdir.selectRelevantMemories(query, { limit }) || [];
      const memories = leaf.shapeRelevant(raw);
      return {
        success: true,
        data: { mode: 'relevant', query, count: memories.length, summary: leaf.buildRecallSummary(query, memories), memories },
      };
    } catch (err) {
      return { success: false, error: (err && err.message) || String(err) };
    }
  },
});
