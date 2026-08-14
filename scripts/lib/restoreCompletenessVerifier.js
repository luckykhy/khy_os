'use strict';

/**
 * restoreCompletenessVerifier.js — 还原「解包完整性 / extraction-completeness」纯叶子（零 IO · 绝不抛）
 *
 * 还原家族第十二层，闭合一条**诚实性断桥（silent-under-extraction false-GREEN）**，
 * 直击用户最在意的那句「**完整**的简单的还原」。
 *
 * ── 它补的缺口：快照头里的 fileCount 是个死字段 ──────────────────────────────────
 * 快照构建期 makeSourceSnapshot.js 用 `git ls-tree -r --name-only` 数出 tar 里应有的文件数，
 * 写进 snapshot.json 的 `fileCount`；这个数随 pip/npm 包漂洋过海到陌生机器。但还原侧
 * handleRestore 只在成功横幅里**打印**它（"共 N 个文件"），**从不拿它跟磁盘上真正落地的文件数
 * 对账**——`_extractTarGz` 只看 `tar` 的退出码。tar 退出 0 却少解了文件的情况真实存在：磁盘
 * 中途写满、路径过长（Windows MAX_PATH）、不被支持的条目类型、权限/符号链接被跳过……此时用户
 * 看到的是绿字「源码已完整还原」，磁盘上却缺文件 = **对用户最重要那条路径上的最毒假绿**。
 * fileCount 上游花力气产出、跨渠道送达、下游能读，却在最后一步无人消费 = **死字段（断桥）**。
 * 本层就是那个缺失的消费者：把「期望文件数」与「实际落地文件数」对账，给出诚实裁决。
 *
 * ── 怎么判：对账 + 前置门（最保守优先）──────────────────────────────────────────
 * verifyExtractionCompleteness(facts) 纯函数，绝不抛。facts:
 *   { expectedFileCount, actualFileCount, sha256Verified, tarExitZero }
 *   1) 前置证据不足（expected 非有限正数 / actual 非有限非负数）→ unverifiable（保守，绝不谎报 complete）。
 *   2) sha256Verified===false 或 tarExitZero===false → corrupt（密文/解包阶段已失败，完整性无从谈起）。
 *   3) actual < expected            → incomplete（**静默少解**——这正是断桥要抓的假绿）。
 *   4) actual > expected            → over-extracted（多出文件：目标目录本就有残留 / 快照口径漂移，提示人核对）。
 *   5) actual === expected（且 2 通过）→ complete（唯一可安心说「完整还原」的档）。
 * 裁决 = { status, ok, expected, actual, missing, extra, reason }。missing/extra 是给人看的差额。
 *
 * ── 恒久红线（继承全家族）────────────────────────────────────────────────────────
 * · 只读既有事实，绝不臆造 complete：任何证据不足 → unverifiable，绝不默认放行。
 * · ok===true 仅当 status==='complete'；incomplete/corrupt/over-extracted/unverifiable 一律 ok:false。
 *
 * ── 纯度边界 ─────────────────────────────────────────────────────────────────────
 * 纯计算、零 IO、无时钟、无随机、绝不抛：任何字段缺失 / 非法 → 保守 unverifiable。
 * 真正 stat 磁盘、读 snapshot.json、数文件的 IO 在 CLI scripts/restore-verify-complete.js 里，
 * 单独隔离且 fail-soft；本文件只对「已采好的事实」做纯判断。
 *
 * ── HOW-TO-EXTEND（抄写式）───────────────────────────────────────────────────────
 * 新增一档判定时：按**保守优先**插进 verifyExtractionCompleteness 的判定链正确位置（越像
 * 「不该说 complete」越靠前），并在下方 _STATUS 常量表登记它的 status 名。ok 的定义只有一个
 * 出口 _verdict——status==='complete' 才 ok:true，别在别处放行。
 */

// 单一裁决的状态枚举（_STATUS 表：新增判定档时在此登记）。
const STATUS_COMPLETE = 'complete';         // 期望数 === 实际数 且前置校验通过：可安心说「完整还原」。
const STATUS_INCOMPLETE = 'incomplete';     // 实际 < 期望：静默少解（断桥要抓的假绿）。
const STATUS_OVER_EXTRACTED = 'over-extracted'; // 实际 > 期望：目标残留 / 口径漂移，提示人核对。
const STATUS_CORRUPT = 'corrupt';           // sha256 / tar 阶段已失败：完整性无从谈起。
const STATUS_UNVERIFIABLE = 'unverifiable'; // 证据不足：保守，绝不谎报 complete。

/** 有限数判定（NaN / Infinity / 非数字一律 false）。 */
function _isFiniteNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * 唯一构造裁决的出口：ok 只在 status==='complete' 时为真。红线只需在此一处把守。
 */
function _verdict(status, expected, actual, reason) {
  const exp = _isFiniteNum(expected) ? expected : null;
  const act = _isFiniteNum(actual) ? actual : null;
  const diff = (exp != null && act != null) ? act - exp : null;
  return {
    status,
    ok: status === STATUS_COMPLETE,
    expected: exp,
    actual: act,
    // missing/extra：给人看的差额（只在两数都有时才有意义）。
    missing: diff != null && diff < 0 ? -diff : 0,
    extra: diff != null && diff > 0 ? diff : 0,
    reason: String(reason == null ? '' : reason),
  };
}

/**
 * 对账「快照期望文件数」与「解包后实际落地文件数」，给出诚实的完整性裁决。绝不抛。
 *
 * @param {object} facts
 *   @param {number} facts.expectedFileCount - 快照头 fileCount（git ls-tree -r 数出的 tar 应有文件数）。
 *   @param {number} facts.actualFileCount   - 解包后目标目录里真正数到的常规文件数。
 *   @param {boolean}[facts.sha256Verified]  - 解密后明文 sha256 是否已与快照头匹配（restore 已做，默认视为 true）。
 *   @param {boolean}[facts.tarExitZero]     - tar 解包是否退出 0（restore 已保证，默认视为 true）。
 * @returns {{status,ok,expected,actual,missing,extra,reason}}
 */
function verifyExtractionCompleteness(facts) {
  const f = facts && typeof facts === 'object' ? facts : null;
  if (!f) {
    return _verdict(STATUS_UNVERIFIABLE, null, null,
      'facts 缺失或非法：无从对账，保守判 unverifiable（绝不默认 complete）。');
  }

  const expected = f.expectedFileCount;
  const actual = f.actualFileCount;

  // 1) 前置证据不足：期望须是有限正数，实际须是有限非负数，否则无从对账。
  if (!_isFiniteNum(expected) || expected <= 0 || !_isFiniteNum(actual) || actual < 0) {
    return _verdict(STATUS_UNVERIFIABLE, expected, actual,
      '缺少可对账的文件数（期望非正 / 实际缺失或非法）：保守判 unverifiable。');
  }

  // 2) 密文/解包阶段已失败：完整性无从谈起（显式 false 才拦，未提供视为已通过——
  //    restore 主路径在调用前已做 sha256 与 tar 退出码校验）。
  if (f.sha256Verified === false || f.tarExitZero === false) {
    const which = f.sha256Verified === false ? 'sha256 校验失败' : 'tar 解包非零退出';
    return _verdict(STATUS_CORRUPT, expected, actual,
      `前置完整性校验未过（${which}）：解包结果不可信，完整性无从谈起。`);
  }

  // 3) 静默少解：实际 < 期望——这正是断桥要抓的假绿。
  if (actual < expected) {
    return _verdict(STATUS_INCOMPLETE, expected, actual,
      `静默少解：期望 ${expected} 个文件，磁盘上只有 ${actual} 个（缺 ${expected - actual} 个）。`
      + 'tar 可能因磁盘写满 / 路径过长 / 条目被跳过而退出 0 却漏文件——请勿当作「完整还原」。');
  }

  // 4) 多出文件：目标目录本就有残留，或快照口径与磁盘口径漂移，提示人核对。
  if (actual > expected) {
    return _verdict(STATUS_OVER_EXTRACTED, expected, actual,
      `实际 ${actual} 个文件多于期望 ${expected} 个（多 ${actual - expected} 个）：`
      + '可能是目标目录原有残留，或数文件口径漂移——请人工核对是否混入无关文件。');
  }

  // 5) 数量吻合且前置通过：唯一可安心说「完整还原」的档。
  return _verdict(STATUS_COMPLETE, expected, actual,
    `完整：期望与实际均为 ${expected} 个文件，且 sha256 / tar 前置校验通过。`);
}

module.exports = {
  verifyExtractionCompleteness,
  STATUS_COMPLETE, STATUS_INCOMPLETE, STATUS_OVER_EXTRACTED,
  STATUS_CORRUPT, STATUS_UNVERIFIABLE,
  // 供测试锁定：
  _verdict, _isFiniteNum,
};
