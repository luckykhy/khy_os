'use strict';

/**
 * 还原「解密前」兼容性预检 —— bundled 运行时纯叶（零 IO · 绝不抛）。
 *
 * ── 补的缺口：把 OPS-105 / OPS-110 的诊断能力接进运行时 restore ─────────────
 * 快照头里带着 `format` / `formatVersion`（OPS-105 关注）与 `crypto.algo` /
 * `crypto.kdf` / salt·iv·authTag 材料（OPS-110 关注）。dev 侧早已写好两个纯叶
 * （`scripts/lib/snapshotFormatCompat.js` / `scripts/lib/cryptoSuiteCompat.js`）
 * 能据此判断「本机 khy 到底解不解得开这个快照」——但它们只被 dev CLI 消费，
 * **从未接进运行时还原路径**。运行时 `_restoreFromSnapshot` 解密前唯一守卫只是
 * `header.crypto` 是否存在，然后直接 `decrypt()`；而 `decrypt()` 只认
 * `algo==='aes-256-gcm'` 且**总是跑 scrypt**（从不看 `crypto.kdf`）。于是：
 *   - 未来 `kdf:'argon2'` 的快照 → 运行时盲跑 scrypt 派生出错误密钥 → GCM 认证失败；
 *   - 不支持的 `algo` → decrypt 抛「unsupported crypto header」；
 * 这两种失败在 publish.js 的 catch 里被**一律**改写成误导性的
 * 「该快照由自定义密钥加密，请用 --secret 指定」——把「本机能力缺失、请升级 khy」
 * 谎报成「你密钥/口令错了」。陌生机器上的用户于是一直找错方向。
 *
 * 本叶把这条缺失的解密前预检接上线：给定已解析的快照头，判断本机运行时到底
 * 能否解开，并把「真因」明确出来。
 *
 * ── 二级严重度（block vs warn）：只在「证明性不可解」时硬拦，绝不误伤 ──────────
 * - **block（硬拦，解密前抛可执行错误）**：加密套件不兼容——`algo` 缺失/不受支持、
 *   `kdf` 存在且不受支持、salt/iv/authTag 材料残缺。这些都**证明性地**会让运行时
 *   `decrypt()` 失败（今天只给误导消息），故提前拦下并说清真因 = 严格改善、零误伤。
 * - **warn（告警但继续尝试）**：格式超纲——`format` 陌生、`formatVersion` 过新/过旧。
 *   这些**未必**阻止解密（v2 若只改了 tar 内布局、仍用同套件，v1 khy 也能解出字节），
 *   故只提示、仍尝试，绝不 false-block 一个其实能还原的快照。
 * - **none**：supported（套件齐全受支持、格式在理解区间）/ unverifiable（证据不足）→
 *   静默继续，把权威留给 decrypt 本身。
 *
 * ── 红线密钥卫生 ──────────────────────────────────────────────────────────
 * 本叶只读 `algo`/`kdf` 字符串、`format`/`formatVersion`、以及 salt/iv/authTag 的
 * **存在性布尔**；**绝不**把 salt/iv/authTag 的**值**读进变量或裁决输出。
 */

// 与 services/sourceSnapshotCrypto.js 的运行时套件保持同步（decrypt 真能执行的集合）。
const DEFAULT_SUPPORTED_ALGOS = ['aes-256-gcm'];
const DEFAULT_SUPPORTED_KDFS = ['scrypt'];
const DEFAULT_SUPPORTED_FORMAT = 'khy-source-snapshot';
const DEFAULT_MIN_FORMAT_VERSION = 1;
const DEFAULT_MAX_FORMAT_VERSION = 1;

const STATUS_SUPPORTED = 'supported';                     // 可安心进解密（none）
const STATUS_UNSUPPORTED_ALGO = 'unsupported-algo';       // 对称算法本机做不了（block）
const STATUS_UNSUPPORTED_KDF = 'unsupported-kdf';         // KDF 本机做不了：decrypt 会盲跑 scrypt 误派生（block）
const STATUS_INCOMPLETE_MATERIAL = 'incomplete-material'; // 缺 algo / salt / iv / authTag：快照残缺，非口令错（block）
const STATUS_ALIEN_FORMAT = 'alien-format';               // format 不是 khy 源码快照（warn）
const STATUS_TOO_NEW_FORMAT = 'too-new-format';           // formatVersion 比本机能理解的更新（warn）
const STATUS_TOO_OLD_FORMAT = 'too-old-format';           // formatVersion 早于本机能理解的最早（warn）
const STATUS_UNVERIFIABLE = 'unverifiable';               // 证据不足：保守放行（none）

const SEVERITY_BLOCK = 'block';
const SEVERITY_WARN = 'warn';
const SEVERITY_NONE = 'none';

function _isNonEmptyStr(x) { return typeof x === 'string' && x.length > 0; }
function _isFiniteNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function _inList(list, x) { return Array.isArray(list) && list.indexOf(x) !== -1; }

const _SEVERITY_BY_STATUS = {
  [STATUS_SUPPORTED]: SEVERITY_NONE,
  [STATUS_UNVERIFIABLE]: SEVERITY_NONE,
  [STATUS_UNSUPPORTED_ALGO]: SEVERITY_BLOCK,
  [STATUS_UNSUPPORTED_KDF]: SEVERITY_BLOCK,
  [STATUS_INCOMPLETE_MATERIAL]: SEVERITY_BLOCK,
  [STATUS_ALIEN_FORMAT]: SEVERITY_WARN,
  [STATUS_TOO_NEW_FORMAT]: SEVERITY_WARN,
  [STATUS_TOO_OLD_FORMAT]: SEVERITY_WARN,
};

/** 唯一裁决出口：ok 仅当 supported；block/warn 由状态派生；绝不携带密钥值。 */
function _verdict(status, fields, message) {
  const severity = _SEVERITY_BY_STATUS[status] || SEVERITY_NONE;
  return {
    status,
    severity,
    ok: status === STATUS_SUPPORTED,
    block: severity === SEVERITY_BLOCK,
    warn: severity === SEVERITY_WARN,
    algo: fields.algo == null ? null : String(fields.algo),
    kdf: fields.kdf == null ? null : String(fields.kdf),
    format: fields.format == null ? null : String(fields.format),
    formatVersion: _isFiniteNum(fields.formatVersion) ? fields.formatVersion : null,
    missingMaterial: Array.isArray(fields.missingMaterial) ? fields.missingMaterial.slice() : [],
    message: String(message == null ? '' : message),
  };
}

/**
 * 解密前预检：给定已解析的快照头，判断本机运行时能否安全解开。绝不抛。
 *
 * @param {object} header  解析好的 snapshot.json 对象
 * @param {object} [opts]  可注入的本机支持集（默认对齐 sourceSnapshotCrypto）：
 *   {supportedAlgos, supportedKdfs, supportedFormat, minFormatVersion, maxFormatVersion}
 * @returns {{status:string, severity:string, ok:boolean, block:boolean, warn:boolean,
 *   algo:(string|null), kdf:(string|null), format:(string|null),
 *   formatVersion:(number|null), missingMaterial:string[], message:string}}
 */
function assessRestorePreflight(header, opts) {
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const supportedAlgos = Array.isArray(o.supportedAlgos) ? o.supportedAlgos : DEFAULT_SUPPORTED_ALGOS;
    const supportedKdfs = Array.isArray(o.supportedKdfs) ? o.supportedKdfs : DEFAULT_SUPPORTED_KDFS;
    const supportedFormat = _isNonEmptyStr(o.supportedFormat) ? o.supportedFormat : DEFAULT_SUPPORTED_FORMAT;
    const minV = _isFiniteNum(o.minFormatVersion) ? o.minFormatVersion : DEFAULT_MIN_FORMAT_VERSION;
    const maxV = _isFiniteNum(o.maxFormatVersion) ? o.maxFormatVersion : DEFAULT_MAX_FORMAT_VERSION;

    if (!header || typeof header !== 'object' || Array.isArray(header)) {
      return _verdict(STATUS_UNVERIFIABLE, {}, '缺快照头：无从判断兼容性，保守放行由 decrypt 裁决');
    }

    const c = header.crypto;
    const format = header.format;
    const formatVersion = header.formatVersion;
    const baseFields = { format, formatVersion };

    // ── 1) 加密套件：block 级（证明性不可解优先，绝不误伤）──────────────────
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      // 运行时 _restoreFromSnapshot 已在更上游对「缺 crypto」抛过（此处仅防御）。
      return _verdict(STATUS_UNVERIFIABLE, baseFields,
        '快照头缺 crypto 段：无从判断套件，保守放行由上游/解密裁决');
    }
    const algo = c.algo;
    const kdf = c.kdf;
    const fields = { algo, kdf, format, formatVersion };

    if (!_isNonEmptyStr(algo)) {
      return _verdict(STATUS_INCOMPLETE_MATERIAL, { ...fields, missingMaterial: ['algo'] },
        '快照头缺 crypto.algo：快照残缺（不是口令/密钥错），无法确定解密算法');
    }
    if (!_inList(supportedAlgos, algo)) {
      return _verdict(STATUS_UNSUPPORTED_ALGO, fields,
        `本机 khy 不支持该快照的加密算法（algo='${algo}'，本机仅支持 [${supportedAlgos.join(', ')}]）：`
        + '这通常意味着快照由更新版本的 khy 生成——请先升级 khy 再还原；这不是密钥/口令问题。');
    }
    if (_isNonEmptyStr(kdf) && !_inList(supportedKdfs, kdf)) {
      return _verdict(STATUS_UNSUPPORTED_KDF, fields,
        `本机 khy 不支持该快照的密钥派生函数（kdf='${kdf}'，本机仅支持 [${supportedKdfs.join(', ')}]）：`
        + '若强行还原会误用 scrypt 派生出错误密钥、报成「口令错误」——请先升级 khy 再还原；这不是密钥/口令问题。');
    }
    // 材料完整性：salt/iv/authTag 缺任一 → decrypt 会因 Buffer.from(undefined) 抛天书。
    const missing = [];
    if (!_isNonEmptyStr(c.salt)) missing.push('salt');
    if (!_isNonEmptyStr(c.iv)) missing.push('iv');
    if (!_isNonEmptyStr(c.authTag)) missing.push('authTag');
    if (missing.length > 0) {
      return _verdict(STATUS_INCOMPLETE_MATERIAL, { ...fields, missingMaterial: missing },
        `快照加密材料残缺（缺 ${missing.join(' / ')}）：这是快照损坏/不完整，不是口令/密钥错——请重新获取完整快照。`);
    }

    // ── 2) 格式：warn 级（未必阻止解密，只提示，仍尝试，绝不 false-block）──────
    if (_isNonEmptyStr(format) && format !== supportedFormat) {
      return _verdict(STATUS_ALIEN_FORMAT, fields,
        `⚠️ 快照 format='${format}' 不是 khy 源码快照（应为 '${supportedFormat}'）：仍将尝试还原，若失败请核对来源。`);
    }
    if (_isFiniteNum(formatVersion) && formatVersion > maxV) {
      return _verdict(STATUS_TOO_NEW_FORMAT, fields,
        `⚠️ 快照 formatVersion=${formatVersion} 高于本机 khy 能理解的最新版本（${maxV}）：仍将尝试还原，`
        + '若结果异常请升级 khy 后重试。');
    }
    if (_isFiniteNum(formatVersion) && formatVersion < minV) {
      return _verdict(STATUS_TOO_OLD_FORMAT, fields,
        `⚠️ 快照 formatVersion=${formatVersion} 早于本机 khy 能理解的最早版本（${minV}）：仍将尝试还原，`
        + '若结果异常请核对快照来源。');
    }

    // ── 3) 一切受支持 ────────────────────────────────────────────────────
    return _verdict(STATUS_SUPPORTED, fields, '加密套件与格式均受本机 khy 支持，可安心还原');
  } catch {
    return _verdict(STATUS_UNVERIFIABLE, {}, '预检异常：保守放行由 decrypt 裁决');
  }
}

module.exports = {
  assessRestorePreflight,
  DEFAULT_SUPPORTED_ALGOS,
  DEFAULT_SUPPORTED_KDFS,
  DEFAULT_SUPPORTED_FORMAT,
  DEFAULT_MIN_FORMAT_VERSION,
  DEFAULT_MAX_FORMAT_VERSION,
  STATUS_SUPPORTED,
  STATUS_UNSUPPORTED_ALGO,
  STATUS_UNSUPPORTED_KDF,
  STATUS_INCOMPLETE_MATERIAL,
  STATUS_ALIEN_FORMAT,
  STATUS_TOO_NEW_FORMAT,
  STATUS_TOO_OLD_FORMAT,
  STATUS_UNVERIFIABLE,
  SEVERITY_BLOCK,
  SEVERITY_WARN,
  SEVERITY_NONE,
};
