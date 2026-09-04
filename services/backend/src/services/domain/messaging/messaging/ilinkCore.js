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
 * @module services/messaging/ilinkCore
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

/**
 * 轮询失败后的退避时长。
 * @param {number} consecutiveFailures
 * @param {object} cfg { shortMs, longMs, threshold }
 * @returns {number} 毫秒
 */
function decideBackoffMs(consecutiveFailures, cfg = {}) {
  const n = Number(consecutiveFailures) || 0;
  const threshold = Number(cfg.threshold) || 3;
  const shortMs = Number(cfg.shortMs) || 3000;
  const longMs = Number(cfg.longMs) || 30000;
  return n >= threshold ? longMs : shortMs;
}

/** getupdates 应答是否表示「会话已过期,需重新扫码」。 */
function isSessionExpired(resp) {
  return !!resp && resp.ret === RET_SESSION_EXPIRED;
}

/**
 * 入站去重器。只认 message_id;容量满时淘汰最旧的一半(Set 按插入序迭代)。
 * 有状态但零 IO,可单测。
 * @param {number} max
 */
function createDedupe(max) {
  const cap = Number(max) > 0 ? Number(max) : 1000;
  const seen = new Set();
  return {
    /**
     * @param {number|null} messageId
     * @returns {boolean} true = 是新消息(应处理);false = 重复(应跳过)
     */
    accept(messageId) {
      // 没有 message_id 的报文无法去重,一律放行(宁可重复也不丢)。
      if (messageId == null) {
        return true;
      }
      if (seen.has(messageId)) {
        return false;
      }
      seen.add(messageId);
      if (seen.size > cap) {
        const drop = [];
        const it = seen.values();
        for (let i = 0; i < Math.floor(cap / 2); i++) {
          const { value, done } = it.next();
          if (done) {
            break;
          }
          drop.push(value);
        }
        for (const v of drop) {
          seen.delete(v);
        }
      }
      return true;
    },
    size() {
      return seen.size;
    },
  };
}

/**
 * 判定一条文本是否是权限审批回复。
 * 兼容中英文与常见变体;不匹配返回 null。
 * @param {string} text
 * @returns {'allow'|'deny'|null}
 */
function parsePermissionReply(text) {
  const t = String(text == null ? '' : text)
    .trim()
    .toLowerCase()
    .replace(/[。．.!!]+$/, '');
  if (!t) {
    return null;
  }
  if (t === 'y' || t === 'yes' || t === '是' || t === '好' || t === '允许' || t === '同意') {
    return 'allow';
  }
  if (t === 'n' || t === 'no' || t === '否' || t === '不' || t === '拒绝' || t === '不允许') {
    return 'deny';
  }
  return null;
}

/**
 * 解析斜杠命令。整个剩余部分作为一个原始 args 串(不做分词/引号处理)。
 * @param {string} text
 * @returns {{cmd:string, args:string}|null}
 */
function parseSlashCommand(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t.startsWith('/')) {
    return null;
  }
  const sp = t.indexOf(' ');
  const cmd = (sp === -1 ? t.slice(1) : t.slice(1, sp)).toLowerCase();
  if (!cmd) {
    return null;
  }
  const args = sp === -1 ? '' : t.slice(sp + 1).trim();
  return { cmd, args };
}

/** 出站重试退避的封顶,避免指数涨到分钟级把回复拖得毫无意义。 */
const SEND_BACKOFF_MAX_MS = 8000;

/**
 * 这次出站失败值不值得重试。
 *
 * 分类语义与 msgSender._isRetryable 一致(瞬时故障重试、永久错立即放弃),但判据取
 * **结构化字段**而非正则猜消息:ilinkApi 会在抛出的错误上带 `status` / `isTimeout`。
 *   可重试:传输层错(无 status)、超时、429、5xx
 *   不重试:4xx(除 429)—— 报文/鉴权问题,重发多少次都一样,只会拖慢并刷日志
 *
 * @param {{status?:number, isTimeout?:boolean}} err
 * @returns {boolean}
 */
function isRetryableSendError(err) {
  if (!err) {
    return false;
  }
  if (err.isTimeout) {
    return true;
  }
  const status = Number(err.status);
  if (!Number.isFinite(status)) {
    return true;
  } // 传输层错(网络断/DNS/连接重置)
  if (status === 429) {
    return true;
  }
  return status >= 500 && status <= 599;
}

/**
 * 第 attempt 次重试(从 1 起)的退避毫秒:base·2^(attempt-1),封顶 SEND_BACKOFF_MAX_MS。
 * @param {number} attempt
 * @param {number} baseMs
 * @returns {number}
 */
function sendBackoffMs(attempt, baseMs) {
  const b = Number(baseMs) > 0 ? Number(baseMs) : 800;
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(b * 2 ** (n - 1), SEND_BACKOFF_MAX_MS);
}

/**
 * 把权限审批请求渲染成一条微信看得懂的中文提示。
 *
 * 为什么要自己渲染:本地终端那套审批 UI 是 console.log 到 stdout 的,在守护进程里只会
 * 进日志文件、到不了微信。permissionPromptPort 给的是结构化的 (toolName, params, ...),
 * 所以这里负责把它变成一句人能判断的话。
 *
 * 参数值一律截断:params 里可能是整个文件内容,原样发出去既刷屏又可能泄漏敏感内容。
 *
 * @param {object} info { toolName, params, riskInfo, reasoning }
 * @param {number} [maxValueLen] 单个参数值的展示上限
 * @returns {string}
 */
function formatPermissionPrompt(info, maxValueLen = 200) {
  const i = info || {};
  const tool = String(i.toolName || '未知工具');
  const lines = [`🔐 需要你授权执行:${tool}`];

  const risk = i.riskInfo && (i.riskInfo.level || i.riskInfo.risk);
  if (risk) {
    lines.push(`风险等级:${risk}`);
  }

  const params = i.params && typeof i.params === 'object' ? i.params : {};
  // 优先展示最能说明「要动什么」的字段,其余按原序补上。
  const preferred = ['command', 'file_path', 'filePath', 'path', 'url', 'pattern'];
  const keys = Object.keys(params).filter(
    (k) => !k.startsWith('_') && k !== 'explanation' && k !== 'diffPreview'
  );
  keys.sort((a, b) => {
    const ia = preferred.indexOf(a);
    const ib = preferred.indexOf(b);
    if (ia === -1 && ib === -1) {
      return 0;
    }
    if (ia === -1) {
      return 1;
    }
    if (ib === -1) {
      return -1;
    }
    return ia - ib;
  });
  for (const k of keys.slice(0, 6)) {
    let v = params[k];
    if (v && typeof v === 'object') {
      try {
        v = JSON.stringify(v);
      } catch {
        v = '[对象]';
      }
    }
    v = String(v == null ? '' : v);
    if (v.length > maxValueLen) {
      v = `${v.slice(0, maxValueLen)}…(共 ${v.length} 字符)`;
    }
    lines.push(`· ${k}: ${v}`);
  }

  const reasoning = i.reasoning ? String(i.reasoning) : '';
  if (reasoning) {
    lines.push(
      `💭 ${reasoning.length > maxValueLen ? `${reasoning.slice(0, maxValueLen)}…` : reasoning}`
    );
  }

  lines.push('');
  lines.push('回复 y 允许,n 拒绝。超时会自动拒绝。');
  return lines.join('\n');
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
