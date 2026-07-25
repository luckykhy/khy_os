'use strict';

/**
 * goalStore.js — 持久目标的薄 IO 层(磁盘读写),逻辑全部委派纯叶子 goalCore。
 *
 * 数据落**底座领地** `~/.khyos/goals/goals.json`(随 pip 升级不丢),复用 learningProfile
 * 的原子写 + .bak 轮转惯例。读写任何异常都 fail-soft(绝不抛、视为无目标)。
 *
 * 一个项目(按 cwd 哈希作用域)一个活动目标;另有全局目标作为回退。setGoal 把同作用域的
 * 旧活动目标置为非活动(active=false,保留历史),再追加新的活动目标。
 *
 * @module services/goalStore
 */

const fs = require('fs');
const path = require('path');

const { getBaseDataDir } = require('../utils/dataHome');
const core = require('./goalCore');

function _dir() { return getBaseDataDir('goals'); }                    // ~/.khyos/goals(已确保存在)
function _file() { return path.join(_dir(), 'goals.json'); }
function _bak() { return path.join(_dir(), 'goals.bak'); }

/** 读取存档;缺失/损坏 → 空存档。绝不抛。 */
function _read() {
  try {
    const file = _file();
    if (!fs.existsSync(file)) return { version: core.STORE_VERSION, goals: [] };
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.goals)) {
      return { version: core.STORE_VERSION, goals: [] };
    }
    return { version: Number(raw.version) || core.STORE_VERSION, goals: raw.goals };
  } catch {
    return { version: core.STORE_VERSION, goals: [] };
  }
}

/** 原子写(同目录临时文件 + rename)+ 单份 .bak 轮转。返回 {ok}。绝不抛。 */
function _write(state) {
  try {
    const dir = _dir();
    const file = _file();
    try { if (fs.existsSync(file)) fs.copyFileSync(file, _bak()); } catch { /* best-effort */ }
    const payload = {
      version: core.STORE_VERSION,
      goals: Array.isArray(state.goals) ? state.goals : [],
      updatedAt: new Date().toISOString(),
    };
    const tmp = path.join(dir, `.goals.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** 所有目标记录(含历史/非活动)。 */
function listGoals() { return _read().goals; }

/**
 * 自愈对账(读取时):把已「闲置超时」的活动目标退役并落盘。门控 KHY_GOAL_RECONCILE(默认开,
 * 嵌套父门 KHY_GOAL)关 → 直接返回 false 不触碰 state(getActiveGoal 逐字节回退今日行为)。
 *
 * 单一判定真源在纯叶子 core.goalIdleReason(以 lastAdvancedAt/createdAt 为活跃度信号);本处只做
 * IO:命中即 active=false / terminalStatus=exhausted / terminatedAt,有变更才 best-effort 落盘。
 * @param {object} state - _read() 的返回(会被就地修改)
 * @param {object} [env]
 * @returns {boolean} 是否有目标被退役(并已尝试落盘)
 */
function _reconcileState(state, env) {
  try {
    if (!core.isReconcileEnabled(env)) return false;
    const nowMs = Date.now();
    let changed = false;
    for (const g of state.goals) {
      if (g && g.active && core.goalIdleReason(g, env, nowMs)) {
        g.active = false;
        g.terminalStatus = 'exhausted';
        g.terminatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) _write(state);                          // best-effort;失败不影响本次挑选
    return changed;
  } catch {
    return false;                                        // fail-soft:对账绝不阻断读取
  }
}

/** 当前 cwd 作用域的活动目标(回退全局),无 → null。读取时先做闲置退役对账(门控 KHY_GOAL_RECONCILE)。 */
function getActiveGoal(cwd, env) {
  const state = _read();
  _reconcileState(state, env);                           // 门控关 → no-op,逐字节回退
  return core.pickActiveGoal(state.goals, cwd == null ? process.cwd() : cwd);
}

/**
 * 设定目标并持久化。把同作用域旧活动目标置非活动,再追加新活动目标。
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.cwd] - 绑定项目;留空且 global 为 true → 全局目标
 * @param {boolean} [opts.global] - 设为全局目标(不绑定项目)
 * @param {number} [opts.maxTurns] - 轮次预算上限(缺省用默认;经 core.resolveMaxTurns 归一)
 * @returns {{ok:true, goal:object}|{ok:false, error:string}}
 */
function setGoal(text, opts = {}) {
  const cwd = opts.global ? '' : (opts.cwd == null ? process.cwd() : opts.cwd);
  const id = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const built = core.buildGoalRecord({
    text, cwd, createdAt: new Date().toISOString(), id, maxTurns: opts.maxTurns,
  });
  if (!built.ok) return built;
  const state = _read();
  const scope = built.goal.scope;
  // 同作用域旧活动目标退役(保留历史)
  for (const g of state.goals) {
    if (g && g.active && g.scope === scope) g.active = false;
  }
  state.goals.push(built.goal);
  const w = _write(state);
  if (!w.ok) return { ok: false, error: w.error || '写入失败' };
  return { ok: true, goal: built.goal };
}

/**
 * 清除目标。默认清当前 cwd 作用域的活动目标;all=true 清全部活动目标。
 * 退役时同时记终止态元数据(terminalStatus/terminatedAt),便于面板区分 done/abandoned。
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {boolean} [opts.all]
 * @param {string} [opts.reason] - 终止态:'done'(模型确信完成) | 'abandoned'(用户清除,默认)
 * @returns {{ok:true, cleared:number}|{ok:false, error:string}}
 */
function clearGoal(opts = {}) {
  const state = _read();
  const reason = opts.reason || 'abandoned';
  const at = new Date().toISOString();
  const retire = (g) => { g.active = false; g.terminalStatus = reason; g.terminatedAt = at; };
  let cleared = 0;
  if (opts.all) {
    for (const g of state.goals) { if (g && g.active) { retire(g); cleared++; } }
  } else {
    const scope = core.scopeKeyFor(opts.cwd == null ? process.cwd() : opts.cwd);
    for (const g of state.goals) {
      if (g && g.active && g.scope === scope) { retire(g); cleared++; }
    }
    // 若该项目无活动目标,顺带清掉全局活动目标(用户直觉:clear 应停掉正在生效的那个)
    if (cleared === 0) {
      for (const g of state.goals) {
        if (g && g.active && g.scope === core.GLOBAL_SCOPE) { retire(g); cleared++; }
      }
    }
  }
  if (cleared === 0) return { ok: true, cleared: 0 };
  const w = _write(state);
  if (!w.ok) return { ok: false, error: w.error || '写入失败' };
  return { ok: true, cleared };
}

/**
 * 便利:加载当前 cwd 的活动目标并产出注入指令(供 ai.js 每轮调用)。fail-soft。
 * @param {object} [args]
 * @param {string} [args.cwd]
 * @param {object} [args.env]
 * @returns {string} directive(可能为空)
 */
function getActiveGoalDirective({ cwd, env } = {}) {
  try {
    if (!core.isEnabled(env)) return '';
    const goal = getActiveGoal(cwd == null ? process.cwd() : cwd, env);
    return core.routeGoal({ goal, env });
  } catch {
    return '';
  }
}

/**
 * 每轮推进入口(供 ai.js 每个用户轮调用一次,取代只读注入)。有界终止态的核心接线:
 * 递增 turnsSpent → 构建有界指令;到达预算上限那一轮**一次性**注入终止指令并落盘退役
 * (active=false, terminalStatus='exhausted'),之后 pickActiveGoal 无命中 → 停止注入。
 *
 * 门控回退:KHY_GOAL 关 → 无指令;KHY_GOAL_BOUNDED 关 → 旧无界指令且**不计数**(字节回退
 * 今日行为)。写盘 best-effort:即便落盘失败也返回本轮指令(计数丢失不影响本轮 fail-soft)。
 * @param {object} [args]
 * @param {string} [args.cwd]
 * @param {object} [args.env]
 * @returns {string} directive(可能为空)
 */
function advanceActiveGoalDirective({ cwd, env } = {}) {
  try {
    if (!core.isEnabled(env)) return '';                       // KHY_GOAL 关 → 无指令
    const c = cwd == null ? process.cwd() : cwd;
    const goal = getActiveGoal(c, env);
    if (!goal) return '';
    if (!core.isBounded(env)) return core.routeGoal({ goal, env }); // 有界关 → 旧无界指令,不计数
    const tick = core.advanceGoalTurn(goal, env);
    const directive = core.buildBoundedDirective(goal, tick);
    // 持久化本轮推进(best-effort;写失败仍返回指令 = fail-soft)。
    try {
      const state = _read();
      const rec = state.goals.find((g) => g && g.id === goal.id && g.active);
      if (rec) {
        rec.turnsSpent = tick.spent;
        rec.lastAdvancedAt = new Date().toISOString();         // 刷新活跃度信号(闲置退役据此不误杀在跑目标)
        if (tick.justExhausted) {
          rec.active = false;
          rec.terminalStatus = 'exhausted';
          rec.terminatedAt = new Date().toISOString();
        }
        _write(state);
      }
    } catch { /* fail-soft: 计数丢失不影响本轮指令 */ }
    return directive;
  } catch {
    return '';
  }
}

module.exports = {
  listGoals,
  getActiveGoal,
  setGoal,
  clearGoal,
  getActiveGoalDirective,
  advanceActiveGoalDirective,
};
