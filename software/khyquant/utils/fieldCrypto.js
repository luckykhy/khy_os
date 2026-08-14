/**
 * Field-level AES-256-GCM encryption for sensitive model columns.
 *
 * Single source of truth for at-rest encryption of secret fields
 * (API keys, upstream credentials). Mirrors the inline implementation
 * historically embedded in AIAccount.js so encrypted values remain
 * mutually decryptable across models.
 *
 * Key derivation: SHA-256 of FIELD_ENCRYPTION_KEY (preferred) or
 * JWT_SECRET (fallback). When neither is set (dev), encryption is a
 * graceful no-op and plaintext round-trips unchanged.
 *
 * Storage format: base64(iv[12] + authTag[16] + ciphertext).
 *
 * @pattern Strategy
 */
'use strict';

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getEncryptionKey() {
  const hex = process.env.FIELD_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!hex || hex.length < 32) {
    // 无加密密钥时的降级行为：返回 null → encryptField 返回明文、decryptField 原样返回。
    // 在生产部署中应始终设置 FIELD_ENCRYPTION_KEY 环境变量。
    try {
      if (!process.env.FIELD_ENCRYPTION_KEY && !process.env.JWT_SECRET) {
        process.stderr.write('[fieldCrypto] ⚠️ 未配置 FIELD_ENCRYPTION_KEY — 敏感字段将以明文存储！\n');
      }
    } catch (_) {}
    return null;
  }
  if (hex === process.env.JWT_SECRET && process.env.FIELD_ENCRYPTION_KEY !== hex) {
    // 回退到 JWT_SECRET 作为加密密钥：密钥复用风险。
    // 建议设置独立的 FIELD_ENCRYPTION_KEY 环境变量。
    try {
      process.stderr.write('[fieldCrypto] ⚠️ 使用 JWT_SECRET 作为字段加密密钥（降级）— 建议设置独立的 FIELD_ENCRYPTION_KEY\n');
    } catch (_) {}
  }
  return crypto.createHash('sha256').update(hex).digest();
}

/**
 * Encrypt a UTF-8 string. Returns base64(iv+tag+ciphertext), or the
 * original plaintext when no key is configured.
 * @param {string} plaintext
 * @returns {string}
 */
function encryptField(plaintext) {
  if (plaintext == null) return plaintext;
  const key = getEncryptionKey();
  if (!key) return plaintext; // graceful fallback in dev
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/**
 * Decrypt a value produced by encryptField. Returns the input unchanged
 * when no key is configured or when the value is not a recognized
 * ciphertext (legacy plaintext tolerated).
 * @param {string} stored
 * @returns {string}
 */
function decryptField(stored) {
  if (stored == null) return stored;
  const key = getEncryptionKey();
  if (!key) return stored;
  try {
    const buf = Buffer.from(stored, 'base64');
    if (buf.length < IV_LEN + TAG_LEN + 1) return stored; // not encrypted
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const enc = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc, null, 'utf8') + decipher.final('utf8');
  } catch (err) {
    // 解密失败：返回 stored 会导致后续使用乱码 base64 作为有效数据 → 永久数据损坏。
    // 改为抛出明确错误，避免静默数据损坏。
    const prefix = String(stored).slice(0, 32);
    const logErr = `[fieldCrypto] 解密失败 (keyHash=${key.toString('hex').slice(0, 8)}, prefix=${prefix}): ${err.message}`;
    try { process.stderr.write(logErr + '\n'); } catch (_) {}
    throw new Error('字段解密失败 — 请检查 FIELD_ENCRYPTION_KEY 是否正确，或该值是否为未加密的明文。');
  }
}

module.exports = { encryptField, decryptField, getEncryptionKey };
