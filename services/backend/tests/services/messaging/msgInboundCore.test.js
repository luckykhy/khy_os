'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const inb = require('../../../src/services/messaging/msgInboundCore');

// ── 独立实现的平台加密(不调用被测代码的内部),用于验证被测的解密/验签 ──

/** 飞书:AES-256-CBC 加密(key=sha256(encryptKey), iv 随机 16B, PKCS7)。 */
function feishuEncrypt(plaintext, encryptKey) {
  const key = crypto.createHash('sha256').update(encryptKey, 'utf8').digest();
  const iv = Buffer.alloc(16, 7); // 固定 iv 便于确定性
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([iv, ct]).toString('base64');
}

/** 企业微信:WXBizMsgCrypt 加密。 */
function wecomEncrypt(msg, receiveId, encodingAesKey) {
  const key = Buffer.from(`${encodingAesKey}=`, 'base64');
  const iv = key.slice(0, 16);
  const random16 = Buffer.alloc(16, 3);
  const msgBuf = Buffer.from(msg, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const raw = Buffer.concat([random16, lenBuf, msgBuf, Buffer.from(receiveId, 'utf8')]);
  // PKCS7 pad to 32
  const padLen = 32 - (raw.length % 32);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  const ct = Buffer.concat([cipher.update(padded), cipher.final()]);
  return ct.toString('base64');
}

// EncodingAESKey 必须是 43 字符(base64 去掉尾 '='),解出 32B
const AES_KEY_43 = crypto.randomBytes(32).toString('base64').replace(/=+$/, '').slice(0, 43);

// ──────────────────────────── 钉钉 ────────────────────────────

test('钉钉:验签 round-trip + 篡改被拒', () => {
  const secret = 'ding-secret';
  const ts = '1700000000000';
  const sign = inb.dingtalkSign(secret, ts);
  assert.strictEqual(inb.verifyDingtalk({ secret, timestamp: ts, sign }), true);
  assert.strictEqual(inb.verifyDingtalk({ secret, timestamp: ts, sign: sign + 'x' }), false);
  assert.strictEqual(inb.verifyDingtalk({ secret: 'wrong', timestamp: ts, sign }), false);
  assert.strictEqual(inb.verifyDingtalk({}), false);
});

test('钉钉:解析消息体归一', () => {
  const m = inb.parseDingtalk({ text: { content: '  查库存  ' }, senderNick: '张三', senderStaffId: 'u123', sessionWebhook: 'https://x' });
  assert.strictEqual(m.text, '查库存');
  assert.strictEqual(m.userId, 'u123');
  assert.strictEqual(m.userName, '张三');
  assert.strictEqual(m.platform, 'dingtalk');
});

// ──────────────────────────── 飞书 ────────────────────────────

test('飞书:url_verification 明文挑战', () => {
  const r = inb.handleFeishu({ type: 'url_verification', challenge: 'abc123', token: 'tk' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'challenge');
  assert.strictEqual(r.challenge, 'abc123');
});

test('飞书:AES 解密 round-trip(独立加密→被测解密)', () => {
  const key = 'my-feishu-encrypt-key';
  const payload = JSON.stringify({ type: 'url_verification', challenge: 'ENC-CHAL', token: 'tk' });
  const encrypt = feishuEncrypt(payload, key);
  const dec = inb.feishuDecrypt(encrypt, key);
  assert.strictEqual(dec.ok, true);
  assert.strictEqual(dec.plaintext, payload);

  // 经 handleFeishu 端到端:加密挑战 → challenge
  const r = inb.handleFeishu({ encrypt }, { encryptKey: key });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'challenge');
  assert.strictEqual(r.challenge, 'ENC-CHAL');
});

test('飞书:im.message.receive_v1 事件解析', () => {
  const key = 'k2';
  const evt = {
    header: { event_type: 'im.message.receive_v1', token: 'vtok' },
    event: {
      sender: { sender_id: { open_id: 'ou_abc' } },
      message: { message_id: 'm1', chat_id: 'c1', content: JSON.stringify({ text: '你好机器人' }) },
    },
  };
  const encrypt = feishuEncrypt(JSON.stringify(evt), key);
  const r = inb.handleFeishu({ encrypt }, { encryptKey: key, verificationToken: 'vtok' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'event');
  assert.strictEqual(r.message.text, '你好机器人');
  assert.strictEqual(r.message.userId, 'ou_abc');
  assert.strictEqual(r.message.messageId, 'm1');
});

test('飞书:verification token 不匹配 → 拒绝', () => {
  const evt = { header: { event_type: 'im.message.receive_v1', token: 'real' }, event: { sender: {}, message: { content: '{}' } } };
  const r = inb.handleFeishu(evt, { verificationToken: 'expected-other' });
  assert.strictEqual(r.ok, false);
});

test('飞书:解密失败 fail-soft', () => {
  const r = inb.feishuDecrypt('not-valid-base64-cipher!!!', 'key');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

// ──────────────────────────── 企业微信 ────────────────────────────

test('企业微信:msg_signature 校验 + 篡改被拒', () => {
  const token = 'wctoken';
  const encrypt = 'ENCRYPTED_BLOB';
  const sig = inb.wecomSignature(token, '1700000000', 'nonce1', encrypt);
  assert.strictEqual(inb.verifyWecom({ token, timestamp: '1700000000', nonce: 'nonce1', encrypt, msgSignature: sig }), true);
  assert.strictEqual(inb.verifyWecom({ token, timestamp: '1700000000', nonce: 'nonce1', encrypt, msgSignature: sig + '0' }), false);
});

test('企业微信:GET echostr 校验 round-trip', () => {
  const token = 'wct';
  const plain = 'HELLO_VERIFY';
  const echostr = wecomEncrypt(plain, 'wxcorp1', AES_KEY_43);
  const sig = inb.wecomSignature(token, '1700', 'n1', echostr);
  const r = inb.handleWecom({ token, encodingAesKey: AES_KEY_43, timestamp: '1700', nonce: 'n1', msgSignature: sig, echostr });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'verify');
  assert.strictEqual(r.plaintext, plain);
});

test('企业微信:POST 事件 XML 解密 + 解析 round-trip', () => {
  const token = 'wct2';
  const msgXml = '<xml><ToUserName><![CDATA[corpid]]></ToUserName><FromUserName><![CDATA[userA]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[开始回测]]></Content></xml>';
  const encrypt = wecomEncrypt(msgXml, 'corpid', AES_KEY_43);
  const sig = inb.wecomSignature(token, '1800', 'n2', encrypt);
  const xmlBody = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;
  const r = inb.handleWecom({ token, encodingAesKey: AES_KEY_43, timestamp: '1800', nonce: 'n2', msgSignature: sig, xmlBody });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'event');
  assert.strictEqual(r.message.text, '开始回测');
  assert.strictEqual(r.message.userId, 'userA');
  assert.strictEqual(r.message.msgType, 'text');
});

test('企业微信:签名不符 → 拒绝解密', () => {
  const token = 'wct3';
  const encrypt = wecomEncrypt('<xml><Content><![CDATA[x]]></Content></xml>', 'cid', AES_KEY_43);
  const xmlBody = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;
  const r = inb.handleWecom({ token, encodingAesKey: AES_KEY_43, timestamp: '1', nonce: 'n', msgSignature: 'deadbeef', xmlBody });
  assert.strictEqual(r.ok, false);
});

// ──────────────────────────── 原语 ────────────────────────────

test('_safeEq:相等真,不等假,空假', () => {
  assert.strictEqual(inb._safeEq('abc', 'abc'), true);
  assert.strictEqual(inb._safeEq('abc', 'abd'), false);
  assert.strictEqual(inb._safeEq('', ''), false);
  assert.strictEqual(inb._safeEq('a', 'ab'), false);
});

test('_xmlTag:CDATA 与普通文本都能取', () => {
  assert.strictEqual(inb._xmlTag('<A><![CDATA[hi]]></A>', 'A'), 'hi');
  assert.strictEqual(inb._xmlTag('<B>plain</B>', 'B'), 'plain');
  assert.strictEqual(inb._xmlTag('<A>x</A>', 'Z'), '');
});
