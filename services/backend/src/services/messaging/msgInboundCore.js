'use strict';

/**
 * msgInboundCore.js — 纯叶子:校验并解析钉钉 / 飞书 / 企业微信的「入站回调」报文。
 *
 * 诚实边界:入站接收要真正跑通,需要一个公网可达的回调地址,并在对应平台后台把该地址
 * 填进机器人/事件订阅配置。本模块只负责「拿到一段原始回调 → 验签 → 解出纯文本消息」,
 * 这部分是纯函数,可被单测精确覆盖;而「公网可达 + 平台侧配置」无法在本机端到端验证。
 *
 * 契约:
 *   - 零 IO、crypto 确定性、绝不抛(校验/解析失败返回 { ok:false, error })。
 *
 * 各平台方案(来自平台官方文档):
 *   - 钉钉  : outgoing 机器人在请求头带 timestamp + sign,
 *             sign = base64(HMAC_SHA256(appSecret, `${timestamp}\n${appSecret}`)),同发送侧算法。
 *   - 飞书  : 事件订阅。首次配置回调时发 { type:'url_verification', challenge }(明文或加密);
 *             加密事件 body = { encrypt: <base64> },AES-256-CBC 解密,key = sha256(encryptKey)(32B),
 *             iv = 密文前 16B,去 PKCS7 padding。解出的 JSON 里取 im.message.receive_v1 文本。
 *   - 企业微信: 回调加解密(WXBizMsgCrypt)。
 *             msg_signature = sha1( [token, timestamp, nonce, encrypt].sort().join('') );
 *             AES-256-CBC,key = base64decode(EncodingAESKey + '=')(32B),iv = key[:16],去 padding;
 *             明文布局 = [16B 随机][4B BE 明文长度][明文][receiveid]。
 */

const crypto = require('crypto');

/** 定长安全比较,长度不等直接 false(避免 timingSafeEqual 抛长度错)。 */
function _safeEq(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/** 去 PKCS7 padding,pad 值越界时保守返回原 buffer。 */
function _pkcs7strip(buf) {
  if (!buf || !buf.length) return buf || Buffer.alloc(0);
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32 || pad > buf.length) return buf;
  return buf.slice(0, buf.length - pad);
}

/** 从 XML 里取某个标签内容(优先 CDATA),取不到返回 ''。 */
function _xmlTag(xml, tag) {
  const s = String(xml == null ? '' : xml);
  const re = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`, 'i');
  const m = re.exec(s);
  if (!m) return '';
  return (m[1] != null ? m[1] : m[2] != null ? m[2] : '').trim();
}

// ────────────────────────────── 钉钉 ──────────────────────────────

/** 钉钉签名(与发送侧同算法):base64(HMAC_SHA256(secret, `${timestamp}\n${secret}`))。 */
function dingtalkSign(secret, timestamp) {
  const str = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', String(secret)).update(str, 'utf8').digest('base64');
}

/**
 * 校验钉钉入站请求头签名。
 * @param {{secret:string, timestamp:(string|number), sign:string}} args
 */
function verifyDingtalk(args = {}) {
  const { secret, timestamp, sign } = args;
  if (!secret || timestamp == null || !sign) return false;
  return _safeEq(dingtalkSign(secret, timestamp), sign);
}

/** 解析钉钉 outgoing 机器人消息体,归一为 { platform, userId, text, sessionWebhook, raw }。 */
function parseDingtalk(payload) {
  const p = payload || {};
  const text = p.text && typeof p.text.content === 'string' ? p.text.content.trim() : '';
  return {
    ok: true,
    platform: 'dingtalk',
    userId: p.senderStaffId || p.senderId || p.senderNick || '',
    userName: p.senderNick || '',
    text,
    sessionWebhook: p.sessionWebhook || '',
    raw: p,
  };
}

// ────────────────────────────── 飞书 ──────────────────────────────

/** AES-256-CBC 解密飞书加密事件。key = sha256(encryptKey);iv = 密文前 16B。 */
function feishuDecrypt(encryptB64, encryptKey) {
  if (!encryptB64 || !encryptKey) return { ok: false, error: '飞书解密需要 encrypt 与 encryptKey。' };
  try {
    const key = crypto.createHash('sha256').update(String(encryptKey), 'utf8').digest(); // 32B
    const data = Buffer.from(String(encryptB64), 'base64');
    if (data.length <= 16) return { ok: false, error: '飞书密文长度不足。' };
    const iv = data.slice(0, 16);
    const ct = data.slice(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(false);
    const out = _pkcs7strip(Buffer.concat([decipher.update(ct), decipher.final()]));
    return { ok: true, plaintext: out.toString('utf8') };
  } catch (err) {
    return { ok: false, error: `飞书解密失败:${err && err.message ? err.message : String(err)}` };
  }
}

/**
 * 处理飞书回调 body(已解析为对象),兼容明文事件与加密事件:
 *   - 若含 encrypt 字段且给了 encryptKey → 先解密再解析。
 *   - url_verification 挑战 → { ok:true, challenge }。
 *   - im.message.receive_v1 → 归一消息。
 * @param {object} body
 * @param {{encryptKey?:string, verificationToken?:string}} [opts]
 */
function handleFeishu(body, opts = {}) {
  let evt = body || {};
  // 加密事件:{ encrypt: '...' }
  if (evt && typeof evt.encrypt === 'string') {
    const dec = feishuDecrypt(evt.encrypt, opts.encryptKey);
    if (!dec.ok) return dec;
    try {
      evt = JSON.parse(dec.plaintext);
    } catch (err) {
      return { ok: false, error: `飞书解密后 JSON 解析失败:${err && err.message ? err.message : String(err)}` };
    }
  }

  // 首次回调地址校验(可能是明文或解密后的载荷)
  if (evt && evt.type === 'url_verification') {
    return { ok: true, kind: 'challenge', challenge: evt.challenge, token: evt.token || '' };
  }

  // 可选:校验 verification token(v2 在 header.token,老版在顶层 token)
  if (opts.verificationToken) {
    const token = (evt.header && evt.header.token) || evt.token || '';
    if (!_safeEq(opts.verificationToken, token)) {
      return { ok: false, error: '飞书 verification token 不匹配。' };
    }
  }

  return { ok: true, kind: 'event', message: parseFeishuEvent(evt) };
}

/** 解析飞书 v2 事件为归一消息。 */
function parseFeishuEvent(evt) {
  const e = evt || {};
  const header = e.header || {};
  const eventType = header.event_type || '';
  if (eventType === 'im.message.receive_v1') {
    const msg = (e.event && e.event.message) || {};
    let text = '';
    try {
      const c = JSON.parse(msg.content || '{}');
      text = (c && typeof c.text === 'string' ? c.text : '') || '';
    } catch {
      text = '';
    }
    const sender = (e.event && e.event.sender) || {};
    const senderId = sender.sender_id || {};
    return {
      platform: 'feishu',
      userId: senderId.open_id || senderId.user_id || senderId.union_id || '',
      text: text.trim(),
      messageId: msg.message_id || '',
      chatId: msg.chat_id || '',
      raw: e,
    };
  }
  return { platform: 'feishu', userId: '', text: '', eventType, raw: e };
}

// ──────────────────────────── 企业微信 ────────────────────────────

/** WXBizMsgCrypt 签名:sha1( [token, timestamp, nonce, encrypt].sort().join('') )。 */
function wecomSignature(token, timestamp, nonce, encrypt) {
  const arr = [String(token), String(timestamp), String(nonce), String(encrypt)].sort();
  return crypto.createHash('sha1').update(arr.join(''), 'utf8').digest('hex');
}

/** 校验企业微信 msg_signature。 */
function verifyWecom(args = {}) {
  const { token, timestamp, nonce, encrypt, msgSignature } = args;
  if (!token || timestamp == null || nonce == null || !encrypt || !msgSignature) return false;
  return _safeEq(wecomSignature(token, timestamp, nonce, encrypt), msgSignature);
}

/** EncodingAESKey(43 字符)→ 32B AES key。 */
function wecomAesKey(encodingAesKey) {
  return Buffer.from(`${String(encodingAesKey)}=`, 'base64');
}

/**
 * 解密企业微信密文。返回 { ok, msg, receiveId }。
 * 明文布局 = [16B 随机][4B BE 明文长度][明文][receiveid]。
 */
function wecomDecrypt(encryptB64, encodingAesKey) {
  if (!encryptB64 || !encodingAesKey) return { ok: false, error: '企业微信解密需要 encrypt 与 EncodingAESKey。' };
  try {
    const key = wecomAesKey(encodingAesKey);
    if (key.length !== 32) return { ok: false, error: 'EncodingAESKey 解出的密钥长度非 32 字节。' };
    const iv = key.slice(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(false);
    const bytes = _pkcs7strip(Buffer.concat([decipher.update(Buffer.from(String(encryptB64), 'base64')), decipher.final()]));
    if (bytes.length < 20) return { ok: false, error: '企业微信明文长度不足。' };
    const msgLen = bytes.readUInt32BE(16);
    const msg = bytes.slice(20, 20 + msgLen).toString('utf8');
    const receiveId = bytes.slice(20 + msgLen).toString('utf8');
    return { ok: true, msg, receiveId };
  } catch (err) {
    return { ok: false, error: `企业微信解密失败:${err && err.message ? err.message : String(err)}` };
  }
}

/**
 * 处理企业微信回调。
 *   - GET 校验(echostr):verify + 解密 echostr → { ok:true, kind:'verify', plaintext }。
 *   - POST 事件:body 为 XML(含 <Encrypt>),verify msg_signature + 解密 → 解析 <Content>。
 * @param {{token:string, encodingAesKey:string, timestamp, nonce, msgSignature:string,
 *          echostr?:string, xmlBody?:string}} args
 */
function handleWecom(args = {}) {
  const { token, encodingAesKey, timestamp, nonce, msgSignature } = args;

  // GET 回调地址校验
  if (args.echostr) {
    if (!verifyWecom({ token, timestamp, nonce, encrypt: args.echostr, msgSignature })) {
      return { ok: false, error: '企业微信 echostr 签名校验失败。' };
    }
    const dec = wecomDecrypt(args.echostr, encodingAesKey);
    if (!dec.ok) return dec;
    return { ok: true, kind: 'verify', plaintext: dec.msg, receiveId: dec.receiveId };
  }

  // POST 事件
  const encrypt = _xmlTag(args.xmlBody, 'Encrypt');
  if (!encrypt) return { ok: false, error: '企业微信回调 XML 未找到 <Encrypt>。' };
  if (!verifyWecom({ token, timestamp, nonce, encrypt, msgSignature })) {
    return { ok: false, error: '企业微信 msg_signature 校验失败。' };
  }
  const dec = wecomDecrypt(encrypt, encodingAesKey);
  if (!dec.ok) return dec;
  return { ok: true, kind: 'event', message: parseWecomMessage(dec.msg) };
}

/** 解析企业微信解密后的消息 XML,归一为消息对象。 */
function parseWecomMessage(msgXml) {
  return {
    platform: 'wecom',
    userId: _xmlTag(msgXml, 'FromUserName'),
    text: _xmlTag(msgXml, 'Content').trim(),
    msgType: _xmlTag(msgXml, 'MsgType'),
    chatId: _xmlTag(msgXml, 'ChatId') || _xmlTag(msgXml, 'ToUserName'),
    raw: msgXml,
  };
}

module.exports = {
  // 钉钉
  dingtalkSign,
  verifyDingtalk,
  parseDingtalk,
  // 飞书
  feishuDecrypt,
  handleFeishu,
  parseFeishuEvent,
  // 企业微信
  wecomSignature,
  verifyWecom,
  wecomAesKey,
  wecomDecrypt,
  handleWecom,
  parseWecomMessage,
  // 内部原语(测试引用)
  _safeEq,
  _pkcs7strip,
  _xmlTag,
};
