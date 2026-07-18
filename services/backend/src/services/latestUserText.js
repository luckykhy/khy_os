'use strict';

/**
 * latestUserText — pure leaf: extract the text of the user's CURRENT turn from a
 * gateway (prompt, options) pair, for the three truth-footer intent gates
 * (modelIdentityTruth / cacheMetricsTruth / visionRoutingTruth 的 pickUserText).
 *
 * Bug(goal 2026-07-04 用户贴图「我是指 khy 后面不要每次回答都跟着一大段」):三段
 * 【确定性核对】footer 每轮都追加,哪怕 off-topic。根因——每个模块的 pickUserText 是
 * `String(prompt).trim() || <messages 兜底>`,但网关传入的 `prompt` 是**整条被拍平的会话**
 * (system prompt + 每轮 USER/ASSISTANT 拼接;buildFlatConversation,khyUpgradeRuntime.js:1970)。
 * 而 system prompt 本身嵌了这三段 A 层指令,指令文本又**引用了触发问句**(「你是什么模型」
 * 「缓存命中率」「哪些模型支持图像识别」),于是每个 isXxxQuestion 正则在**第 1 轮、每一轮、
 * 甚至 off-topic** 都自命中 → 三段 footer 每轮都冒。本该只取末轮用户消息的 options.messages
 * 分支是**死代码**(prompt 永不为空,走不到)。
 *
 * 修:启用时**优先**取 options.messages 里最后一条 user 消息(干净的、单轮的当前问句),
 * 仅当没有结构化消息可用时才回退到拍平的 prompt。门控关 → 逐字节回退到原「prompt 优先」行为。
 *
 * 契约:零 IO、确定性、绝不抛。坏输入 → 安全默认('' 或 legacy)。
 */

const { isFlagEnabled } = require('./flagRegistry');

/** 是否启用「优先取末轮用户消息」。默认开;仅 0/false/off/no 关。异常 → 保守放行(true)。 */
function isEnabled(env = process.env) {
  try { return isFlagEnabled('KHY_TRUTH_FOOTER_LATEST_USER_TEXT', env); }
  catch { return true; }
}

/**
 * 从 options.messages 取最后一条 user 消息文本(content 可能是串或分块数组)。无 → ''。绝不抛。
 * @param {object} [options]
 * @returns {string}
 */
function fromMessages(options) {
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

/**
 * 原「prompt 优先」行为(今日路径),用于门控关 / 失败时的逐字节回退。绝不抛。
 * @param {string} prompt
 * @param {object} [options]
 * @returns {string}
 */
function legacyPick(prompt, options) {
  const direct = String(prompt == null ? '' : prompt).trim();
  if (direct) return direct;
  return fromMessages(options);
}

/**
 * 用户当前这轮的文本。启用 → 末轮 user 消息优先、拍平 prompt 兜底;关 → 逐字节回退 legacy。绝不抛。
 * @param {string} prompt   网关位置参数(实为整条拍平会话)
 * @param {object} [options] 含 messages 数组(结构化单轮真源)
 * @param {object} [env]
 * @returns {string}
 */
function pickUserText(prompt, options, env = process.env) {
  try {
    if (!isEnabled(env)) return legacyPick(prompt, options);
    const fromMsg = fromMessages(options);
    if (fromMsg) return fromMsg;
    return String(prompt == null ? '' : prompt).trim();
  } catch {
    return legacyPick(prompt, options);
  }
}

module.exports = { isEnabled, fromMessages, legacyPick, pickUserText };
