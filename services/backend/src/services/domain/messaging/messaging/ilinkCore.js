'use strict';

/**
 * ilinkCore.js — 微信 ilink bot 协议的纯叶子(零 IO、确定性、可单测)。
 *
 * 只做「报文 ↔ 结构」的翻译与纯策略判定,不碰网络、不碰磁盘、不读 env(除门控)。
 * 所有 HTTP 由 ilinkApi 负责,凭据由 ilinkAccountStore 负责。
 *
 * 要点:
 *   - 平台键是 **'ilink'**,不是 'wechat'/'weixin'——后者已被 msgChannelCore
 *     .normalizePlatform 别名到 wecom(企业微信),同名会静默串配置。
 *   - 入站去重只认 `message_id`。**不要**用 `${from_user_id}-${context_token}` 做
 *     key:若 context_token 在一轮会话内稳定而非每条唯一,会静默吞掉后续消息。
 *   - `item_list` 里文本项全部拼接(用户一条消息可能被拆成多项)。
 *   - 图片 CDN 字段有新旧两种形态,都要认(见 getImageCdnData)。
 *
 * 契约:纯叶子,**绝不抛**。
 *
 * 本文件已收敛为「宿主 + 三个纯叶子」:协议常量在 ilinkProtocol,报文编解码在
 * ilinkMessageCodec,轮询/出站/审批策略在 ilinkSendPolicy。这里只保留 env 门控
 * 与凭据遮蔽/域名信任三func,并按原样再导出叶子的全部符号以保持公共面逐字节不变。
 *
 * @module services/messaging/ilinkCore
 */

const {
  PLATFORM,
  PLATFORM_LABEL,
  CHANNEL_VERSION,
  MESSAGE_TYPE,
  ITEM_TYPE,
  MESSAGE_STATE,
  RET_SESSION_EXPIRED,
  SEND_BACKOFF_MAX_MS,
} = require('./ilinkProtocol');

const {
  buildCdnUrl,
  detectImageMime,
  getImageCdnData,
  extractText,
  extractImageRefs,
  describeUnsupportedItems,
  parseInboundMessage,
  buildClientId,
  buildTextItems,
  buildImageItems,
  buildFileItems,
  buildOutboundMessage,
  splitMessage,
} = require('./ilinkMessageCodec');

const {
  decideBackoffMs,
  isSessionExpired,
  createDedupe,
  parsePermissionReply,
  parseSlashCommand,
  isRetryableSendError,
  sendBackoffMs,
  formatPermissionPrompt,
} = require('./ilinkSendPolicy');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 通道总门:与 msgChannelCore.isEnabled 同语义(KHY_MSG,缺省开)。
 * 直接读 env 而不过 flagRegistry,与既有 messaging 子系统保持一致。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_MSG;
  const v = String(raw == null ? 'true' : raw)
    .trim()
    .toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 遮蔽 bot_token 等长期凭据,用于日志与 `khy wx status`。
 * 绝不回显完整值:只留前 4 后 4。
 * @param {string} token
 * @returns {string}
 */
function maskToken(token) {
  const s = String(token == null ? '' : token).trim();
  if (!s) {
    return '(未配置)';
  }
  if (s.length <= 12) {
    return `${s.slice(0, 2)}***${s.slice(-2)}`;
  }
  return `${s.slice(0, 4)}...${s.slice(-4)}(${s.length}字符)`;
}

/**
 * 校验 baseUrl 是否可信。扫码应答里的 `baseurl` 由服务端下发,**不可盲信**——
 * 只接受 https + 白名单域名,否则调用方应回落到默认值。
 * @param {string} baseUrl
 * @param {string[]} allowedHosts
 * @returns {boolean}
 */
function isTrustedBaseUrl(baseUrl, allowedHosts) {
  const hosts = Array.isArray(allowedHosts) ? allowedHosts : [];
  try {
    const u = new URL(String(baseUrl));
    if (u.protocol !== 'https:') {
      return false;
    }
    return hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

module.exports = {
  PLATFORM,
  PLATFORM_LABEL,
  CHANNEL_VERSION,
  MESSAGE_TYPE,
  ITEM_TYPE,
  MESSAGE_STATE,
  RET_SESSION_EXPIRED,
  isEnabled,
  maskToken,
  isTrustedBaseUrl,
  buildCdnUrl,
  detectImageMime,
  getImageCdnData,
  extractText,
  extractImageRefs,
  describeUnsupportedItems,
  parseInboundMessage,
  buildClientId,
  buildTextItems,
  buildImageItems,
  buildFileItems,
  buildOutboundMessage,
  splitMessage,
  decideBackoffMs,
  isSessionExpired,
  createDedupe,
  parsePermissionReply,
  parseSlashCommand,
  formatPermissionPrompt,
  SEND_BACKOFF_MAX_MS,
  isRetryableSendError,
  sendBackoffMs,
};
