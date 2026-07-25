'use strict';

/**
 * msgChannelCore.js — 纯叶子:把一条文本消息按「群机器人 webhook」报文格式,
 * 为钉钉 / 飞书 / 企业微信构造出一个 HTTP 请求描述符(单一真源),内含各平台的加签算法。
 *
 * 诚实边界:khy 自身不提供消息后端。用户需先在对应平台创建「群自定义机器人」,
 * 拿到 webhook URL(以及可选的加签密钥),再由本模块把文本封装成平台报文。
 *
 * 契约:
 *   - 零 IO:不读文件、不发网络、不读时钟。签名所需时间戳由入参 timestampMs 注入
 *     (确定性 → 可被单测精确断言)。
 *   - 绝不抛(fail-soft):非法入参返回 { ok:false, error }。
 *   - env 门控 KHY_MSG,默认开;与 pushNotifyCore.isEnabled 语义一致
 *     (off-words: 0/false/off/no,大小写与空白不敏感)。
 *
 * 各平台加签(来自平台官方文档,本模块只实现,不发明):
 *   - 钉钉  : 可选。sign = urlEncode(base64(HMAC_SHA256(secret, `${timestampMs}\n${secret}`)))
 *             以 `&timestamp=<ms>&sign=<sign>` 追加到 webhook 查询串。
 *   - 飞书  : 可选。sign = base64(HMAC_SHA256(`${timestampSec}\n${secret}`, ""))
 *             随 body 一起以 { timestamp, sign } 提交。
 *   - 企业微信: 群机器人 webhook 无签名(密钥即 URL 中的 key)。
 */

const crypto = require('crypto');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 特性门:KHY_MSG 缺省视为开启。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_MSG;
  const v = String(raw == null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/** 平台元数据:label 用于人话提示,hint 指引用户去哪拿 webhook。 */
const PLATFORMS = {
  dingtalk: {
    label: '钉钉',
    hint: '钉钉群 → 群设置 → 智能群助手 → 添加自定义机器人,复制 Webhook(oapi.dingtalk.com/robot/send?access_token=…);「加签」密钥可选。',
    signable: true,
  },
  feishu: {
    label: '飞书',
    hint: '飞书群 → 设置 → 群机器人 → 添加自定义机器人,复制 Webhook(open.feishu.cn/open-apis/bot/v2/hook/…);「签名校验」密钥可选。',
    signable: true,
  },
  wecom: {
    label: '企业微信',
    hint: '企业微信群 → 右上角 → 群机器人 → 添加,复制 Webhook(qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…);群机器人无需额外加签。',
    signable: false,
  },
};

/** 平台别名归一(lark→feishu,wechat/qywx/weixin→wecom,dingding→dingtalk)。 */
function normalizePlatform(platform) {
  const p = String(platform == null ? '' : platform).trim().toLowerCase();
  if (!p) return null;
  if (p === 'dingtalk' || p === 'dingding' || p === 'ding') return 'dingtalk';
  if (p === 'feishu' || p === 'lark') return 'feishu';
  if (p === 'wecom' || p === 'wechat' || p === 'weixin' || p === 'qywx' || p === 'qywechat') return 'wecom';
  return Object.prototype.hasOwnProperty.call(PLATFORMS, p) ? p : null;
}

/** 平台是否受支持。 */
function isValidPlatform(platform) {
  return normalizePlatform(platform) != null;
}

/**
 * 遮蔽 webhook,用于日志/输出:保留协议+主机,把凭据(access_token / key / hook id / query)打码。
 * 绝不回显完整 token。非法输入返回占位串。
 */
function maskWebhook(url) {
  const raw = String(url == null ? '' : url).trim();
  if (!raw) return '(未配置)';
  let u;
  try {
    u = new URL(raw);
  } catch {
    // 非标准 URL:只留前 8 字符,其余打码
    return raw.length <= 8 ? '****' : `${raw.slice(0, 8)}****`;
  }
  const host = u.host;
  const path = u.pathname || '';
  // 路径尾段(hook id)与查询串(access_token/key)一律打码
  const maskedPath = path.length > 1 ? `${path.replace(/\/[^/]*$/, '/')}****` : path;
  const q = u.search ? '?****' : '';
  return `${u.protocol}//${host}${maskedPath}${q}`;
}

/** 钉钉加签:urlEncode(base64(HMAC_SHA256(secret, `${ms}\n${secret}`)))。 */
function _dingtalkSign(secret, timestampMs) {
  const str = `${timestampMs}\n${secret}`;
  const b64 = crypto.createHmac('sha256', secret).update(str, 'utf8').digest('base64');
  return encodeURIComponent(b64);
}

/** 飞书加签:base64(HMAC_SHA256(`${sec}\n${secret}`, ""))。key 是时间戳拼密钥,数据体为空串。 */
function _feishuSign(secret, timestampSec) {
  const key = `${timestampSec}\n${secret}`;
  return crypto.createHmac('sha256', key).update('', 'utf8').digest('base64');
}

/**
 * 构造发送请求描述符。
 * @param {{platform:string, webhook:string, secret?:string, text:string, timestampMs?:number}} input
 * @returns {{ok:true, platform:string, request:{url:string, method:string, headers:object, body:string}}
 *          |{ok:false, error:string}}
 */
function buildSendRequest(input = {}) {
  const platform = normalizePlatform(input.platform);
  if (!platform) {
    return { ok: false, error: `不支持的平台。可选:${Object.keys(PLATFORMS).join(' / ')}。` };
  }

  const webhook = String(input.webhook == null ? '' : input.webhook).trim();
  if (!/^https?:\/\//i.test(webhook)) {
    return { ok: false, error: '需要完整的 webhook URL(以 http(s):// 开头)。' };
  }

  const text = String(input.text == null ? '' : input.text);
  if (!text.trim()) {
    return { ok: false, error: '消息内容不能为空。' };
  }

  const secret = input.secret ? String(input.secret).trim() : '';
  const tsMs = Number.isFinite(input.timestampMs) ? Math.floor(input.timestampMs) : null;
  const headers = { 'Content-Type': 'application/json' };

  if (platform === 'dingtalk') {
    let url = webhook;
    if (secret) {
      if (tsMs == null) return { ok: false, error: '钉钉加签需要提供 timestampMs。' };
      const sign = _dingtalkSign(secret, tsMs);
      url += `${url.includes('?') ? '&' : '?'}timestamp=${tsMs}&sign=${sign}`;
    }
    const body = JSON.stringify({ msgtype: 'text', text: { content: text } });
    return { ok: true, platform, request: { url, method: 'POST', headers, body } };
  }

  if (platform === 'feishu') {
    const payload = { msg_type: 'text', content: { text } };
    if (secret) {
      if (tsMs == null) return { ok: false, error: '飞书签名校验需要提供 timestampMs。' };
      const tsSec = Math.floor(tsMs / 1000);
      payload.timestamp = String(tsSec);
      payload.sign = _feishuSign(secret, tsSec);
    }
    return { ok: true, platform, request: { url: webhook, method: 'POST', headers, body: JSON.stringify(payload) } };
  }

  // wecom：群机器人无签名
  const body = JSON.stringify({ msgtype: 'text', text: { content: text } });
  return { ok: true, platform, request: { url: webhook, method: 'POST', headers, body } };
}

/** 供 CLI/工具输出的平台清单(label + hint)。 */
function describePlatforms() {
  return Object.keys(PLATFORMS).map((key) => ({
    platform: key,
    label: PLATFORMS[key].label,
    hint: PLATFORMS[key].hint,
    signable: PLATFORMS[key].signable,
  }));
}

module.exports = {
  PLATFORMS,
  isEnabled,
  normalizePlatform,
  isValidPlatform,
  maskWebhook,
  buildSendRequest,
  describePlatforms,
  // 供内部/测试引用的签名原语
  _dingtalkSign,
  _feishuSign,
};
