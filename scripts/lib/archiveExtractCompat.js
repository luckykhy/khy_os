'use strict';

/**
 * archiveExtractCompat.js — 还原「解密后归档形制可提取性 / decrypted-archive extract compatibility」纯叶子（零 IO · 绝不抛）
 *
 * 还原家族第十五层，闭合一条**内层归档形制断桥（unchecked-archive-shape false-GREEN）**，
 * 直击用户最在意的「完整的**简单**的还原」——解密之后、真正 `tar -xzf` 之前，
 * 还原代码从没确认过「我的解包器认不认识这团解密出来的归档」。
 *
 * ── 它补的缺口：快照头里的 plaintextFormat / layout 是死字段 ──────────────────────
 * 快照构建期 makeSourceSnapshot.js 给每个快照头（snapshot.json）盖两枚**内层归档**印章：
 *   plaintextFormat: 'tar.gz'      ← 「密文解密后是一团 tar.gz，请用 gzip+tar 解包」
 *   layout:          'git-archive' ← 「这团 tar 的内部布局是 git archive（尊重 .gitignore，无 .git）」
 * 这两枚印章描述的是**解密之后**那层归档的形制。但还原/自愈侧的解包器
 * （sourceHealService._extractTarGz、cli/handlers/publish.js 的 restore 提取）
 * **把 `tar -xzf` 写死**，从不读 plaintextFormat / layout——grep 这两个字段在整个
 * 还原代码库里**零消费者**。后果在离机场景最毒：
 *   · 未来某版 khy 改用 `tar.zst` / `zip` 打包源码（plaintextFormat 变），陌生机器上的**旧** khy
 *     仍盲目 `tar -xzf`：gzip 头对不上 → 抛一句解包天书，或更糟——部分字节被误当 gzip 流吐出半个目录。
 *   · layout 若从 'git-archive' 变成含 .git 的全量 tar，语义已不同（还原横幅仍印「目录布局原样」骗人），
 *     却没有任何一层先问「这归档形制我认得吗」。
 * plaintextFormat/layout 上游花心思盖章、跨渠道送达、下游能读，却**在解包前无人据此把关** =
 * 死字段（断桥）。本层就是那个缺失的**解包前**消费者。
 *
 * ── 它和家族其它层的正交关系（别混淆）──────────────────────────────────────────────
 *   · 第十三层 105 snapshotFormatCompat：管**外层快照信封**契约（format/formatVersion）——「这是不是 khy 快照」。
 *   · 第十四层 107 restoreProvenance：管**git 来源**（captureMode/includesUncommitted）——「这源码等于哪个提交」。
 *   · 第十二层 095 completenessVerifier：管**解包后文件数**——「落地数量对得上清单吗」。
 *   · 本层 archiveExtractCompat：管**解密后、解包前的内层归档形制**（plaintextFormat/layout）——
 *     「我的 tar -xzf 解包器认不认识这团解密归档」。位置恰在「信封看得懂(105)」之后、「解包完整(095)」之前。
 *
 * ── 怎么判：解包能力门（最保守优先）────────────────────────────────────────────────
 * checkArchiveExtractCompat(header) 纯函数，绝不抛。header = 解析好的 snapshot.json 对象。
 *   1) header 非对象/数组 / plaintextFormat 非非空串        → unverifiable（证据不足，绝不谎报 supported）。
 *   2) plaintextFormat ∉ SUPPORTED_PLAINTEXT_FORMATS        → unsupported-format（本机解包器 tar -xzf 处理不了，先升级 khy）。
 *   3) 格式可解包，但 layout 是非空串且 ∉ SUPPORTED_LAYOUTS  → unknown-layout（能解压但内部布局形制陌生，别信「原样」）。
 *   4) plaintextFormat ∈ 支持集，且（layout 缺省 / ∈ 支持集） → supported（唯一可安心交给解包器的档）。
 * 裁决 = { status, ok, plaintextFormat, layout, supportedFormats, supportedLayouts, reason }。
 *
 * ── 恒久红线（继承全家族）────────────────────────────────────────────────────────
 * · 只读既有事实，绝不臆造 supported：形制陌生 / 证据不足 → 拒绝放行，别喂给 tar -xzf。
 * · ok===true 仅当 status==='supported'；其余一律 ok:false。
 * · layout 缺省是向后兼容的合法情形（老快照可能没盖 layout 章）：格式支持即可放行，不因缺 layout 卡死；
 *   但 layout 一旦**存在**就必须是认识的形制（存在即须可核验，呼应 107 的「正面证据」哲学）。
 *
 * ── 纯度边界 ─────────────────────────────────────────────────────────────────────
 * 纯计算、零 IO、无时钟、无随机、绝不抛：任何字段缺失 / 非法 → 保守。
 * 真正读 snapshot.json、落地文件的 IO 在 CLI scripts/restore-check-archive.js 里，
 * 单独隔离且 fail-soft；本文件只对「已采好的头对象」做纯判断。
 *
 * ── HOW-TO-EXTEND（抄写式）───────────────────────────────────────────────────────
 * 当源码打包的**内层归档形制**发生变更时：
 *   ① 在 makeSourceSnapshot.js 改 `plaintextFormat` / `layout` 的盖章值；
 *   ② 若还原侧解包器新增了对该形制的支持（如新增 tar.zst 解压分支），把对应值加进
 *      SUPPORTED_PLAINTEXT_FORMATS / SUPPORTED_LAYOUTS；**只有解包器真支持了才加**——
 *      本门的承诺是「加进支持集 = 本机 tar -xzf 家族真能解开」，别为了绿灯谎报。
 *   ③ 新增判定档时按**保守优先**插进判定链正确位置（越像「不该说 supported」越靠前），
 *      并在下方 _STATUS 常量表登记。ok 的定义只有一个出口 _verdict——status==='supported' 才 ok:true。
 */

// 本机还原解包器（sourceHealService._extractTarGz → `tar -xzf`）真能解开的内层归档形制。
// 改解包实现时按 HOW-TO-EXTEND 同步调整；只登记「解包器真支持」的值。
const SUPPORTED_PLAINTEXT_FORMATS = ['tar.gz'];   // gzip 压缩的 tar，`tar -xzf` 能解
const SUPPORTED_LAYOUTS = ['git-archive'];        // git archive 生成的布局（尊重 .gitignore、无 .git）

// 单一裁决的状态枚举（_STATUS 表：新增判定档时在此登记）。
const STATUS_SUPPORTED = 'supported';               // 形制认识、解包器能处理：可安心交给 tar -xzf。
const STATUS_UNSUPPORTED_FORMAT = 'unsupported-format'; // plaintextFormat 本机解包器不支持：先升级 khy。
const STATUS_UNKNOWN_LAYOUT = 'unknown-layout';     // 格式可解压但内部布局形制陌生：别信「目录原样」。
const STATUS_UNVERIFIABLE = 'unverifiable';         // 证据不足：保守，绝不谎报 supported。

/** 非空字符串判定。 */
function _isNonEmptyStr(x) {
  return typeof x === 'string' && x.length > 0;
}

/** 支持集包含判定（大小写敏感——归档格式串是精确契约值，不做归一）。 */
function _inList(list, value) {
  return Array.isArray(list) && list.indexOf(value) !== -1;
}

/**
 * 唯一构造裁决的出口：ok 只在 status==='supported' 时为真。红线只需在此一处把守。
 */
function _verdict(status, plaintextFormat, layout, reason) {
  return {
    status,
    ok: status === STATUS_SUPPORTED,
    plaintextFormat: typeof plaintextFormat === 'string' ? plaintextFormat : null,
    layout: typeof layout === 'string' ? layout : null,
    supportedFormats: SUPPORTED_PLAINTEXT_FORMATS.slice(),
    supportedLayouts: SUPPORTED_LAYOUTS.slice(),
    reason: String(reason || ''),
  };
}

/**
 * 判定一个已解析的快照头描述的**解密后内层归档**，本机还原解包器认不认识、解不解得开。绝不抛。
 *
 * @param {object} header  解析好的 snapshot.json 对象
 * @returns {{status:string, ok:boolean, plaintextFormat:(string|null), layout:(string|null),
 *            supportedFormats:string[], supportedLayouts:string[], reason:string}}
 */
function checkArchiveExtractCompat(header) {
  // 1) 证据不足：头非对象 / 是数组（typeof []==='object' 的经典陷阱，须显式排除）/ plaintextFormat 缺失。
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    return _verdict(STATUS_UNVERIFIABLE, null, null,
      '缺快照头（snapshot.json 缺失 / 非对象 / 是数组）：无从判断内层归档形制，绝不默认交给解包器');
  }
  const plaintextFormat = header.plaintextFormat;
  const layout = header.layout;
  if (!_isNonEmptyStr(plaintextFormat)) {
    return _verdict(STATUS_UNVERIFIABLE, plaintextFormat, layout,
      '快照头缺 plaintextFormat 字段（或非非空字符串）：无从确认解密后是哪种归档，绝不盲目 tar -xzf');
  }

  // 2) 格式不支持：解密后的归档形制本机解包器（tar -xzf）处理不了 → 拒绝，让用户升级 khy。
  //    这是核心断桥所在：旧 khy 遇到未来 tar.zst/zip 快照，盲目 tar -xzf 只会解出天书。
  if (!_inList(SUPPORTED_PLAINTEXT_FORMATS, plaintextFormat)) {
    return _verdict(STATUS_UNSUPPORTED_FORMAT, plaintextFormat, layout,
      `plaintextFormat='${plaintextFormat}' 不在本机解包器支持集 [${SUPPORTED_PLAINTEXT_FORMATS.join(', ')}]：`
      + '本机 tar -xzf 解不开这团归档，请先升级 khy 再还原，勿盲目解包');
  }

  // 3) 布局形制陌生：格式能解压，但 layout 存在且不是认识的形制 → 别信还原横幅的「目录原样」。
  //    （layout 缺省是老快照的合法向后兼容情形，不在此卡；只有「存在但陌生」才拦。）
  if (_isNonEmptyStr(layout) && !_inList(SUPPORTED_LAYOUTS, layout)) {
    return _verdict(STATUS_UNKNOWN_LAYOUT, plaintextFormat, layout,
      `plaintextFormat='${plaintextFormat}' 可解压，但 layout='${layout}' 不在支持集 `
      + `[${SUPPORTED_LAYOUTS.join(', ')}]：能解开却不认识内部布局形制，别当作「目录布局原样」`);
  }

  // 4) 形制认识、解包器能处理：唯一可安心交给 tar -xzf 的档。
  const layoutNote = _isNonEmptyStr(layout) ? `layout='${layout}'` : 'layout 缺省（老快照，可容忍）';
  return _verdict(STATUS_SUPPORTED, plaintextFormat, layout,
    `plaintextFormat='${plaintextFormat}' 在支持集 · ${layoutNote}：`
    + '内层归档形制本机解包器认识，可继续解包还原');
}

module.exports = {
  checkArchiveExtractCompat,
  SUPPORTED_PLAINTEXT_FORMATS,
  SUPPORTED_LAYOUTS,
  STATUS_SUPPORTED,
  STATUS_UNSUPPORTED_FORMAT,
  STATUS_UNKNOWN_LAYOUT,
  STATUS_UNVERIFIABLE,
  _verdict,
  _isNonEmptyStr,
  _inList,
};
