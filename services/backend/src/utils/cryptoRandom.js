'use strict';

/**
 * cryptoRandom.js — 密码学安全随机工具函数
 *
 * 对抗式综合方案 C：统一随机工具
 * 安全敏感场景强制使用，CI 检测 Math.random() 在敏感上下文的使用
 */

const crypto = require('crypto');

/**
 * 生成密码学安全的随机字节。
 * @param {number} length 字节长度
 * @returns {Buffer}
 */
function randomBytes(length = 16) {
  return crypto.randomBytes(length);
}

/**
 * 生成密码学安全的随机十六进制字符串。
 * @param {number} length 字节长度（结果字符串长度为 2*length）
 * @returns {string}
 */
function randomHex(length = 16) {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * 生成密码学安全的随机 Base64 字符串。
 * @param {number} length 字节长度
 * @returns {string}
 */
function randomBase64(length = 16) {
  return crypto.randomBytes(length).toString('base64');
}

/**
 * 生成密码学安全的随机 UUID v4。
 * @returns {string}
 */
function randomUUID() {
  return crypto.randomUUID();
}

/**
 * 生成密码学安全的随机整数 [min, max)。
 * @param {number} min 最小值（包含）
 * @param {number} max 最大值（不包含）
 * @returns {number}
 */
function randomInt(min, max) {
  if (min >= max) throw new Error('min must be less than max');
  const range = max - min;
  // 计算需要多少字节来表示 range
  const bytesNeeded = Math.ceil(Math.log2(range) / 8);
  // 计算最大值，确保均匀分布
  const maxVal = Math.pow(256, bytesNeeded);
  // 拒绝采样，避免模偏差
  let result;
  do {
    result = crypto.randomBytes(bytesNeeded).readUIntBE(0, bytesNeeded);
  } while (result >= maxVal - (maxVal % range));
  return min + (result % range);
}

/**
 * 生成密码学安全的随机字符串。
 * @param {number} length 字符串长度
 * @param {string} alphabet 字符集
 * @returns {string}
 */
function randomString(length = 32, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') {
  const result = [];
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result.push(alphabet[bytes[i] % alphabet.length]);
  }
  return result.join('');
}

/**
 * 生成密码学安全的 Token（32 字节 hex）。
 * @returns {string}
 */
function generateToken() {
  return randomHex(32);
}

/**
 * 生成密码学安全的 ID（8 字节 hex）。
 * @returns {string}
 */
function generateId() {
  return randomHex(8);
}

module.exports = {
  randomBytes,
  randomHex,
  randomBase64,
  randomUUID,
  randomInt,
  randomString,
  generateToken,
  generateId,
};
