'use strict';

/**
 * 还原「解密后、解包前」内层归档形制可提取性把关 —— bundled 运行时纯叶（零 IO · 绝不抛）。
 *
 * ── 补的缺口：把 archiveExtractCompat 的诊断能力接进运行时 restore ─────────────
 * 快照头（snapshot.json）由 makeSourceSnapshot.js 盖两枚**内层归档**印章：
 *   plaintextFormat: 'tar.gz'      ← 「密文解密后是一团 tar.gz，请用 gzip+tar 解包」
 *   layout:          'git-archive' ← 「这团 tar 的内部布局是 git archive（尊重 .gitignore、无 .git）」
 * 这两枚印章描述**解密之后**那层归档的形制。dev 侧早已写好纯叶
 * `scripts/lib/archiveExtractCompat.js` 能据此判断「本机 tar -xzf 认不认识这团解密归档」，
 * 但它**只被 dev CLI 消费**（restore-check-archive.js / restore-effect-probe.js），
 * **从未接进运行时还原路径**。运行时 `_restoreFromSnapshot` 解密 + sha256 校验后，
 * 直接把 `tar -xzf` 写死（`_extractTarGz`），**从不读 plaintextFormat / layout**——
 * grep 这两个字段在整个运行时还原代码里零消费者 = 死字段（断桥）。后果在离机场景最毒：
 *   · 未来某版 khy 改用 `tar.zst` / `zip` 打包源码（plaintextFormat 变），陌生机器上的**旧** khy
 *     仍盲目 `tar -xzf`：gzip 魔数对不上 → 抛一句解包天书，或更糟——半个目录被误当 gzip 流吐出。
 *   · layout 若从 'git-archive' 变成含 .git 的全量 tar，语义已不同（还原横幅仍印「目录布局原样」骗人），
 *     却没有任何一层先问「这归档形制我认得吗」。
 * 本叶把这条缺失的**解包前**消费者接上线：给定已解析的快照头，判断本机 `tar -xzf`
 * 到底认不认识这团解密归档，并把「真因」明确出来（取代盲目解包的天书 / 假绿）。
 *
 * ── 和已接线的 restorePreflightCheck 正交（别混淆）────────────────────────────
 *   · restorePreflightCheck（解密**前**）：管**外层快照信封**（format/formatVersion）与
 *     **加密套件**（crypto.algo/kdf/salt·iv·authTag）——「这是不是 khy 快照 / 本机解不解得开密文」。
 *   · 本叶（解密**后**、解包**前**）：管**内层归档形制**（plaintextFormat/layout）——
 *     「密文解开成一团归档后，本机 tar -xzf 认不认识、解不解得包」。两者读的字段完全不重叠。
 *
 * ── 二级严重度（block vs warn）：只在「证明性不可解」时硬拦，绝不误伤 ──────────
 * - **block（硬拦，解包前抛可执行错误）**：unsupported-format——plaintextFormat 不在本机
 *   `tar -xzf` 支持集。这**证明性地**会让盲目 tar -xzf 解出天书/半个目录，故提前拦下说清真因
 *   （请升级 khy），取代下方误导性的解包失败 = 严格改善、零误伤。
 * - **warn（告警但继续尝试）**：unknown-layout——格式可解压但 layout **存在且**陌生。
 *   tar -xzf 仍能解出字节，只是别信「目录布局原样」，故只提示、仍解包，绝不 false-block。
 * - **none**：supported（形制认识）/ unverifiable（证据不足）→ 静默继续，权威留给 tar 本身。
 *
 * ── 红线 ────────────────────────────────────────────────────────────────────
 * · 只读既有事实（plaintextFormat/layout 字符串），绝不臆造 supported：形制陌生/证据不足 → 拒绝放行。
 * · ok===true 仅当 status==='supported'；layout 缺省是老快照合法向后兼容情形（格式支持即放行，
 *   不因缺 layout 卡死），但 layout 一旦**存在**就必须是认识的形制。
 * · 纯计算、零 IO、无时钟、无随机、绝不抛：任何字段缺失/非法 → 保守。不碰任何密钥。
 *
 * ── HOW-TO-EXTEND（抄写式）──────────────────────────────────────────────────
 * 当源码打包的内层归档形制变更时：① 在 makeSourceSnapshot.js 改 plaintextFormat/layout 盖章值；
 * ② 只有当还原侧 `_extractTarGz` 解包器**真支持**了该形制，才把对应值加进
 *   SUPPORTED_PLAINTEXT_FORMATS / SUPPORTED_LAYOUTS——别为了绿灯谎报；③ 新增判定档按**保守优先**
 *   插进判定链正确位置（越像「不该说 supported」越靠前），并在 _SEVERITY_BY_STATUS 表登记严重度。
 */

// 本机还原解包器（_extractTarGz → `tar -xzf`）真能解开的内层归档形制。
// 改解包实现时按 HOW-TO-EXTEND 同步；只登记「解包器真支持」的值。
const SUPPORTED_PLAINTEXT_FORMATS = ['tar.gz'];   // gzip 压缩的 tar，`tar -xzf` 能解
const SUPPORTED_LAYOUTS = ['git-archive'];        // git archive 生成的布局（尊重 .gitignore、无 .git）

const STATUS_SUPPORTED = 'supported';                     // 形制认识、tar -xzf 能处理（none）
const STATUS_UNSUPPORTED_FORMAT = 'unsupported-format';   // plaintextFormat 本机 tar -xzf 不支持（block）
const STATUS_UNKNOWN_LAYOUT = 'unknown-layout';           // 可解压但 layout 陌生（warn）
const STATUS_UNVERIFIABLE = 'unverifiable';               // 证据不足：保守放行（none）

const SEVERITY_BLOCK = 'block';
const SEVERITY_WARN = 'warn';
const SEVERITY_NONE = 'none';

const _SEVERITY_BY_STATUS = {
  [STATUS_SUPPORTED]: SEVERITY_NONE,
  [STATUS_UNVERIFIABLE]: SEVERITY_NONE,
  [STATUS_UNSUPPORTED_FORMAT]: SEVERITY_BLOCK,
  [STATUS_UNKNOWN_LAYOUT]: SEVERITY_WARN,
};

function _isNonEmptyStr(x) { return typeof x === 'string' && x.length > 0; }
function _inList(list, x) { return Array.isArray(list) && list.indexOf(x) !== -1; }

/** 唯一裁决出口：ok 仅当 supported；block/warn 由状态派生；绝不携带密钥值。 */
function _verdict(status, plaintextFormat, layout, message) {
  const severity = _SEVERITY_BY_STATUS[status] || SEVERITY_NONE;
  return {
    status,
    severity,
    ok: status === STATUS_SUPPORTED,
    block: severity === SEVERITY_BLOCK,
    warn: severity === SEVERITY_WARN,
    plaintextFormat: typeof plaintextFormat === 'string' ? plaintextFormat : null,
    layout: typeof layout === 'string' ? layout : null,
    supportedFormats: SUPPORTED_PLAINTEXT_FORMATS.slice(),
    supportedLayouts: SUPPORTED_LAYOUTS.slice(),
    message: String(message == null ? '' : message),
  };
}

/**
 * 解包前把关：给定已解析的快照头，判断本机 `tar -xzf` 能否解开这团解密后的内层归档。绝不抛。
 *
 * @param {object} header  解析好的 snapshot.json 对象
 * @param {object} [opts]  可注入的本机支持集（默认对齐 _extractTarGz 的真实能力）：
 *   {supportedFormats, supportedLayouts}
 * @returns {{status:string, severity:string, ok:boolean, block:boolean, warn:boolean,
 *   plaintextFormat:(string|null), layout:(string|null),
 *   supportedFormats:string[], supportedLayouts:string[], message:string}}
 */
function assessArchiveExtractCompat(header, opts) {
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const supportedFormats = Array.isArray(o.supportedFormats) ? o.supportedFormats : SUPPORTED_PLAINTEXT_FORMATS;
    const supportedLayouts = Array.isArray(o.supportedLayouts) ? o.supportedLayouts : SUPPORTED_LAYOUTS;

    // 1) 证据不足：头非对象 / 是数组（typeof []==='object' 陷阱须显式排除）/ plaintextFormat 缺失或非串。
    if (!header || typeof header !== 'object' || Array.isArray(header)) {
      return _verdict(STATUS_UNVERIFIABLE, null, null,
        '缺快照头：无从判断内层归档形制，保守放行由 tar 裁决');
    }
    const plaintextFormat = header.plaintextFormat;
    const layout = header.layout;
    if (!_isNonEmptyStr(plaintextFormat)) {
      return _verdict(STATUS_UNVERIFIABLE, plaintextFormat, layout,
        '快照头缺 plaintextFormat（或非非空字符串）：无从确认解密后是哪种归档，保守放行由 tar 裁决');
    }

    // 2) 格式不支持：block——本机 tar -xzf 解不开这团解密归档，盲目解包只会解出天书。
    if (!_inList(supportedFormats, plaintextFormat)) {
      return _verdict(STATUS_UNSUPPORTED_FORMAT, plaintextFormat, layout,
        `本机 khy 的解包器不认识该快照的归档格式（plaintextFormat='${plaintextFormat}'，`
        + `本机 tar -xzf 仅支持 [${supportedFormats.join(', ')}]）：`
        + '这通常意味着快照由更新版本的 khy 生成——请先升级 khy 再还原；盲目解包只会解出损坏内容。');
    }

    // 3) 布局陌生：warn——格式可解压但 layout 存在且不认识，别信「目录布局原样」。
    //    （layout 缺省是老快照合法向后兼容情形，不在此卡；只有「存在但陌生」才 warn。）
    if (_isNonEmptyStr(layout) && !_inList(supportedLayouts, layout)) {
      return _verdict(STATUS_UNKNOWN_LAYOUT, plaintextFormat, layout,
        `⚠️ 快照可解压，但目录布局形制陌生（layout='${layout}'，本机认识 `
        + `[${supportedLayouts.join(', ')}]）：仍将解包，但请勿当作「目录布局原样」，还原后自行核对结构。`);
    }

    // 4) 形制认识：唯一可安心交给 tar -xzf 的档。
    return _verdict(STATUS_SUPPORTED, plaintextFormat, layout,
      `内层归档形制受本机解包器支持（plaintextFormat='${plaintextFormat}'），可继续解包还原`);
  } catch {
    return _verdict(STATUS_UNVERIFIABLE, null, null, '把关异常：保守放行由 tar 裁决');
  }
}

module.exports = {
  assessArchiveExtractCompat,
  SUPPORTED_PLAINTEXT_FORMATS,
  SUPPORTED_LAYOUTS,
  STATUS_SUPPORTED,
  STATUS_UNSUPPORTED_FORMAT,
  STATUS_UNKNOWN_LAYOUT,
  STATUS_UNVERIFIABLE,
  SEVERITY_BLOCK,
  SEVERITY_WARN,
  SEVERITY_NONE,
};
