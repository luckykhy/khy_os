'use strict';

/**
 * pickUserTextSafe.js — 「安全取最新用户文本」共享 helper(非纯·读 process.env)。
 *
 * 收敛 2 处 body 逐字节相同的私有 `pickUserText(prompt, options)`——
 *   services/cacheMetricsTruth·services/visionRoutingTruth。
 * 两者都是「优先委托 latestUserText.pickUserText,异常时内联兜底扫 messages」的
 *   同一 fail-soft 包装器。
 *
 * 语义:先试 latestUserText.pickUserText(prompt, options, process.env);任何异常
 *   → 内联兜底(prompt 直取 → 倒序扫 options.messages 里最后一条 user 文本)·**绝不抛**。
 *
 * 契约:非纯(读 process.env·委托 latestUserText)·fail-soft 绝不抛·不 mutate 入参。
 *   各消费方保留同名本地 `const pickUserText = require('../utils/pickUserTextSafe')`
 *   → 调用点/导出逐字节不变。
 */

function pickUserText(prompt, options) {
  try {
    return require('../services/latestUserText').pickUserText(prompt, options, process.env);
  } catch {
    const direct = String(prompt == null ? '' : prompt).trim();
    if (direct) return direct;
    try {
      const msgs = options && Array.isArray(options.messages) ? options.messages : [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m || m.role !== 'user') continue;
        if (typeof m.content === 'string') return m.content.trim();
        if (Array.isArray(m.content)) {
          const parts = m.content
            .map((p) => (typeof p === 'string' ? p : (p && (p.text || p.content) || '')))
            .filter(Boolean);
          if (parts.length) return parts.join(' ').trim();
        }
      }
    } catch { /* fail-soft */ }
    return '';
  }
}

module.exports = pickUserText;
