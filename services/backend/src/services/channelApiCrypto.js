'use strict';

/**
 * channelApiCrypto.js — 渠道 API Key 的加密 / 解密 / 脱敏（AES-256-GCM）+ 密钥轮换。
 *
 * 设计取舍：
 *   - 密钥来源优先 `KHY_CHANNEL_KEY_SECRET`（operator 显式配置）。未设置时回退到
 *     按主机名派生的稳定密钥，保证功能开箱可用；同时打一条 warning 提示建议显式配置。
 *     回退密钥的边界是诚实的：拿到数据库文件的人在本机同样能解出明文，真正的强度
 *     提升来自显式配置这个 env。
 *   - 密钥经 SHA-256 归一化为 32 字节，因此 env 里可以放任意长度的口令而非必须 32 字节。
 *   - 解密 fail-soft：格式错、tag 校验失败、密钥不匹配一律返回 ''，绝不抛——
 *     与 configSyncService.decrypt 的口径一致，一条坏记录不应让整个列表 500。
 *
 * 双层 envelope 与轮换：
 *   - KEK（Key Encryption Key）来自 env，是 operator 握着的根密钥；DEK（Data
 *     Encryption Key）是每条记录一个的随机 32 字节，用 KEK 包封后随密文一起存。
 *   - 存储格式 v2：`v2:<wIv>:<wTag>:<wDek>:<iv>:<tag>:<ct>`（7 段，全部 base64，
 *     冒号分隔）。v1 旧格式 `iv:tag:ct`（3 段）仍然可读——解密按段数与 `v2:` 前缀
 *     自识别，历史数据不需要迁移即可继续用。
 *   - 只加密不轮换的问题：换 env 会让旧 KEK 包封的 DEK 永远解不开，等于静默丢 Key。
 *     解法是**密钥环**而不是换一把锁——`resolveKeyRing()` 返回「主 KEK + 若干退役
 *     KEK」的有序列表，解密按序尝试；只有主 KEK 解不开、靠退役 KEK 解开的密文才
 *     判定为「待重包」（needsRewrap），用 `reEncryptApiKey()` 一条一条重包到主 KEK
 *     下，全部迁完后才能安全把退役 KEK 从 env 里删掉。DEK 按记录独立，正是为了
 *     让这一步可以增量做、而不是停机全库重加密。
 *
 * maskApiKey 刻意不复用 utils/maskSecret（前4...后2）与 utils/maskToken（前6***后4）：
 * 本模块的脱敏格式由渠道 API 展示规范固定为「前 4 + **** + 后 4」，阈值也不同
 *（<=8 全遮、<=12 只露前缀），与那两个 util 不可互委。
 */

const crypto = require('crypto');
const os = require('os');

// 密钥来源 env 名（唯一真源：文档与前端提示都从这里引用）。
const KEY_SECRET_ENV = 'KHY_CHANNEL_KEY_SECRET';
// 退役 KEK：逗号分隔，按书写顺序在主 KEK 之后尝试。用于平滑轮换的过渡期。
const KEY_SECRET_PREVIOUS_ENV = 'KHY_CHANNEL_KEY_SECRET_PREVIOUS';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, GCM 标准
const AUTH_TAG_LENGTH = 16;
const FALLBACK_SALT = 'khy-channel-api-key:v1';

const VERSION_PREFIX = 'v2';
const V2_FIELD_COUNT = 7; // v2:<wIv>:<wTag>:<wDek>:<iv>:<tag>:<ct>
const V1_FIELD_COUNT = 3; // iv:tag:ct

let _fallbackWarned = false;

/** 把任意长度的口令归一化为 32 字节 AES-256 密钥。 */
function _toKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

/** 派生本机回退密钥（env 未设置时的稳定值）。 */
function _fallbackSecret() {
  return crypto
    .createHash('sha256')
    .update(`${FALLBACK_SALT}:${os.hostname()}`)
    .digest('hex');
}

/**
 * 解析主加密密钥。
 * @param {object} [env=process.env] 注入以便测试
 * @returns {{secret:string, fromEnv:boolean}}
 */
function resolveSecret(env = process.env) {
  const fromEnv = String((env && env[KEY_SECRET_ENV]) || '').trim();
  if (fromEnv) {
    return { secret: fromEnv, fromEnv: true };
  }
  const secret = _fallbackSecret();
  if (!_fallbackWarned) {
    _fallbackWarned = true;
    try {
      console.warn(
        `渠道 API Key 加密使用本机派生密钥（${KEY_SECRET_ENV} 未设置）：` +
          '单机本机访问仍安全，但拷贝数据库到别的机器将无法解密。'
      );
    } catch {
      /* console 不可用时忽略——warning 不能反过来影响功能 */
    }
  }
  return { secret, fromEnv: false };
}

/**
 * 解析密钥环：主 KEK 在前，退役 KEK 按 env 书写顺序跟在后面。
 * 解密按此顺序逐把尝试，轮换过渡期新旧密文都读得通。
 * @param {object} [env=process.env] 注入以便测试
 * @returns {{primary:string, keys:Array<{secret:string, label:string, fromEnv:boolean}>}}
 */
function resolveKeyRing(env = process.env) {
  const primary = resolveSecret(env);
  const keys = [{ secret: primary.secret, label: 'primary', fromEnv: primary.fromEnv }];
  const raw = String((env && env[KEY_SECRET_PREVIOUS_ENV]) || '').trim();
  if (raw) {
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => s !== primary.secret)
      .forEach((s, i) => {
        keys.push({ secret: s, label: `previous[${i}]`, fromEnv: true });
      });
  }
  return { primary: primary.secret, keys };
}

/** AES-256-GCM 封包：返回 base64 三段。 */
function _gcmSeal(key, plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

/** AES-256-GCM 开包，返回 Buffer；失败（含 tag 校验失败）返回 null，不抛。 */
function _gcmOpenBuf(key, ivB64, tagB64, ctB64) {
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) {
      return null;
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ctB64, 'base64'),
      decipher.final(),
    ]);
  } catch {
    return null;
  }
}

/** AES-256-GCM 开包，按 utf8 字符串返回；失败返回 null。 */
function _gcmOpen(key, ivB64, tagB64, ctB64) {
  const buf = _gcmOpenBuf(key, ivB64, tagB64, ctB64);
  return buf === null ? null : buf.toString('utf8');
}

/** 把随机 DEK 用 KEK 包封成密文里的三段（wIv:wTag:wDek）。 */
function _wrapDek(kekKey, dek) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, kekKey, iv);
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: wrapped.toString('base64'),
  };
}

/** 用 KEK 解包 DEK；失败返回 null。 */
function _unwrapDek(kekKey, ivB64, tagB64, ctB64) {
  // DEK 是 32 字节随机二进制，不是合法 UTF-8，必须按 Buffer 走——
  // 经 utf8 字符串搬运会被替换字符破坏字节，解包「成功」却拿到错误的 DEK。
  const buf = _gcmOpenBuf(kekKey, ivB64, tagB64, ctB64);
  return buf && buf.length === 32 ? buf : null;
}

/**
 * 识别密文版本。
 * @returns {'v1'|'v2'|'unknown'}
 */
function wrapVersion(ciphertext) {
  const raw = String(ciphertext ?? '').trim();
  if (!raw) {
    return 'unknown';
  }
  const parts = raw.split(':');
  if (parts.length === V2_FIELD_COUNT && parts[0] === VERSION_PREFIX) {
    return 'v2';
  }
  if (parts.length === V1_FIELD_COUNT) {
    return 'v1';
  }
  return 'unknown';
}

/** 用**单把** KEK 解密密文；解不开返回 ''（不沿密钥环试）。 */
function decryptWith(ciphertext, secret) {
  const raw = String(ciphertext ?? '').trim();
  if (!raw || !secret) {
    return '';
  }
  const key = _toKey(secret);
  const parts = raw.split(':');

  if (parts.length === V2_FIELD_COUNT && parts[0] === VERSION_PREFIX) {
    const dek = _unwrapDek(key, parts[1], parts[2], parts[3]);
    if (!dek) {
      return '';
    }
    return _gcmOpen(dek, parts[4], parts[5], parts[6]) || '';
  }

  if (parts.length === V1_FIELD_COUNT) {
    // v1：DEK 就是 KEK 派生密钥本身，没有包封层。
    return _gcmOpen(key, parts[0], parts[1], parts[2]) || '';
  }

  return '';
}

/**
 * 解密密文，按密钥环顺序逐把 KEK 尝试。
 * @param {string} ciphertext `iv:authTag:ciphertext`（v1）或 `v2:...`（v2）
 * @param {string} [secret] 显式指定单把 KEK（测试/精确场景）；不给则用整条环
 * @param {object} [env=process.env] 注入以便测试
 * @returns {string} 明文；任何失败（格式错 / tag 不匹配 / 环里无解）返回 ''
 */
function decryptApiKey(ciphertext, secret, env = process.env) {
  const raw = String(ciphertext ?? '').trim();
  if (!raw) {
    return '';
  }
  if (secret) {
    return decryptWith(ciphertext, secret);
  }
  for (const entry of resolveKeyRing(env).keys) {
    const plain = decryptWith(raw, entry.secret);
    if (plain) {
      return plain;
    }
  }
  return '';
}

/**
 * 加密明文 Key（v2 envelope：每条记录一个随机 DEK，用主 KEK 包封）。
 * @param {string} plaintext 明文 API Key
 * @param {string} [secret] 覆盖 KEK（测试用）；不给则取主 KEK
 * @param {object} [env=process.env] 注入以便测试
 * @returns {string} `v2:<wIv>:<wTag>:<wDek>:<iv>:<tag>:<ct>`；空输入返回 ''
 */
function encryptApiKey(plaintext, secret, env = process.env) {
  const text = String(plaintext ?? '').trim();
  if (!text) {
    return '';
  }
  const kekKey = _toKey(secret || resolveKeyRing(env).primary);
  const dek = crypto.randomBytes(32);
  const wrapped = _wrapDek(kekKey, dek);
  const sealed = _gcmSeal(dek, text);
  return [
    VERSION_PREFIX,
    wrapped.iv,
    wrapped.tag,
    wrapped.ct,
    sealed.iv,
    sealed.tag,
    sealed.ct,
  ].join(':');
}

/**
 * 定位解开了这条密文的是环里第几把 KEK（0 = 主 KEK）。
 * @returns {number} 环下标；-1 = 环里无解
 */
function unwrapKeyIndex(ciphertext, env = process.env) {
  const raw = String(ciphertext ?? '').trim();
  if (!raw) {
    return -1;
  }
  const keys = resolveKeyRing(env).keys;
  for (let i = 0; i < keys.length; i++) {
    if (decryptWith(raw, keys[i].secret)) {
      return i;
    }
  }
  return -1;
}

/**
 * 这条密文是否挂在退役 KEK 上、需要重包到主 KEK？
 * 只有「主 KEK 解不开、但环里靠后某把能解开」才成立。
 */
function needsRewrap(ciphertext, env = process.env) {
  return unwrapKeyIndex(ciphertext, env) > 0;
}

/**
 * 重包到目标 KEK 下：解出明文再重新加密，产出新的 v2 密文（新 DEK、新 IV）。
 * 这是轮换的增量工作单元——可以一条记录一条地迁，迁完才能从 env 删掉退役 KEK。
 * @param {string} ciphertext 现有密文（v1 或 v2）
 * @param {string} [targetSecret] 目标 KEK；不给则用当前主 KEK
 * @param {object} [env=process.env] 注入以便测试
 * @returns {string} 新密文；解不出（格式错 / 环里无解）返回 ''
 */
function reEncryptApiKey(ciphertext, targetSecret, env = process.env) {
  const plain = decryptApiKey(ciphertext, targetSecret, env);
  if (!plain) {
    return '';
  }
  return encryptApiKey(plain, targetSecret, env);
}

/**
 * 脱敏展示：前 4 位 + **** + 后 4 位（如 `sk-a****abcd`）。
 * 短 Key 不透露任何片段，避免「前 2 后 4 就够复原」的弱脱敏。
 * 对 v2 密文取的是密文串而非明文，因此不会顺手解出真值——脱敏只做字符串切片。
 * @param {string} value 明文或密文（只取字符，不解密）
 * @returns {string} 空输入返回 ''
 */
function maskApiKey(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return '';
  }
  if (text.length <= 8) {
    return '****';
  }
  if (text.length <= 12) {
    return `${text.slice(0, 4)}****`;
  }
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

module.exports = {
  KEY_SECRET_ENV,
  KEY_SECRET_PREVIOUS_ENV,
  ALGORITHM,
  VERSION_PREFIX,
  resolveSecret,
  resolveKeyRing,
  decryptWith,
  encryptApiKey,
  decryptApiKey,
  unwrapKeyIndex,
  needsRewrap,
  reEncryptApiKey,
  wrapVersion,
  maskApiKey,
};
