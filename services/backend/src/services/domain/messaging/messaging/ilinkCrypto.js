'use strict';

/**
 * ilinkCrypto.js — 微信 ilink bot 媒体加解密的纯叶子(零 IO、确定性、可单测)。
 *
 * 微信 c2c CDN 上的媒体件以 **AES-128-ECB** 加密,密钥随消息体下发。密钥字段
 * (`aes_key` / `aeskey`)历史上有两种编码,必须都兼容:
 *   1. base64(16 个原始字节)        → base64 解出来正好 16 字节,直接用
 *   2. base64("32 个 hex 字符")      → base64 解出来是一串 hex 文本,再按 hex 解一次
 * 判据是「解出的长度是否为 16」,而不是猜格式。
 *
 * 契约:纯叶子,**绝不抛**。可能失败的入口返回 { ok:false, error },成功返回
 * { ok:true, data }。调用方(ilinkMedia)负责 IO 与日志。
 *
 * @module services/messaging/ilinkCrypto
 */

const crypto = require('crypto');

const AES_BLOCK_SIZE = 16;
const AES_KEY_SIZE = 16;

/**
 * 把下发的密钥字段归一成 16 字节 Buffer。两种编码见文件头。
 * @param {string} aesKeyBase64
 * @returns {Buffer|null} 16 字节密钥;无法解析 → null
 */
function normalizeAesKey(aesKeyBase64) {
  if (typeof aesKeyBase64 !== 'string' || !aesKeyBase64) {
    return null;
  }
  let raw;
  try {
    raw = Buffer.from(aesKeyBase64, 'base64');
  } catch {
    return null;
  }
  // 形态 1:base64 直接解出 16 字节。
  if (raw.length === AES_KEY_SIZE) {
    return raw;
  }
  // 形态 2:解出的是 hex 文本(通常 32 个字符),再解一层。
  try {
    const hex = raw.toString('utf-8').trim();
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
      return null;
    }
    const key = Buffer.from(hex, 'hex');
    return key.length === AES_KEY_SIZE ? key : null;
  } catch {
    return null;
  }
}

/**
 * ECB + PKCS#7 下密文长度。出站上传要按这个值申报 filesize。
 *
 * PKCS#7 **至少补 1 字节**:即使明文恰好是块的整数倍,也会多补一整块。
 * 故公式为 ceil((n+1)/16)*16,即 ((n+1+15)>>4)<<4 —— 而非 ceil(n/16)*16
 * (后者在 n 为 16 的倍数时少算一整块,与真实密文长度差一块,导致上传失败)。
 * @param {number} size 明文字节数
 * @returns {number}
 */
function aesEcbPaddedSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return ((n + 1 + (AES_BLOCK_SIZE - 1)) >> 4) << 4;
}

/** 生成一个随机 16 字节密钥的 base64(出站上传用)。 */
function generateAesKey() {
  return crypto.randomBytes(AES_KEY_SIZE).toString('base64');
}

/**
 * 生成 32 位随机 hex 密钥(16 字节)。真实协议里 aeskey 申报用的就是这串 hex 明文。
 * @returns {string} 32 个 hex 字符
 */
function generateHexKey() {
  return crypto.randomBytes(AES_KEY_SIZE).toString('hex');
}

/**
 * 把 hex 密钥编码成出站报文里的 aes_key 形态:base64(hex 文本的 UTF-8 字节)。
 * 例:hex '00112233...' → base64('00112233...') = 'MDAxMTIyMzM...'。
 * 与 normalizeAesKey 的「形态 2」对称,下载方能把它解回 16 字节。
 * @param {string} hexKey 32 位 hex
 * @returns {string} base64 串
 */
function encodeAesKeyForOutbound(hexKey) {
  return Buffer.from(String(hexKey == null ? '' : hexKey), 'utf-8').toString('base64');
}

/**
 * AES-128-ECB 加密(PKCS#7 自动填充)。
 * @param {Buffer} key 16 字节
 * @param {Buffer} plaintext
 * @returns {{ok:true,data:Buffer}|{ok:false,error:string}}
 */
function encryptAesEcb(key, plaintext) {
  if (!Buffer.isBuffer(key) || key.length !== AES_KEY_SIZE) {
    return { ok: false, error: 'AES 密钥必须是 16 字节' };
  }
  if (!Buffer.isBuffer(plaintext)) {
    return { ok: false, error: '明文必须是 Buffer' };
  }
  try {
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    return { ok: true, data: Buffer.concat([cipher.update(plaintext), cipher.final()]) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * AES-128-ECB 解密。
 *
 * 先按 PKCS#7 自动去填充解一次;若 final() 因填充不合法而失败(微信侧并非所有
 * 媒体都用 PKCS#7,也见过零填充/无填充),**降级为关闭去填充再解一次**——此时
 * 尾部会残留填充字节,但图片/文件解码器普遍容忍尾部垃圾,比整件解不出来强。
 * 两次都失败才返回 error。
 *
 * @param {Buffer} key 16 字节
 * @param {Buffer} ciphertext
 * @returns {{ok:true,data:Buffer,padding:'pkcs7'|'none'}|{ok:false,error:string}}
 */
function decryptAesEcb(key, ciphertext) {
  if (!Buffer.isBuffer(key) || key.length !== AES_KEY_SIZE) {
    return { ok: false, error: 'AES 密钥必须是 16 字节' };
  }
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) {
    return { ok: false, error: '密文为空' };
  }
  if (ciphertext.length % AES_BLOCK_SIZE !== 0) {
    return { ok: false, error: `密文长度 ${ciphertext.length} 不是 ${AES_BLOCK_SIZE} 的整数倍` };
  }
  try {
    const d = crypto.createDecipheriv('aes-128-ecb', key, null);
    return { ok: true, data: Buffer.concat([d.update(ciphertext), d.final()]), padding: 'pkcs7' };
  } catch {
    // 填充不合法 → 关掉去填充重解(保留尾部填充字节)。
    try {
      const d = crypto.createDecipheriv('aes-128-ecb', key, null);
      d.setAutoPadding(false);
      return { ok: true, data: Buffer.concat([d.update(ciphertext), d.final()]), padding: 'none' };
    } catch (e2) {
      return { ok: false, error: (e2 && e2.message) || String(e2) };
    }
  }
}

module.exports = {
  AES_BLOCK_SIZE,
  AES_KEY_SIZE,
  normalizeAesKey,
  aesEcbPaddedSize,
  generateAesKey,
  generateHexKey,
  encodeAesKeyForOutbound,
  encryptAesEcb,
  decryptAesEcb,
};
