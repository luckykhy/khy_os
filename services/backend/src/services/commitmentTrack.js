'use strict';

/**
 * commitmentTrack.js — CommitmentTracker 的薄壳接线(单一真源壳)。
 *
 * 背景:commitmentTracker.js(类)是纯叶子——完整实现承诺提取/去重/生命周期,但从未有任何生产代码
 * require 它(孤儿,仅自测)。本壳把三件事接起来,且**不改变 commitmentTracker 的行为**:
 *   1. gateway:用 aiChatPort.getAiChat()(CLI 加载时自注册)适配成 `{generate(prompt, opts)}` 形状;
 *      无 chat(backend-server / headless / 单测)→ gateway=null → enqueueExtraction 立即返回 false。
 *   2. onCommitmentDue:空实现(只记录,绝不执行任何操作——承诺是提醒数据,操作仍走审批)。
 *   3. 进程级单例:repl / CLI 命令消费同一个 tracker,承诺生命周期可跨调用观测。
 *
 * 门控 KHY_COMMITMENT(默认开):关 → enqueueExtraction 恒 false、list/cleanup 返回空 → 逐字节回退
 * (与"从未接线"等价)。内存态不持久化(与 commitmentTracker 原设计一致)。
 *
 * 契约:零业务 require(只经 aiChatPort IoC seam)、绝不抛(单测/无 chat 环境下 fail-soft)。
 */

const { CommitmentTracker } = require('./commitmentTracker');

const _FALSY = ['0', 'false', 'off', 'no'];

/** KHY_COMMITMENT 门控(默认开)。 */
function commitmentEnabled(env = process.env) {
  const v = String(env && env.KHY_COMMITMENT == null ? 'true' : env && env.KHY_COMMITMENT)
    .trim()
    .toLowerCase();
  return !_FALSY.includes(v);
}

/** 用 aiChatPort 的 chat() 适配成 gateway.generate 形状。无 chat → null。 */
function _buildGateway() {
  try {
    const port = require('./aiChatPort');
    const chat = typeof port.getAiChat === 'function' ? port.getAiChat() : null;
    if (typeof chat !== 'function') {
      return null;
    }
    return {
      generate: async (prompt, opts = {}) => {
        try {
          const out = await chat(prompt, { _isFollowUp: true, effort: 'high', ...opts });
          return { success: true, content: (out && (out.reply || out.text || out.content)) || '' };
        } catch (err) {
          return { success: false, error: (err && err.message) || String(err) };
        }
      },
    };
  } catch {
    return null;
  }
}

let _tracker = null;

/** 进程级单例 tracker(惰性)。 */
function getTracker() {
  if (_tracker) {
    return _tracker;
  }
  _tracker = new CommitmentTracker({
    gateway: _buildGateway(),
    logger: (() => {
      try {
        return require('../utils/logger');
      } catch {
        return console;
      }
    })(),
    onCommitmentDue: () => {
      /* 只提醒不执行:承诺提醒数据,实际动作仍走审批 */
    },
  });
  return _tracker;
}

/**
 * 入队一次承诺提取(对话后处理入口)。
 * @param {{userText:string, assistantText:string, agentId?:string, sessionId?:string}} input
 * @returns {boolean} 是否入队
 */
function trackCommitment(input = {}) {
  if (!commitmentEnabled()) {
    return false;
  }
  try {
    const tracker = getTracker();
    if (!tracker || typeof tracker.enqueueExtraction !== 'function') {
      return false;
    }
    return !!tracker.enqueueExtraction({
      userText: input.userText,
      assistantText: input.assistantText,
      agentId: input.agentId || '',
      sessionId: input.sessionId || '',
    });
  } catch {
    return false;
  }
}

/**
 * 列出当前承诺(命令入口数据)。
 * @param {object} [filter]
 * @returns {Array<object>}
 */
function listCommitments(filter = {}) {
  if (!commitmentEnabled()) {
    return [];
  }
  try {
    const tracker = getTracker();
    if (!tracker || typeof tracker.getAll !== 'function') {
      return [];
    }
    return tracker.getAll(filter || {});
  } catch {
    return [];
  }
}

/** 标记承诺已发。 */
function markSent(id) {
  try {
    const tracker = getTracker();
    if (tracker && typeof tracker.markSent === 'function' && id) {
      tracker.markSent(id);
    }
  } catch {
    /* best-effort */
  }
}

/** 忽略(驳回)一条承诺。 */
function dismiss(id) {
  try {
    const tracker = getTracker();
    if (tracker && typeof tracker.dismiss === 'function' && id) {
      tracker.dismiss(id);
    }
  } catch {
    /* best-effort */
  }
}

/** 清理过期承诺,返回过期数。 */
function expireOld() {
  try {
    const tracker = getTracker();
    if (!tracker || typeof tracker.expireOld !== 'function') {
      return 0;
    }
    return tracker.expireOld();
  } catch {
    return 0;
  }
}

/** 测试/诊断:重置单例(清理内部 debounce timer,避免挂住 jest)。 */
function _resetForTest() {
  try {
    if (_tracker && _tracker._debounceTimer) {
      clearTimeout(_tracker._debounceTimer);
      _tracker._debounceTimer = null;
    }
  } catch {
    /* best-effort */
  }
  _tracker = null;
}

/**
 * 测试/诊断:立即排空提取队列(内部 debounce timer 在单测中会挂住 jest)。
 * @returns {Promise<number>} 处理了多少条
 */
async function _flushForTest() {
  try {
    const tracker = getTracker();
    if (!tracker || typeof tracker._drainQueue !== 'function') {
      return 0;
    }
    const before = (tracker._queue || []).length;
    await tracker._drainQueue();
    return before;
  } catch {
    return 0;
  }
}

module.exports = {
  commitmentEnabled,
  trackCommitment,
  listCommitments,
  markSent,
  dismiss,
  expireOld,
  getTracker,
  _resetForTest,
  _flushForTest,
};
