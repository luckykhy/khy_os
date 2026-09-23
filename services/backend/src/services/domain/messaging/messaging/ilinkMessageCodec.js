'use strict';

/**
 * ilinkMessageCodec.js — 微信 ilink 报文编解码的纯函数叶子(零 IO、确定性、绝不抛)。
 *
 * 覆盖两个方向:
 *   入站:buildCdnUrl / detectImageMime / getImageCdnData / extractText /
 *         extractImageRefs / describeUnsupportedItems / parseInboundMessage
 *   出站:buildClientId / buildTextItems / buildImageItems / buildFileItems /
 *         buildOutboundMessage / splitMessage
 *
 * 协议常量从 ilinkProtocol 取(单向依赖,不回边宿主)。
 *
 * @module services/messaging/ilinkMessageCodec
 */

const {
  CHANNEL_VERSION,
  MESSAGE_TYPE,
  ITEM_TYPE,
  MESSAGE_STATE,
  SPLIT_NEWLINE_MIN_RATIO,
} = require('./ilinkProtocol');

/**
 * CDN 下载地址。`encrypt_query_param` 直接拼进 query,故必须限定字符集,
 * 防止注入额外参数或路径。
 * @param {string} encryptQueryParam
 * @param {string} cdnBaseUrl
 * @returns {{ok:true,url:string}|{ok:false,error:string}}
 */
function buildCdnUrl(encryptQueryParam, cdnBaseUrl) {
  const q = String(encryptQueryParam == null ? '' : encryptQueryParam);
  if (!q) {
    return { ok: false, error: 'encrypt_query_param 为空' };
  }
  if (!/^[A-Za-z0-9%=&+._~-]+$/.test(q)) {
    return { ok: false, error: 'encrypt_query_param 含非法字符' };
  }
  return { ok: true, url: `${String(cdnBaseUrl).replace(/\/+$/, '')}?${q}` };
}

/**
 * 按 magic bytes 嗅探图片 MIME(不信扩展名/服务端声明)。
 * @param {Buffer} data
 * @returns {string}
 */
function detectImageMime(data) {
  if (!data || data.length < 4) {
    return 'application/octet-stream';
  }
  if (data[0] === 0x89 && data[1] === 0x50) {
    return 'image/png';
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (data[0] === 0x47 && data[1] === 0x49) {
    return 'image/gif';
  }
  if (data[0] === 0x52 && data[1] === 0x49) {
    return 'image/webp';
  }
  if (data[0] === 0x42 && data[1] === 0x4d) {
    return 'image/bmp';
  }
  return 'image/jpeg';
}

/**
 * 从 image_item 取出 CDN 凭据。两种历史形态都要认:
 *   旧:cdn_media.{aes_key, encrypt_query_param}
 *   新:aeskey + media.encrypt_query_param
 * @param {object} imageItem
 * @returns {{aesKey:string, encryptQueryParam:string}|null}
 */
function getImageCdnData(imageItem) {
  if (!imageItem || typeof imageItem !== 'object') {
    return null;
  }
  const cm = imageItem.cdn_media;
  if (cm && cm.aes_key && cm.encrypt_query_param) {
    return { aesKey: String(cm.aes_key), encryptQueryParam: String(cm.encrypt_query_param) };
  }
  if (imageItem.aeskey && imageItem.media && imageItem.media.encrypt_query_param) {
    return {
      aesKey: String(imageItem.aeskey),
      encryptQueryParam: String(imageItem.media.encrypt_query_param),
    };
  }
  return null;
}

/**
 * 拼接 item_list 里的全部文本项(一条用户消息可能被拆成多项)。
 * 以 `text_item.text` 是否为非空串为判据,而非 `type` 字段——见过 type 缺失的报文。
 * @param {Array} items
 * @returns {string}
 */
function extractText(items) {
  if (!Array.isArray(items)) {
    return '';
  }
  const parts = [];
  for (const item of items) {
    const t = item && item.text_item && item.text_item.text;
    if (typeof t === 'string' && t.length) {
      parts.push(t);
    }
  }
  return parts.join('\n');
}

/**
 * 取出全部图片项的 CDN 凭据(参考实现只取第一张,这里全取)。
 * @param {Array} items
 * @returns {Array<{aesKey:string, encryptQueryParam:string}>}
 */
function extractImageRefs(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  const out = [];
  for (const item of items) {
    if (!item) {
      continue;
    }
    if (item.type !== ITEM_TYPE.IMAGE && !item.image_item) {
      continue;
    }
    const cdn = getImageCdnData(item.image_item);
    if (cdn) {
      out.push(cdn);
    }
  }
  return out;
}

/**
 * 统计入站消息里出现过的非文本/非图片项类型,用于给用户一句诚实的「暂不支持」。
 * @param {Array} items
 * @returns {string[]} 如 ['语音','文件']
 */
function describeUnsupportedItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  const labels = new Set();
  for (const item of items) {
    if (!item) {
      continue;
    }
    if (item.type === ITEM_TYPE.VOICE || item.voice_item) {
      labels.add('语音');
    } else if (item.type === ITEM_TYPE.FILE || item.file_item) {
      labels.add('文件');
    } else if (item.type === ITEM_TYPE.VIDEO || item.video_item) {
      labels.add('视频');
    }
  }
  return Array.from(labels);
}

/**
 * 把一条 getupdates 报文归一成 messageRouter 用的入站结构。
 *
 * 丢弃(返回 null)的情形:非 USER 方向(自己发的回声)、缺 from_user_id、缺 item_list。
 *
 * @param {object} msg 原始报文
 * @returns {{channelId:string, userId:string, text:string, images:Array,
 *            unsupported:string[], threadId:string, messageId:(number|null),
 *            timestamp:number, raw:object}|null}
 */
function parseInboundMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return null;
  }
  // 只处理用户发来的;BOT 方向是自己的回声。type 缺失时按 USER 宽容处理。
  if (msg.message_type != null && msg.message_type !== MESSAGE_TYPE.USER) {
    return null;
  }
  const userId = msg.from_user_id ? String(msg.from_user_id) : '';
  if (!userId) {
    return null;
  }
  if (!Array.isArray(msg.item_list) || msg.item_list.length === 0) {
    return null;
  }

  return {
    // 个人微信是单聊,会话就是这个用户 → channelId 与 userId 同源。
    channelId: userId,
    userId,
    text: extractText(msg.item_list).trim(),
    images: extractImageRefs(msg.item_list),
    unsupported: describeUnsupportedItems(msg.item_list),
    // 回复必须带回同一个 context_token,微信端才能把回答挂到这轮对话上。
    threadId: msg.context_token ? String(msg.context_token) : '',
    messageId: typeof msg.message_id === 'number' ? msg.message_id : null,
    timestamp: typeof msg.create_time_ms === 'number' ? msg.create_time_ms : 0,
    raw: msg,
  };
}

/**
 * 生成出站 client_id(幂等键)。显式传入 now/seq 以保持纯函数可测。
 * @param {number} seq 单调递增序号
 * @param {number} now Date.now()
 * @returns {string}
 */
function buildClientId(seq, now) {
  return `khy-${Number(now) || 0}-${Number(seq) || 0}`;
}

/** 构造纯文本 item_list。 */
function buildTextItems(text) {
  return [{ type: ITEM_TYPE.TEXT, text_item: { text: String(text == null ? '' : text) } }];
}

/**
 * 构造图片 item_list(出站)。按真实协议:image_item.media.{encrypt_query_param,
 * aes_key, encrypt_type:1} + mid_size(明文字节数)。aes_key 用 encodeAesKeyForOutbound 的产物。
 * @param {{encrypt_query_param:string, aes_key:string}} media
 * @param {{rawsize:number}} [meta]
 * @returns {Array}
 */
function buildImageItems(media, { rawsize } = {}) {
  const m = media || {};
  return [
    {
      type: ITEM_TYPE.IMAGE,
      image_item: {
        media: {
          encrypt_query_param: String(m.encrypt_query_param == null ? '' : m.encrypt_query_param),
          aes_key: String(m.aes_key == null ? '' : m.aes_key),
          encrypt_type: 1,
        },
        mid_size: Number(rawsize) || 0,
      },
    },
  ];
}

/**
 * 构造文件 item_list(出站)。按真实协议:file_item.media.{encrypt_query_param,
 * aes_key, encrypt_type:1} + file_name。用 media 而非 cdn_media。
 * 注:参考实现说 file 的 size/md5 填了反而发不出,故暂不填。
 * @param {{encrypt_query_param:string, aes_key:string}} media
 * @param {{fileName:string}} [meta]
 * @returns {Array}
 */
function buildFileItems(media, { fileName } = {}) {
  const m = media || {};
  return [
    {
      type: ITEM_TYPE.FILE,
      file_item: {
        media: {
          encrypt_query_param: String(m.encrypt_query_param == null ? '' : m.encrypt_query_param),
          aes_key: String(m.aes_key == null ? '' : m.aes_key),
          encrypt_type: 1,
        },
        file_name: String(fileName == null ? '' : fileName),
      },
    },
  ];
}

/**
 * 构造 sendmessage 的报文体。
 * from_user_id 固定为空串(机器人发送时真实协议如此);顶层带 base_info.channel_version。
 * @param {object} p
 * @param {string} p.toUserId 对方 ilink_user_id
 * @param {string} p.clientId
 * @param {string} p.contextToken 入站消息的 context_token(原样带回)
 * @param {Array} p.items
 * @returns {{msg:object, base_info:object}}
 */
function buildOutboundMessage({ toUserId, clientId, contextToken, items }) {
  return {
    msg: {
      from_user_id: '',
      to_user_id: String(toUserId || ''),
      client_id: String(clientId || ''),
      message_type: MESSAGE_TYPE.BOT,
      message_state: MESSAGE_STATE.FINISH,
      context_token: String(contextToken || ''),
      item_list: Array.isArray(items) ? items : [],
    },
    base_info: { channel_version: CHANNEL_VERSION },
  };
}

/**
 * 长回复分片。
 *
 * 上限按 UTF-16 码元计(String.length),与服务端一致——CJK 记 1,emoji 记 2。
 * 优先在 <= maxLen 的最后一个换行处切开(读起来自然);若该换行太靠前
 * (< maxLen * 0.3,包含「整段没有换行」的 -1 情形)则硬切,避免产出大量碎片。
 *
 * @param {string} text
 * @param {number} maxLen
 * @returns {string[]} 至少一个元素;空输入返回 []
 */
function splitMessage(text, maxLen) {
  const s = String(text == null ? '' : text);
  const limit = Number(maxLen) > 0 ? Number(maxLen) : 2048;
  if (!s.length) {
    return [];
  }
  if (s.length <= limit) {
    return [s];
  }

  const chunks = [];
  let rest = s;
  while (rest.length > 0) {
    if (rest.length <= limit) {
      chunks.push(rest);
      break;
    }
    let idx = rest.lastIndexOf('\n', limit);
    if (idx < limit * SPLIT_NEWLINE_MIN_RATIO) {
      idx = limit;
    }
    chunks.push(rest.slice(0, idx));
    // 切点是换行时,去掉下一片开头的换行,避免空行堆积。
    rest = rest.slice(idx).replace(/^\n+/, '');
  }
  return chunks;
}

module.exports = {
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
};
