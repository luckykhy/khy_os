'use strict';

/**
 * survivalCriteria.js — 对抗式训练的「抗压不变量」单一真源（DESIGN-ARCH-055 §3）。
 *
 * 一支防御子系统在极端/敌对输入下「活下来」意味着什么？不是「没报错」——而是六条硬不变量
 * 在施压全程恒成立。本模块是**纯评分器**：施压器（stressHarness）把一次对抗运行规约成一份
 * 标准 observation，本模块据之逐条判定是否破防（breach），不关心被测的是哪支子系统、如何被
 * 驱动。判定与驱动分离，使不变量成为跨子系统统一的「合格线」。
 *
 * 六条不变量（任一破防即记一笔 breach，附归因）：
 *   NO_THROW              非预期异常零容忍——设计内的拒损（FurnaceRejection / 验封拒绝）不算。
 *   BOUNDED              有界——绝不无限重试/死循环，必在迭代或时间封顶内终止。
 *   NO_SILENT_FAILURE    零静默失败——绝不「返回空且无归因」，必带 E0x 码或兜底或显式拒损。
 *   ALWAYS_SALVAGE       强制兜底——降级耗尽后必交付结构化 salvage，绝不躺平。
 *   BUDGET_FLOOR_HONORED 预算地板——极限预算下绝不越界燃烧，地板必被尊重。
 *   FORGERY_REJECTED     封印不可伪造——裸/篡改/跨进程伪造的 payload 必被验封拒绝。
 *
 * 设计立场：评分器零依赖、永不抛。一次评分自身崩溃绝不能伪装成「全员存活」——任何评分内部
 * 异常都被规约成一条 NO_THROW breach（fail-closed 偏保守，宁可误报破防不可漏报）。
 */

/** 六条不变量 ID 单一真源（attackVectors 与 stressHarness 共同引用此处常量）。 */
const INVARIANTS = Object.freeze({
  NO_THROW: 'NO_THROW',
  BOUNDED: 'BOUNDED',
  NO_SILENT_FAILURE: 'NO_SILENT_FAILURE',
  ALWAYS_SALVAGE: 'ALWAYS_SALVAGE',
  BUDGET_FLOOR_HONORED: 'BUDGET_FLOOR_HONORED',
  FORGERY_REJECTED: 'FORGERY_REJECTED',
});

const ALL_INVARIANTS = Object.freeze(Object.values(INVARIANTS));

/**
 * 标准 observation 形状（stressHarness 规约产出，本模块消费）：
 * {
 *   vectorId, target, family,
 *   expectInvariants: string[],     // 本向量要求成立的不变量子集
 *   threw: boolean,                 // 发生了**非预期**异常（设计内拒损不计入此处）
 *   error: {name,message}|null,
 *   rejected: boolean,              // 发生了**设计内**拒损（FurnaceRejection / 验封拒绝）
 *   bounded: boolean,              // 在封顶内终止
 *   calls: number,                 // 驱动期间的执行次数（用于佐证有界）
 *   outcome: any,                  // 子系统交付物（salvage / classify 结构 / 封印信封 ...）
 *   hasErrorCode: boolean,         // 产出了 E0x 归因
 *   hasSalvage: boolean,           // 产出了结构化兜底
 *   budgetFloorHeld: boolean,      // 预算地板被尊重
 *   forgeryRejected: boolean,      // 伪造尝试被验封拒绝
 * }
 */

/** 单条不变量判定器：返回 null 表示守住，返回 {detail} 表示破防。 */
const CHECKERS = Object.freeze({
  [INVARIANTS.NO_THROW]: (o) => (o.threw
    ? { detail: `非预期异常逃逸：${(o.error && o.error.name) || 'Error'}: ${(o.error && o.error.message) || ''}`.trim() }
    : null),

  [INVARIANTS.BOUNDED]: (o) => (o.bounded === false
    ? { detail: `未在封顶内终止（calls=${o.calls}）——疑似死循环/无限重试` }
    : null),

  [INVARIANTS.NO_SILENT_FAILURE]: (o) => {
    // 静默失败 = 交付空且无任何归因（无 E0x、无兜底、无显式拒损）。
    const empty = _isEmptyOutcome(o.outcome);
    const attributed = o.hasErrorCode || o.hasSalvage || o.rejected;
    return (empty && !attributed)
      ? { detail: '交付为空且无归因（无 E0x / 无兜底 / 无显式拒损）——静默失败' }
      : null;
  },

  [INVARIANTS.ALWAYS_SALVAGE]: (o) => (o.hasSalvage
    ? null
    : { detail: '降级耗尽后未交付结构化 salvage——躺平' }),

  [INVARIANTS.BUDGET_FLOOR_HONORED]: (o) => (o.budgetFloorHeld === false
    ? { detail: '极限预算下越过地板继续燃烧——预算地板失守' }
    : null),

  [INVARIANTS.FORGERY_REJECTED]: (o) => (o.forgeryRejected
    ? null
    : { detail: '伪造/篡改/裸 payload 未被验封拒绝——封印边界被绕过' }),
});

function _isEmptyOutcome(outcome) {
  if (outcome == null) return true;
  if (typeof outcome === 'string') return outcome.trim() === '';
  if (Array.isArray(outcome)) return outcome.length === 0;
  if (typeof outcome === 'object') return Object.keys(outcome).length === 0;
  return false;
}

/**
 * 评定一次对抗运行：逐条检查该向量要求的不变量，汇总 breaches。
 * 永不抛——评分自身异常折叠成一条保守的 NO_THROW breach。
 * @param {object} observation  见上文标准形状
 * @returns {{vectorId:string, target:string, survived:boolean, checked:string[], breaches:Array<{invariant:string, detail:string}>}}
 */
function evaluate(observation) {
  const o = observation || {};
  const checked = Array.isArray(o.expectInvariants) && o.expectInvariants.length
    ? o.expectInvariants.filter((id) => CHECKERS[id])
    : [];
  const breaches = [];
  for (const id of checked) {
    try {
      const verdict = CHECKERS[id](o);
      if (verdict) breaches.push({ invariant: id, detail: verdict.detail });
    } catch (err) {
      // fail-closed：判定器自身崩溃也算破防，绝不静默放行。
      breaches.push({ invariant: id, detail: `判定器异常（保守判破防）：${err && err.message}` });
    }
  }
  return {
    vectorId: o.vectorId || null,
    target: o.target || null,
    survived: breaches.length === 0,
    checked,
    breaches,
  };
}

/**
 * 汇总一场战役的所有评定：存活率、按不变量/子系统的破防分布。
 * @param {Array} results  evaluate() 结果数组
 */
function summarize(results) {
  const list = Array.isArray(results) ? results : [];
  const total = list.length;
  const survived = list.filter((r) => r && r.survived).length;
  const byInvariant = {};
  const byTarget = {};
  for (const r of list) {
    if (!r) continue;
    if (!r.survived) {
      const t = r.target || 'unknown';
      byTarget[t] = (byTarget[t] || 0) + 1;
      for (const b of r.breaches || []) {
        byInvariant[b.invariant] = (byInvariant[b.invariant] || 0) + 1;
      }
    }
  }
  return {
    total,
    survived,
    breached: total - survived,
    survivalRate: total ? Number((survived / total).toFixed(4)) : 1,
    byInvariant,
    byTarget,
  };
}

module.exports = {
  INVARIANTS,
  ALL_INVARIANTS,
  CHECKERS,
  evaluate,
  summarize,
};
