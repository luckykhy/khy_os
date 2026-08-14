'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const cryptoLeaf = require('../../../src/services/messaging/ilinkCrypto');

test('normalizeAesKey: 形态 1 —— base64 直接解出 16 字节', () => {
  const raw = crypto.randomBytes(16);
  const key = cryptoLeaf.normalizeAesKey(raw.toString('base64'));
  assert.ok(Buffer.isBuffer(key));
  assert.strictEqual(key.length, 16);
  assert.strictEqual(key.toString('hex'), raw.toString('hex'));
});

test('normalizeAesKey: 形态 2 —— base64 解出的是 32 位 hex 文本,再解一层', () => {
  const raw = crypto.randomBytes(16);
  const hex = raw.toString('hex');                       // 32 个 hex 字符
  const key = cryptoLeaf.normalizeAesKey(Buffer.from(hex, 'utf-8').toString('base64'));
  assert.ok(Buffer.isBuffer(key));
  assert.strictEqual(key.length, 16);
  assert.strictEqual(key.toString('hex'), hex, '必须解出与原始一致的密钥');
});

test('normalizeAesKey: 大写 hex 也认', () => {
  const hex = crypto.randomBytes(16).toString('hex').toUpperCase();
  const key = cryptoLeaf.normalizeAesKey(Buffer.from(hex, 'utf-8').toString('base64'));
  assert.strictEqual(key && key.length, 16);
});

test('normalizeAesKey: 无法解析一律 null,绝不抛', () => {
  for (const bad of ['', null, undefined, 123, {}, 'not-base64-!!!', Buffer.from('short').toString('base64')]) {
    assert.strictEqual(cryptoLeaf.normalizeAesKey(bad), null, `期望 null: ${String(bad)}`);
  }
  // 长度对但不是 16/32-hex:24 字节
  assert.strictEqual(cryptoLeaf.normalizeAesKey(crypto.randomBytes(24).toString('base64')), null);
});

test('aesEcbPaddedSize: PKCS#7 至少补 1 字节,整块也进位(出站申报 filesize 用)', () => {
  assert.strictEqual(cryptoLeaf.aesEcbPaddedSize(0), 16);
  assert.strictEqual(cryptoLeaf.aesEcbPaddedSize(15), 16);
  assert.strictEqual(cryptoLeaf.aesEcbPaddedSize(16), 32);
  assert.strictEqual(cryptoLeaf.aesEcbPaddedSize(17), 32);
  assert.strictEqual(cryptoLeaf.aesEcbPaddedSize(32), 48);
  // 非法输入回 0 而不是 NaN
  assert.strictEqual(cryptoLeaf.aesEcbPaddedSize(-1), 0);
  assert.strictEqual(cryptoLeaf.aesEcbPaddedSize('x'), 0);
});

test('generateHexKey: 32 位 hex,每次不同', () => {
  const a = cryptoLeaf.generateHexKey();
  const b = cryptoLeaf.generateHexKey();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notStrictEqual(a, b);
});

test('encodeAesKeyForOutbound: hex 文本 → base64(UTF-8 字节),与 normalizeAesKey 形态2 对称', () => {
  const hex = 'a'.repeat(32);
  assert.strictEqual(
    cryptoLeaf.encodeAesKeyForOutbound(hex),
    Buffer.from(hex, 'utf-8').toString('base64'),
  );
  // 编码产物能被自己的归一函数解回 16 字节
  const realHex = crypto.randomBytes(16).toString('hex');
  const encoded = cryptoLeaf.encodeAesKeyForOutbound(realHex);
  assert.strictEqual(cryptoLeaf.normalizeAesKey(encoded).toString('hex'), realHex);
});

test('generateAesKey: 16 字节的 base64,且每次不同', () => {
  const a = cryptoLeaf.generateAesKey();
  const b = cryptoLeaf.generateAesKey();
  assert.strictEqual(Buffer.from(a, 'base64').length, 16);
  assert.notStrictEqual(a, b);
  // 生成的 key 能被自己的归一函数吃回去
  assert.strictEqual(cryptoLeaf.normalizeAesKey(a).length, 16);
});

test('encrypt/decrypt 往返(PKCS#7)', () => {
  const key = crypto.randomBytes(16);
  for (const len of [1, 15, 16, 17, 1000]) {
    const plain = crypto.randomBytes(len);
    const enc = cryptoLeaf.encryptAesEcb(key, plain);
    assert.strictEqual(enc.ok, true, `加密失败 len=${len}`);
    // PKCS#7 密文长度恰好等于 aesEcbPaddedSize(整块时多补一整块)。
    assert.strictEqual(enc.data.length, cryptoLeaf.aesEcbPaddedSize(len), `密文长度不符 len=${len}`);
    const dec = cryptoLeaf.decryptAesEcb(key, enc.data);
    assert.strictEqual(dec.ok, true, `解密失败 len=${len}`);
    assert.strictEqual(dec.padding, 'pkcs7');
    assert.strictEqual(dec.data.toString('hex'), plain.toString('hex'), `往返不一致 len=${len}`);
  }
});

test('decryptAesEcb: 非 PKCS#7 填充降级为不去填充(比整件解不出来强)', () => {
  const key = crypto.randomBytes(16);
  const plain = Buffer.alloc(32, 0x41);                  // 恰好 2 块,零填充语义
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(false);
  const ct = Buffer.concat([c.update(plain), c.final()]);

  const dec = cryptoLeaf.decryptAesEcb(key, ct);
  assert.strictEqual(dec.ok, true, '应降级成功而非报错');
  // 明文尾字节是 0x41(65),不是合法 PKCS#7 尾,故走 none 分支
  assert.strictEqual(dec.padding, 'none');
  assert.strictEqual(dec.data.toString('hex'), plain.toString('hex'));
});

test('decryptAesEcb: 参数校验一律 fail-soft,绝不抛', () => {
  const key = crypto.randomBytes(16);
  assert.strictEqual(cryptoLeaf.decryptAesEcb(Buffer.alloc(8), Buffer.alloc(16)).ok, false, '密钥长度错');
  assert.strictEqual(cryptoLeaf.decryptAesEcb('notbuf', Buffer.alloc(16)).ok, false);
  assert.strictEqual(cryptoLeaf.decryptAesEcb(key, Buffer.alloc(0)).ok, false, '空密文');
  assert.strictEqual(cryptoLeaf.decryptAesEcb(key, 'notbuf').ok, false);
  // 长度不是块整数倍 → 明确报错而不是尝试解密
  const bad = cryptoLeaf.decryptAesEcb(key, Buffer.alloc(17));
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.error.includes('17'), '错误信息应带上实际长度便于排查');
});

test('encryptAesEcb: 参数校验一律 fail-soft', () => {
  assert.strictEqual(cryptoLeaf.encryptAesEcb(Buffer.alloc(8), Buffer.alloc(16)).ok, false);
  assert.strictEqual(cryptoLeaf.encryptAesEcb(crypto.randomBytes(16), 'notbuf').ok, false);
  // 空明文是合法的(PKCS#7 会产出一整块)
  const e = cryptoLeaf.encryptAesEcb(crypto.randomBytes(16), Buffer.alloc(0));
  assert.strictEqual(e.ok, true);
  assert.strictEqual(e.data.length, 16);
});

test('错误密钥解不出原文(不静默返回垃圾当成功…或至少数据不同)', () => {
  const plain = Buffer.from('sensitive payload here padding..');
  const enc = cryptoLeaf.encryptAesEcb(crypto.randomBytes(16), plain);
  const dec = cryptoLeaf.decryptAesEcb(crypto.randomBytes(16), enc.data);
  // 用错密钥时:要么填充非法(降级 none)、要么解出乱码——但绝不能等于原文。
  if (dec.ok) assert.notStrictEqual(dec.data.toString('hex'), plain.toString('hex'));
});
