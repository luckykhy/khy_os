'use strict';

/**
 * snapshotFormatCompat.js — 还原「快照格式兼容性 / snapshot-format compatibility」纯叶子（零 IO · 绝不抛）
 *
 * 还原家族第十三层，闭合一条**格式契约断桥（unchecked-format false-GREEN）**，
 * 直击用户最在意的那句「完整的**简单**的还原」——简单的前提是「还原代码先确认自己看得懂这个快照」。
 *
 * ── 它补的缺口：快照头里的 format / formatVersion 是死字段 ────────────────────────
 * 快照构建期 makeSourceSnapshot.js 给每个快照头（snapshot.json）盖两枚契约印章：
 *   format:        'khy-source-snapshot'   ← 「这确实是 khy 源码快照，不是别的什么 tar」
 *   formatVersion: 1                        ← 「快照头/密文布局的 schema 版本」
 * 这两枚印章随 pip/npm 包漂洋过海到陌生机器。但还原/自愈侧（sourceHealService.decrypt、
 * cli/handlers/publish.js 的 restore 处理器）**只校验 `crypto.algo === 'aes-256-gcm'`，
 * 从不校验 `format` / `formatVersion`**——grep `'khy-source-snapshot'` 在整个还原代码库里
 * **零消费者**。后果在离机场景最毒：
 *   · 陌生机器上装的是**旧** khy（旧还原代码），却拿到一个**未来** formatVersion=2 的快照
 *     （密文/头布局已变但 crypto.algo 仍是 aes-256-gcm）→ 旧代码盲目解密：要么抛一句
 *     密码学天书（"unable to authenticate data"），要么更糟——静默按旧布局误解析新快照。
 *   · 或者 snapshot.json 根本不是 khy 快照（用户复制错了目录 / 第三方 tar）→ 没有任何
 *     一层先问一句「这是我认识的格式吗」，直接进解密。
 * format/formatVersion 上游花心思盖章、跨渠道送达、下游能读，却**在还原前无人据此把关** =
 * 死字段（断桥）。本层就是那个缺失的**前置**消费者：在完整性对账（第十二层 095）之前，
 * 先回答最基础的一问——「这个快照的格式，我这台 khy 的还原代码到底看不看得懂？」
 *
 * ── 怎么判：格式契约门（最保守优先）────────────────────────────────────────────
 * checkSnapshotFormatCompat(header) 纯函数，绝不抛。header = 解析好的 snapshot.json 对象。
 *   1) header 非对象 / format 非串 / formatVersion 非有限数  → unverifiable（证据不足，绝不谎报 supported）。
 *   2) format !== 'khy-source-snapshot'                      → alien（这不是 khy 源码快照，别信）。
 *   3) formatVersion > MAX_FORMAT_VERSION                    → too-new（快照比本机还原代码更新，先升级 khy）。
 *   4) formatVersion < MIN_FORMAT_VERSION                    → too-old（快照格式早于本机能理解的最早版本）。
 *   5) MIN ≤ formatVersion ≤ MAX（且 2 通过）                → supported（唯一可安心继续还原的档）。
 * 裁决 = { status, ok, format, formatVersion, understoodMin, understoodMax, reason }。
 *
 * ── 恒久红线（继承全家族）────────────────────────────────────────────────────────
 * · 只读既有事实，绝不臆造 supported：任何证据不足 / 格式陌生 / 版本超纲 → 拒绝放行。
 * · ok===true 仅当 status==='supported'；alien/too-new/too-old/unverifiable 一律 ok:false。
 * · 这是**前置**门（先于完整性对账 095、授权 088、导航 090）——看不懂格式，后面所有诊断都无意义。
 *
 * ── 纯度边界 ─────────────────────────────────────────────────────────────────────
 * 纯计算、零 IO、无时钟、无随机、绝不抛：任何字段缺失 / 非法 → 保守 unverifiable。
 * 真正读 snapshot.json、落地文件的 IO 在 CLI scripts/restore-check-format.js 里，
 * 单独隔离且 fail-soft；本文件只对「已采好的头对象」做纯判断。
 *
 * ── HOW-TO-EXTEND（抄写式）───────────────────────────────────────────────────────
 * 当快照头/密文布局发生**不向后兼容**的变更时：
 *   ① 在 makeSourceSnapshot.js 把 `formatVersion` 递增（如 1 → 2）；
 *   ② 若新版还原代码仍能读旧版，保持 MIN_FORMAT_VERSION 不动、把 MAX_FORMAT_VERSION 提到新值；
 *      若旧版不再可读，同时抬 MIN。始终维持 MIN ≤ MAX。
 *   ③ 新增判定档时按**保守优先**插进判定链正确位置（越像「不该说 supported」越靠前），
 *      并在下方 _STATUS 常量表登记它的 status 名。ok 的定义只有一个出口 _verdict——
 *      status==='supported' 才 ok:true，别在别处放行。
 */

// 本机还原代码能理解的快照格式契约（改布局时按 HOW-TO-EXTEND 调整）。
const SUPPORTED_FORMAT = 'khy-source-snapshot';
const MIN_FORMAT_VERSION = 1; // 能读的最早 schema 版本
const MAX_FORMAT_VERSION = 1; // 能读的最新 schema 版本

// 单一裁决的状态枚举（_STATUS 表：新增判定档时在此登记）。
const STATUS_SUPPORTED = 'supported';       // 格式认识、版本在理解区间：可安心继续还原。
const STATUS_TOO_NEW = 'too-new';           // 版本 > 能理解的最新：快照比本机 khy 新，先升级。
const STATUS_TOO_OLD = 'too-old';           // 版本 < 能理解的最早：格式过旧，勿用旧解析误读。
const STATUS_ALIEN = 'alien';               // format 不是 khy 源码快照：这不是我们认识的东西。
const STATUS_UNVERIFIABLE = 'unverifiable'; // 证据不足：保守，绝不谎报 supported。

/** 有限数判定（NaN / Infinity / 非数字一律 false）。 */
function _isFiniteNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * 唯一构造裁决的出口：ok 只在 status==='supported' 时为真。红线只需在此一处把守。
 */
function _verdict(status, format, formatVersion, reason) {
  return {
    status,
    ok: status === STATUS_SUPPORTED,
    format: typeof format === 'string' ? format : null,
    formatVersion: _isFiniteNum(formatVersion) ? formatVersion : null,
    understoodMin: MIN_FORMAT_VERSION,
    understoodMax: MAX_FORMAT_VERSION,
    reason: String(reason || ''),
  };
}

/**
 * 判定一个已解析的快照头是否是本机还原代码能理解的格式。绝不抛。
 *
 * @param {object} header  解析好的 snapshot.json 对象
 * @returns {{status:string, ok:boolean, format:(string|null), formatVersion:(number|null),
 *            understoodMin:number, understoodMax:number, reason:string}}
 */
function checkSnapshotFormatCompat(header) {
  // 1) 证据不足：头非对象，或契约字段缺失 / 类型错。保守，绝不谎报 supported。
  if (!header || typeof header !== 'object') {
    return _verdict(STATUS_UNVERIFIABLE, null, null,
      '缺快照头（snapshot.json 缺失 / 非对象）：无从判断格式，绝不默认放行');
  }
  const format = header.format;
  const formatVersion = header.formatVersion;
  if (typeof format !== 'string' || format.length === 0) {
    return _verdict(STATUS_UNVERIFIABLE, format, formatVersion,
      '快照头缺 format 字段（或非字符串）：无从确认这是不是 khy 源码快照');
  }
  if (!_isFiniteNum(formatVersion)) {
    return _verdict(STATUS_UNVERIFIABLE, format, formatVersion,
      '快照头缺 formatVersion 字段（或非有限数）：无从确认格式版本');
  }

  // 2) 格式陌生：字段齐全但不是 khy 源码快照。别信、别解密。
  if (format !== SUPPORTED_FORMAT) {
    return _verdict(STATUS_ALIEN, format, formatVersion,
      `format='${format}' 不是 khy 源码快照（应为 '${SUPPORTED_FORMAT}'）：这不是本机认识的还原对象`);
  }

  // 3) 版本超纲（更新）：快照由更新的 khy 生成，本机还原代码看不懂新布局 → 拒绝，让用户升级 khy。
  if (formatVersion > MAX_FORMAT_VERSION) {
    return _verdict(STATUS_TOO_NEW, format, formatVersion,
      `快照 formatVersion=${formatVersion} 比本机还原代码能理解的最新版本（${MAX_FORMAT_VERSION}）更新：`
      + '请先升级 khy 再还原，勿用旧解析盲目读新快照');
  }

  // 4) 版本超纲（更旧）：早于本机能理解的最早版本 → 拒绝，勿用新解析误读旧布局。
  if (formatVersion < MIN_FORMAT_VERSION) {
    return _verdict(STATUS_TOO_OLD, format, formatVersion,
      `快照 formatVersion=${formatVersion} 早于本机能理解的最早版本（${MIN_FORMAT_VERSION}）：`
      + '格式过旧，勿用当前解析误读');
  }

  // 5) 认识且在理解区间：唯一可安心继续还原的档。
  return _verdict(STATUS_SUPPORTED, format, formatVersion,
    `format='${format}' · formatVersion=${formatVersion} 在本机理解区间 `
    + `[${MIN_FORMAT_VERSION},${MAX_FORMAT_VERSION}]：格式兼容，可继续还原`);
}

module.exports = {
  checkSnapshotFormatCompat,
  SUPPORTED_FORMAT,
  MIN_FORMAT_VERSION,
  MAX_FORMAT_VERSION,
  STATUS_SUPPORTED,
  STATUS_TOO_NEW,
  STATUS_TOO_OLD,
  STATUS_ALIEN,
  STATUS_UNVERIFIABLE,
  _verdict,
  _isFiniteNum,
};
