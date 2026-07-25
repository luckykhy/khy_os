'use strict';

/**
 * 还原完整性对账 —— bundled 运行时纯叶（零 IO · 绝不抛）。
 *
 * ── 补的缺口：把一个 dev 侧已存在、却从未接进运行时的能力接上线 ──────────────
 * 快照构建期 `makeSourceSnapshot.js` 用 `countTreeFiles`（`git ls-tree -r` 数出
 * `git archive` 应打包的文件数）写进 snapshot.json 的 `header.fileCount`；这个数
 * 随 pip / npm 包漂到陌生机器。但运行时还原侧 `handleRestore` 只是把 `fileCount`
 * **原样打印**（“共 N 个文件 · 目录布局原样”），从不与磁盘上真正落地的文件数对账。
 *
 * `tar` 退出 0 并不等于全部落地：磁盘满、路径过长（Windows MAX_PATH）、条目被
 * 跳过，都会让 tar 少写文件却仍退 0；快照头的 `sha256` 只防整包传输损坏，不防
 * 解包阶段少落地。于是用户看到绿字“源码已完整还原”，磁盘却缺文件 = 最毒的假绿。
 *
 * dev 侧 `scripts/lib/restoreCompletenessVerifier.js`（OPS-095）早已把这套裁决
 * 逻辑写好并 LIVE 验证过口径，但它只被 dev CLI 消费、从不进 bundled 运行时还原
 * 路径 = 能力存在、没接线。本叶把等价裁决落进 bundled 运行时，让 `khy restore`
 * 的横幅诚实。两者口径一致：`countTreeFiles` 与 `git archive` 用同一 treeish，故
 * 干净成功还原时 磁盘落地数 === header.fileCount。
 *
 * ── 边界（诚实且克制）──────────────────────────────────────────────────────
 * - 纯诊断叠加层：**绝不让还原失败**。最坏只把成功横幅降级为 ⚠️ 告警。
 * - 上游若已因 sha256 不符 / tar 非 0 退出而 throw，根本到不了这里；故本叶只需
 *   对账两个计数，不重复 corrupt 档。
 * - 证据不足（快照没给可信 fileCount / 无法统计落地数）→ `unverifiable`，绝不把
 *   “没测量”谎报成“不完整”，也绝不越过旧行为多喊“完整”。
 */

const STATUS_COMPLETE = 'complete';         // 落地数 === 清单数：真完整（唯一 ok）
const STATUS_INCOMPLETE = 'incomplete';     // 落地数 < 清单数：断桥核心，少解了文件
const STATUS_OVER_EXTRACTED = 'over-extracted'; // 落地数 > 清单数：目标目录疑有残留
const STATUS_UNVERIFIABLE = 'unverifiable'; // 证据不足，保持旧行为不多喊

/** 归一为有限整数；缺失(null/undefined/'')或非有限 → null（“没测量”，绝不当 0 用）。 */
function _int(v) {
  if (v == null || v === '') return null;   // Number(null)===0 的陷阱：缺失≠0
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** 唯一 verdict 构造器：ok 当且仅当 status === complete。 */
function _verdict(status, expected, actual, reason) {
  const exp = expected == null ? null : expected;
  const act = actual == null ? null : actual;
  const bothKnown = exp != null && act != null;
  return {
    status,
    ok: status === STATUS_COMPLETE,
    expected: exp,
    actual: act,
    missing: (status === STATUS_INCOMPLETE && bothKnown) ? (exp - act) : 0,
    extra: (status === STATUS_OVER_EXTRACTED && bothKnown) ? (act - exp) : 0,
    reason: String(reason == null ? '' : reason),
  };
}

/**
 * 对账快照清单文件数与磁盘落地文件数。
 * @param {{expectedFileCount?:number, actualFileCount?:number}} facts
 *   - expectedFileCount：快照头 `fileCount`（git ls-tree -r 数出的 tar 应有文件数）。
 *   - actualFileCount：解包后目标目录实际落地的文件数（`_collectRelFiles(dest).length`）。
 * @returns {{status:string, ok:boolean, expected:(number|null), actual:(number|null),
 *   missing:number, extra:number, reason:string}} 绝不抛。
 */
function verifyRestoreCompleteness(facts) {
  try {
    if (!facts || typeof facts !== 'object' || Array.isArray(facts)) {
      return _verdict(STATUS_UNVERIFIABLE, null, null, '缺少对账事实');
    }
    const expected = _int(facts.expectedFileCount);
    const actual = _int(facts.actualFileCount);
    if (expected == null || expected <= 0) {
      return _verdict(STATUS_UNVERIFIABLE, expected, actual, '快照未提供可信文件计数(fileCount)');
    }
    if (actual == null || actual < 0) {
      return _verdict(STATUS_UNVERIFIABLE, expected, actual, '无法统计落地文件数');
    }
    if (actual < expected) {
      return _verdict(STATUS_INCOMPLETE, expected, actual, `落地 ${actual} < 清单 ${expected}`);
    }
    if (actual > expected) {
      return _verdict(STATUS_OVER_EXTRACTED, expected, actual, `落地 ${actual} > 清单 ${expected}`);
    }
    return _verdict(STATUS_COMPLETE, expected, actual, '落地数与清单一致');
  } catch {
    return _verdict(STATUS_UNVERIFIABLE, null, null, '对账异常');
  }
}

module.exports = {
  verifyRestoreCompleteness,
  STATUS_COMPLETE,
  STATUS_INCOMPLETE,
  STATUS_OVER_EXTRACTED,
  STATUS_UNVERIFIABLE,
};
