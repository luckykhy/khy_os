'use strict';

/**
 * msgReplyBridge.js — 把「入站消息 → khy AI 回答 → 回发给用户」的回路接通(闭合双向环)。
 *
 * 背景:messageRouter 收到渠道 emit 的 'message' 后,只有在设置了 AI handler 时才会把
 * 回复经 channel.sendReply / sendMessage 发回原会话。此前无人调用 setAIHandler,故入站消息
 * 被解析后即丢弃(见 routes/webhooks.js 旧「诚实边界」)。本桥梁提供一个 AI 回复 handler,
 * 把收到的文本当作 prompt 交给 khy 的 chat 内核(经 aiChatPort 这个 IoC seam),再把回答
 * 交回 messageRouter 发回用户所在平台(钉钉 sessionWebhook / 飞书·企业微信群 webhook)。
 *
 * 契约:
 *   - fail-soft:chat 未注册(headless / backend-server 未加载 CLI ai)、文本为空、chat 抛错,
 *     一律返回 null(= 不回复),绝不抛、绝不拖垮入站处理。
 *   - 零硬依赖:chat 解析器可经 deps.getChat 注入,默认取 aiChatPort.getAiChat()(离线可单测)。
 *   - env 门控 KHY_MSG_AUTOREPLY,默认开(与 msgChannelCore.isEnabled 同语义:0/false/off/no 关);
 *     直接读 env 不经 flagRegistry,与 KHY_MSG 一致(避免碰近顶的 flag 注册表)。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 自动回复门:KHY_MSG_AUTOREPLY 缺省视为开启。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isAutoReplyEnabled(env = process.env) {
  const raw = env && env.KHY_MSG_AUTOREPLY;
  const v = String(raw == null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 把 chat 内核的返回值归一成「非空回复文本」或 null。
 * chat 可能返回字符串,或 { text | content | reply | message | output } 形状的对象。
 * @param {*} out
 * @returns {string|null}
 */
function _normalizeReply(out) {
  if (out == null) return null;
  let text = null;
  if (typeof out === 'string') {
    text = out;
  } else if (typeof out === 'object') {
    text = out.text || out.content || out.reply || out.message || out.output || null;
  }
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed.length ? trimmed : null;
}

/**
 * 构造一个 messageRouter 用的 AI 回复 handler。
 * @param {object} [deps]
 * @param {() => (Function|null)} [deps.getChat] - 返回 chat(prompt, opts) 或 null;默认 aiChatPort.getAiChat
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {{warn:Function}} [deps.log]
 * @returns {(msg: {text?:string, userId?:string, channelId?:string, channelName?:string}) => Promise<string|null>}
 */
function buildAiReplyHandler(deps = {}) {
  const env = deps.env || process.env;
  const log = deps.log || require('../../utils/logger');
  const getChat = typeof deps.getChat === 'function'
    ? deps.getChat
    : () => require('../aiChatPort').getAiChat();
  let _warnedNoChat = false;

  return async function aiReplyHandler(msg = {}) {
    if (!isAutoReplyEnabled(env)) return null;
    const text = msg && typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!text) return null;

    let chat;
    try {
      chat = getChat();
    } catch {
      chat = null;
    }
    if (typeof chat !== 'function') {
      if (!_warnedNoChat) {
        _warnedNoChat = true;
        log.warn('msg auto-reply: no AI chat registered (headless?); inbound messages parsed but not answered');
      }
      return null;
    }

    try {
      const out = await chat(text, {
        source: 'msg',
        channelName: msg.channelName || '',
        userId: msg.userId || '',
      });
      return _normalizeReply(out);
    } catch (err) {
      log.warn(`msg auto-reply chat failed: ${(err && err.message) || err}`);
      return null;
    }
  };
}

/**
 * 把 AI 回复 handler 接到 messageRouter(仅在门开启且尚未设置 handler 时)。
 * @param {import('../channels/messageRouter').MessageRouter} router
 * @param {object} [deps] - 透传给 buildAiReplyHandler,并可 deps.env 控门
 * @returns {boolean} 是否完成接线
 */
function wireReplyBridge(router, deps = {}) {
  if (!router || typeof router.setAIHandler !== 'function') return false;
  const env = deps.env || process.env;
  if (!isAutoReplyEnabled(env)) return false;
  // 不覆盖既有 handler(某处已显式接线时尊重之)。
  if (router._aiHandler) return false;
  router.setAIHandler(buildAiReplyHandler(deps));
  return true;
}

module.exports = {
  isAutoReplyEnabled,
  buildAiReplyHandler,
  wireReplyBridge,
  _normalizeReply,
};
