'use strict';

/**
 * ilinkProtocol.js — 微信 ilink 协议的常量叶子(零 IO、冻结值、可单测)。
 *
 * 只放「报文里的字段取值」这一类协议常量,不含任何函数。宿主 ilinkCore 与
 * 各纯函数叶子(codec / sendPolicy)都 require 这里,从而共享同一引用——
 * 这是单向依赖(叶子 → 常量),不构成回边。
 *
 * @module services/messaging/ilinkProtocol
 */

const PLATFORM = 'ilink';
const PLATFORM_LABEL = '微信(个人号)';

/** 信道插件版本。出站报文与 getuploadurl 的 base_info 都带,缺了发不出。协议常量,非域名/端口。 */
const CHANNEL_VERSION = '1.0.0';

/** 消息方向。入站只处理 USER,BOT 是自己发的回声,必须丢弃。 */
const MESSAGE_TYPE = { USER: 1, BOT: 2 };
/** item_list 项类型。 */
const ITEM_TYPE = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
/** 出站一律 FINISH——本通道不做流式(微信端不渲染增量)。 */
const MESSAGE_STATE = { NEW: 0, GENERATING: 1, FINISH: 2 };

/** getupdates 的会话过期错误码:需要重新扫码,轮询应长暂停而非快速重试。 */
const RET_SESSION_EXPIRED = -14;

/** 分片时,若最后一个换行落在 maxLen 的这个比例之前,就放弃「按行切」改硬切。 */
const SPLIT_NEWLINE_MIN_RATIO = 0.3;

/** 出站重试退避的封顶,避免指数涨到分钟级把回复拖得毫无意义。 */
const SEND_BACKOFF_MAX_MS = 8000;

module.exports = {
  PLATFORM,
  PLATFORM_LABEL,
  CHANNEL_VERSION,
  MESSAGE_TYPE,
  ITEM_TYPE,
  MESSAGE_STATE,
  RET_SESSION_EXPIRED,
  SPLIT_NEWLINE_MIN_RATIO,
  SEND_BACKOFF_MAX_MS,
};
