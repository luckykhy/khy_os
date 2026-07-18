'use strict';

/**
 * memorySlug.js — 纯叶子:记忆文件名 slug 的**稳定、非有损**单一真源。
 *
 * 背景(goal 自省报告 #3「记忆碎片化 + 重复」):旧 `memdir._generateFilename` 用
 *   `name.toLowerCase().replace(/[^a-z0-9_\-\s]/g,'').replace(/\s+/g,'_').slice(0,50)`
 * 生成文件名。这条正则**丢弃所有非 ASCII 字符**(中文/重音等)。后果:
 *   ① 纯中文名(「系统提示词膨胀」)→ strip 后为空 → 文件名塌成 `feedback_.md`,
 *      不同的中文事实互相**碰撞**成同一个无意义文件名(报告里的 `feedback_system----` 孪生);
 *   ② 同一事实两次写入、名字略有出入 → 生成不同 slug → 落成两个文件,无幂等去重。
 *
 * 本叶子把 slug 变成 (type, name) 的**确定性函数**:纯 ASCII 干净名 → 与旧实现**逐字节
 * 相同**(零迁移);一旦 ASCII strip 会丢掉可区分内容(含非 ASCII 字母)或结果退化(空 /
 * 仅分隔符),就追加一段基于规范化原名的确定性短哈希,使不同名字得到不同且**稳定**的
 * 文件名——于是「同一名字再次写入 → 同一文件名 → 覆盖而非孪生」这条幂等性天然成立。
 * 另外剥掉冗余的 `type_` 前缀(修 `user_user-home-qujing` 这类双前缀孪生)。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛、门控。仅 require('crypto')(纯/确定性,
 * 非 IO,leaf-contract 白名单)。逃生阀 `KHY_MEMORY_SLUG_STABLE`(默认 on)。**关闭即
 * 逐字节回退**旧 `${type}_${legacySlug}.md`。任何异常 → 同样回退旧文件名。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);

/** 门控:仅显式关闭词关闭,其余(含未设)均开启。 */
function slugGateEnabled(env) {
  const v = (env || (typeof process !== 'undefined' ? process.env : undefined) || {}).KHY_MEMORY_SLUG_STABLE;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 旧 `_generateFilename` 的 slug 片段——**逐字节复刻**,作为 byte-revert 锚。
 * @param {string} name
 * @returns {string}
 */
function legacySlug(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 50);
}

/**
 * 规范化记忆名(用于哈希与幂等键):NFC 归一、去首尾空白、小写、折叠内部空白,
 * 再剥掉一个冗余的前导 `type` 前缀(`user-home-qujing` + type=user → `home-qujing`),
 * 避免同一事实因是否带 type 前缀而落成两个文件。
 * @param {string} type
 * @param {string} name
 * @returns {string}
 */
function canonicalMemoryName(type, name) {
  let s = String(name == null ? '' : name);
  try { s = s.normalize('NFC'); } catch { /* 环境无 normalize 时按原样 */ }
  s = s.trim().toLowerCase().replace(/\s+/g, ' ');
  const t = String(type == null ? '' : type).trim().toLowerCase();
  if (t) {
    // 剥一个前导 `type` + 分隔符(`_`/`-`/空格)。仅剥一次,避免过度吞名。
    const re = new RegExp('^' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\-_ ]+');
    s = s.replace(re, '');
  }
  return s;
}

/** 规范化名的确定性短哈希(8 hex)。crypto 不可用/异常 → 简易确定性回退哈希。 */
function _shortHash(normalized) {
  const s = String(normalized == null ? '' : normalized);
  try {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);
  } catch {
    // 极端环境无 crypto:FNV-1a 风格确定性回退(仅为区分,非加密用途)。
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }
}

/**
 * 幂等键:同一 (type, 规范化名) → 同一键。IO 壳据此做写入前去重扫描。
 * @param {string} type
 * @param {string} name
 * @returns {string}
 */
function memoryKey(type, name) {
  return String(type == null ? '' : type).trim().toLowerCase() + ' ' + canonicalMemoryName(type, name);
}

/**
 * 生成稳定、非有损的记忆文件名。
 *
 * 门控关 / 异常 → `${type}_${legacySlug(name)}.md`(与旧实现逐字节相同)。
 * 门控开:
 *   - 纯 ASCII 干净名且无冗余 type 前缀 → 与 legacy 逐字节相同(零迁移);
 *   - ASCII strip 丢内容(含非 ASCII 字母)或 slug 退化(空/仅分隔符)→ 追加短哈希;
 *   - 冗余 `type_` 前缀被剥掉。
 *
 * @param {string} type
 * @param {string} name
 * @param {object} [opts]  { env }
 * @returns {string} 文件名(含 `.md`)
 */
function buildMemoryFilename(type, name, opts = {}) {
  const legacy = type + '_' + legacySlug(name) + '.md';
  try {
    if (!slugGateEnabled(opts.env)) return legacy;
    const canon = canonicalMemoryName(type, name);
    const cleanSlug = legacySlug(canon);
    // 有损 = 规范化名里存在任何码点 > 127 的字符(ASCII slug 无法表达 → 需哈希区分)。
    let lossy = false;
    for (let i = 0; i < canon.length; i++) {
      if (canon.charCodeAt(i) > 127) { lossy = true; break; }
    }
    // 退化 = slug 为空或仅由分隔符构成(无任何可读信息)。
    const degenerate = !cleanSlug || /^[_\-]+$/.test(cleanSlug);
    if (!lossy && !degenerate) {
      // 干净 ASCII:若剥了冗余前缀,cleanSlug 会与 legacySlug(name) 不同(即修双前缀);
      // 否则两者相同 → 输出与 legacy 逐字节一致。
      return type + '_' + cleanSlug + '.md';
    }
    const hash = _shortHash(canon);
    // 剥掉 cleanSlug 首尾分隔符,避免 `cache_` + `_` + hash 拼出双下划线 `cache__hash`。
    const trimmedSlug = cleanSlug.replace(/^[_\-]+|[_\-]+$/g, '');
    const base = trimmedSlug ? trimmedSlug + '_' + hash : hash;
    return type + '_' + base + '.md';
  } catch {
    return legacy;
  }
}

module.exports = {
  slugGateEnabled,
  legacySlug,
  canonicalMemoryName,
  memoryKey,
  buildMemoryFilename,
  _shortHash,
};
