'use strict';

/**
 * stressHarness.js — 极端环境施压器（DESIGN-ARCH-055 §4「驱动与规约」）。
 *
 * 把一条声明式对抗向量（attackVectors）真正打到对应的**活防御子系统**上，在极端环境旋钮
 * （挤干的预算 / 恒真的死循环诱饵 / 强制枯竭 / 硬死线）下运行，并把这一次对抗运行**规约**成
 * survivalCriteria 能评分的标准 observation。
 *
 * 职责边界：本模块知道「怎么打」（驱动每支子系统的真实公开契约），但**不**判定生死——
 * 那是 survivalCriteria 的事。驱动与判定分离，使「被打的是谁」与「合格线是什么」彼此正交。
 *
 * 铁律（与被测子系统同源的防御哲学）：
 *   - 零网络、确定性：所有 runner/输入都是本地构造，无随机、无外呼。
 *   - 硬死线：每次驱动包在 deadline 内（默认 3s，env 可调）。子系统若真的卡死，死线兜底把它
 *     规约成一条 BOUNDED 破防而非拖垮整场战役——施压器自身永不被被测对象拖挂。
 *   - fail-closed 偏保守：驱动器内部若自身异常（非被测子系统所抛），按「非预期异常」记 threw，
 *     宁可误判破防，不可把施压器的 bug 伪装成「防御存活」。
 */

const { INVARIANTS } = require('./survivalCriteria');
const { TARGET } = require('./attackVectors');

const DEFAULT_DEADLINE_MS = 3000;

function _deadlineMs() {
  const n = Number(process.env.KHY_ADVERSARIAL_DEADLINE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DEADLINE_MS;
}

/** 把一个 promise 包进硬死线：超时解析为 {timedOut:true}，绝不无限等待。 */
function _withDeadline(promise, ms) {
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([
    Promise.resolve(promise).then((v) => ({ __value: v }), (e) => ({ __error: e })),
    guard,
  ]).then((r) => { if (timer) clearTimeout(timer); return r; });
}

// ── 规约基座：所有驱动器都返回这个形状的子集，stress() 补齐元数据 ───────────────
function _baseObservation(vector) {
  return {
    vectorId: vector.id,
    target: vector.target,
    family: vector.family,
    expectInvariants: Array.isArray(vector.expectInvariants) ? vector.expectInvariants.slice() : [],
    threw: false,
    error: null,
    rejected: false,
    bounded: true,
    calls: 0,
    outcome: null,
    hasErrorCode: false,
    hasSalvage: false,
    budgetFloorHeld: true,
    forgeryRejected: false,
    durationMs: 0,
  };
}

// ── failsafe 驱动：畸形/敌对回复 → 归因结构 ──────────────────────────────────
function _driveFailsafe(vector, payload) {
  const obs = _baseObservation(vector);
  let failsafe;
  try { failsafe = require('../failsafe'); } catch (e) { obs.threw = true; obs.error = _err(e); return obs; }

  try {
    if (payload.kind === 'llm-reply') {
      const wrapper = new failsafe.SafeResponseWrapper({ kind: 'llm', model: 'adversarial-mock' });
      const result = wrapper.validateLLM(payload.value);
      // validateLLM：非法/空 → E0x 结构；合格非空 → null。
      obs.outcome = result;
      obs.hasErrorCode = !!(result && typeof result.error_code === 'string');
    } else if (payload.kind === 'raw-error') {
      const result = failsafe.classify(payload.value, { kind: 'tool' });
      obs.outcome = result;
      obs.hasErrorCode = !!(result && typeof result.error_code === 'string');
    } else {
      const result = failsafe.classify(payload.value, {});
      obs.outcome = result;
      obs.hasErrorCode = !!(result && typeof result.error_code === 'string');
    }
  } catch (e) {
    obs.threw = true;
    obs.error = _err(e);
  }
  return obs;
}

// ── resilience 驱动：极限预算/级联故障/死循环诱饵 → 强制兜底 ──────────────────
async function _driveResilience(vector, payload) {
  const obs = _baseObservation(vector);
  let resilience;
  try { resilience = require('../resilience'); } catch (e) { obs.threw = true; obs.error = _err(e); return obs; }

  const { ResilienceCoordinator, FallbackTreeBuilder } = resilience;

  // 未注册意图：协调器必须自交一份 unknown-intent 兜底。
  if (payload.kind === 'unknown-intent') {
    try {
      const coord = new ResilienceCoordinator({ runner: async () => ({ success: false }) });
      const result = await coord.run(payload.intent, {});
      obs.outcome = result && (result.salvage || result.result) || result;
      obs.hasSalvage = _isSalvage(result && result.salvage);
    } catch (e) { obs.threw = true; obs.error = _err(e); }
    return obs;
  }

  // fault-plan：构造一棵 3 层降级树，runner 恒失败/恒抛，在极限预算下运行。
  let calls = 0;
  const runner = async () => {
    calls += 1;
    if (payload.throwEvery) throw new Error('对抗诱导的硬抛错');
    return { success: false, error: '对抗诱导的失败', code: 'ADV_FAIL' };
  };

  // 死循环诱饵：三层 Plan 共用同一 (tool, params) 签名，逼死循环检测斩断。
  const sameParams = { fixed: 'identical' };
  const plans = payload.identicalSignature
    ? [
      { plan: 'P1', tool: '__advTool', params: sameParams },
      { plan: 'P2', tool: '__advTool', params: sameParams },
      { plan: 'P3', tool: '__advTool', params: sameParams },
    ]
    : [
      { plan: 'P1', tool: '__advTool1', params: { n: 1 } },
      { plan: 'P2', tool: '__advTool2', params: { n: 2 } },
      { plan: 'P3', tool: '__advTool3', params: { n: 3 } },
    ];

  let tree;
  try {
    tree = FallbackTreeBuilder.from('adversarial-stress', plans);
  } catch (e) { obs.threw = true; obs.error = _err(e); return obs; }

  const budget = _makeBudget(payload.budget);
  const expectsFloor = obs.expectInvariants.includes(INVARIANTS.BUDGET_FLOOR_HONORED);

  try {
    const coord = new ResilienceCoordinator({ runner, budget, floorPct: payload.floorPct });
    const result = await coord.run(tree, {});
    obs.calls = calls;
    obs.outcome = (result && (result.salvage || result.result)) || result;
    obs.hasSalvage = _isSalvage(result && result.salvage);
    // 预算地板：枯竭向量必须 0 次实际调用且经预算闸门熔断。
    if (expectsFloor) {
      const circuit = String((result && result.circuit) || '');
      obs.budgetFloorHeld = calls === 0 && circuit.startsWith('budget');
    }
  } catch (e) {
    obs.calls = calls;
    obs.threw = true;
    obs.error = _err(e);
  }
  return obs;
}

// ── structuredFurnace 驱动：高熵敌对 NL 坍缩 / 伪造 payload 验封 ──────────────
function _driveFurnace(vector, payload) {
  const obs = _baseObservation(vector);
  let furnace;
  try { furnace = require('../structuredFurnace'); } catch (e) { obs.threw = true; obs.error = _err(e); return obs; }

  if (payload.kind === 'nl') {
    try {
      const env = furnace.intercept(payload.value);
      // 返回即应是已封印信封：顺手验封以证其真。
      obs.outcome = { sealed: !!(env && env.sealed), level: env && env.level };
      try { furnace.assertForged(env); } catch { /* 真信封不该在此抛；抛了说明封印自检失败 */ }
    } catch (e) {
      if (e instanceof furnace.FurnaceRejection) {
        // 设计内拒损：不是破防，是「不放原文过界」的正确行为。
        obs.rejected = true;
        obs.outcome = typeof e.toJSON === 'function' ? e.toJSON() : { kind: 'rejection', message: e.message };
      } else {
        obs.threw = true;
        obs.error = _err(e);
      }
    }
    return obs;
  }

  if (payload.kind === 'forge-attempt') {
    const hostile = _buildForgery(furnace, payload);
    try {
      furnace.assertForged(hostile);
      // 没抛 = 伪造蒙混成功 = 封印边界被绕过（破防）。
      obs.forgeryRejected = false;
      obs.outcome = { bypassed: true };
    } catch (e) {
      // 抛错 = 伪造被拒（正确）。这是「设计内拒绝」，记 rejected 以满足 NO_SILENT_FAILURE。
      obs.forgeryRejected = true;
      obs.rejected = true;
      obs.outcome = { rejected: true, message: e && e.message };
    }
    return obs;
  }

  obs.threw = true;
  obs.error = { name: 'HarnessError', message: `未知 furnace payload kind：${payload.kind}` };
  return obs;
}

/** 依据伪造模式构造一份敌对「信封」。 */
function _buildForgery(furnace, payload) {
  const BRAND = furnace.SEAL_BRAND;
  if (payload.mode === 'bare') {
    // 裸 payload：无封印品牌。
    return { sealed: true, payload: payload.payload, seal: 'whatever' };
  }
  if (payload.mode === 'fake-brand') {
    // 伪造品牌 + 乱填 seal：摘要必不符。
    return { [BRAND]: true, sealed: true, payload: payload.payload, seal: payload.seal || 'deadbeef'.repeat(8) };
  }
  if (payload.mode === 'tamper') {
    // 取一份真封印信封，篡改 payload（seal 变陈旧）。真信封拿不到则降级为 fake-brand。
    let env = null;
    try { env = furnace.intercept('打开文件 report.txt 并总结其要点', { forceLevel: 'L0' }); } catch { env = null; }
    if (env && env.payload) {
      return { [BRAND]: true, sealed: true, seal: env.seal, payload: { ...env.payload, ...(payload.tamperWith || {}) } };
    }
    return { [BRAND]: true, sealed: true, payload: { kind: 'ActionIntent', ...(payload.tamperWith || {}) }, seal: '00'.repeat(16) };
  }
  return { payload: payload.payload || {} };
}

// ── 公共入口：驱动一条向量并返回标准 observation ────────────────────────────
/**
 * 对单条向量施压。永不抛——任何施压器自身异常都规约成 threw 记录。
 * @param {object} vector  attackVectors 中的一条
 * @returns {Promise<object>} 标准 observation（喂给 survivalCriteria.evaluate）
 */
async function stress(vector) {
  if (!vector || typeof vector.build !== 'function') {
    return { ..._baseObservation(vector || {}), threw: true, error: { name: 'HarnessError', message: '无效向量' } };
  }
  const start = _now();
  let payload;
  try { payload = vector.build(); } catch (e) {
    const obs = _baseObservation(vector); obs.threw = true; obs.error = _err(e); return obs;
  }

  const driver = _driverFor(vector.target);
  if (!driver) {
    const obs = _baseObservation(vector);
    obs.threw = true; obs.error = { name: 'HarnessError', message: `无驱动器：target=${vector.target}` };
    return obs;
  }

  const raced = await _withDeadline(Promise.resolve().then(() => driver(vector, payload)), _deadlineMs());
  let obs;
  if (raced.__timedOut) {
    // 硬死线兜底：被测子系统真的卡死 → BOUNDED 破防，而非拖垮战役。
    obs = _baseObservation(vector);
    obs.bounded = false;
    obs.error = { name: 'DeadlineExceeded', message: `驱动超过死线 ${_deadlineMs()}ms（疑似卡死）` };
  } else if (raced.__error) {
    obs = _baseObservation(vector);
    obs.threw = true; obs.error = _err(raced.__error);
  } else {
    obs = raced.__value;
  }
  obs.durationMs = Math.max(0, _now() - start);
  return obs;
}

function _driverFor(target) {
  switch (target) {
    case TARGET.FAILSAFE: return _driveFailsafe;
    case TARGET.RESILIENCE: return _driveResilience;
    case TARGET.FURNACE: return _driveFurnace;
    default: return null;
  }
}

// ── 内部助手 ─────────────────────────────────────────────────────────────
function _makeBudget(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const { makeStepBudget, makeTokenBudget } = require('../resilience');
  if (spec.type === 'token') {
    const spent = Number(spec.spent) || 0;
    return makeTokenBudget({ total: Number(spec.total) || 0, spent: () => spent });
  }
  // step：直接走公开工厂——makeStepBudget 现已正确把显式 0/负 解释为「真枯竭」
  // （DESIGN-ARCH-055 加固，见 budgetExecutor.makeStepBudget）。此处不再旁路自构，
  // 使 zero-step-budget 向量成为该加固的活体回归守护：工厂一旦退回旧 `||default`
  // 行为，0 步预算会静默变 3 步 → 越过地板烧 Plan → BUDGET_FLOOR_HONORED 破防。
  return makeStepBudget(spec.total);
}

function _isSalvage(s) {
  return !!(s && typeof s === 'object' && !Array.isArray(s) && Object.keys(s).length > 0);
}

function _err(e) {
  if (!e) return { name: 'Error', message: 'unknown' };
  return { name: e.name || 'Error', message: String(e.message || e).slice(0, 500) };
}

function _now() {
  // 非 Workflow 上下文，Date.now 可用；包一层防边缘环境缺失。
  try { return Date.now(); } catch { return 0; }
}

module.exports = {
  stress,
  _withDeadline, // 导出供测试
};
