'use strict';

/**
 * resilience/budgetExecutor.js — BudgetAwareExecutor：预算感知的降级树执行器。
 *
 * 这是整套「有限窗口降级与强制兜底」协议的心脏。它包裹所有工具调用，把娇气病与
 * 死缠烂打同时摁死：
 *
 *   - 自顶向下遍历降级树（Plan A → B → C），失败必向下降级，**绝不重试上一个 Plan**。
 *   - 每个 Plan 内 max_retry 恒为 1，且那唯一一次重试只在"依赖/参数被真正修复"后才允许
 *     （由 DeadLoopDetector.changed 判定）；同类错误原地重发 = 立即判死、强制跳过。
 *   - 每开启一个新 Plan 前核算剩余预算：
 *       · 低于地板（默认 10%）             → 立即熔断，触发强制兜底协议。
 *       · 不足以支撑降级树剩余节点         → 立即熔断，触发强制兜底协议。
 *   - 树遍历完毕仍失败 = 任务执行结束，组装兜底 JSON，**绝不开启第二遍循环**。
 *
 * 同时（模型在环路径）每次降级都通过 onDegrade 回调注入一段强制上下文，命令模型
 * "禁止道歉、直接规划下一个 Plan"。
 *
 * 防呆：执行器自身的任何意外异常都 fail-safe 收敛为一份兜底 JSON（绝不把异常往上抛、
 *       绝不静默躺平）。深度上限 MAX_FALLBACK_DEPTH 在此处再做一次双保险切片。
 */

const { MAX_FALLBACK_DEPTH, MAX_RETRY_PER_PLAN } = require('./fallbackTree');
const { classifyFailure } = require('./errorSignature');
const { DeadLoopDetector } = require('./deadLoopDetector');
const { SalvageProtector } = require('./salvage');

const DEFAULT_FLOOR_PCT = 10;

function _resolveFloorPct(explicit) {
  if (explicit !== undefined && explicit !== null) {
    const n = Number(explicit);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  }
  const env = Number(process.env.KHY_RESILIENCE_BUDGET_FLOOR_PCT);
  if (Number.isFinite(env) && env >= 0 && env <= 100) return env;
  return DEFAULT_FLOOR_PCT;
}

// ── 预算适配器（可注入任意预算源，统一 snapshot() 契约）─────────────────
// snapshot() → { totalUnits, remainingUnits, remainingPct }

/**
 * 步数预算：把"还能开几个 Plan/几步"当作预算。
 *
 * 语义铁律（对抗式训练 DESIGN-ARCH-055 加固）：**显式数字一律照单全收**（向下取整、夹到 ≥0），
 * 只有「压根没给可解析的数字」（undefined / NaN / 非数）才回落到缺省总额 = 树最大深度。
 * 旧实现用 `Number(totalSteps) || MAX` 做缺省回落，因 0 是 falsy，把**显式枯竭预算 0 静默
 * 当成了缺省 3 步**——调用方声明「已无预算」却仍被烧掉 3 个 Plan，预算地板形同虚设。此乃对抗
 * 红队逼出的真实破口，现按「显式 0 = 真枯竭，立即触发地板熔断」修正。
 */
function makeStepBudget(totalSteps) {
  const n = Number(totalSteps);
  const total = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : MAX_FALLBACK_DEPTH;
  let used = 0;
  return {
    spendOne() { used += 1; },
    snapshot() {
      const remainingUnits = Math.max(0, total - used);
      return {
        totalUnits: total,
        remainingUnits,
        // total===0（显式枯竭）→ 剩余 0%，地板闸门立即熔断，绝不空转烧 Plan。
        remainingPct: total > 0 ? Math.round((remainingUnits / total) * 100) : 0,
      };
    },
  };
}

/**
 * Token 预算适配器：包裹一个 { total, spent() } 用量源（如 usageTracker / IterationBudget）。
 * spendOne 是 no-op —— Token 由外部真实消耗驱动，本适配器只读快照。
 */
function makeTokenBudget(source = {}) {
  const total = Number(source.total) || 0;
  const spentFn = typeof source.spent === 'function' ? source.spent : () => 0;
  return {
    spendOne() { /* token 消耗由外部真实账本驱动，这里不自增 */ },
    snapshot() {
      const spent = Number(spentFn()) || 0;
      const remainingUnits = Math.max(0, total - spent);
      return {
        totalUnits: total,
        remainingUnits,
        remainingPct: total > 0 ? Math.round((remainingUnits / total) * 100) : 100,
      };
    },
  };
}

class BudgetAwareExecutor {
  /**
   * @param {object} opts
   * @param {Function} opts.runner          async (tool, params, planMeta) => 结构化结果。
   *                                         约定：成功含 success===true；失败可返回 {success:false,error}
   *                                         或直接抛错（执行器会接住并归类）。
   * @param {object}   [opts.budget]         预算适配器（缺省 makeStepBudget(树深)）。
   * @param {number}   [opts.floorPct]       预算地板百分比（缺省 env 或 10）。
   * @param {DeadLoopDetector} [opts.detector]
   * @param {Function} [opts.onDegrade]      降级时注入模型上下文的回调 (text) => void。
   * @param {string[]} [opts.availableTools] 注入上下文里展示的"剩余工具"清单。
   */
  constructor(opts = {}) {
    this.runner = typeof opts.runner === 'function' ? opts.runner : null;
    this.budget = opts.budget || null; // 缺省在 run() 里按树深初始化
    this.floorPct = _resolveFloorPct(opts.floorPct);
    this.detector = opts.detector instanceof DeadLoopDetector ? opts.detector : new DeadLoopDetector();
    this.onDegrade = typeof opts.onDegrade === 'function' ? opts.onDegrade : null;
    this.availableTools = Array.isArray(opts.availableTools) ? opts.availableTools : null;
  }

  /**
   * 执行一棵降级树。无论成败都返回结构化结果，绝不抛错。
   * @param {object} tree     fallbackTree.build() 的产物
   * @param {object} context  意图上下文（透传给 Plan.buildParams / context.repair）
   * @returns {Promise<object>}
   *   成功: { ok:true, intent, plan, result, attempted }
   *   失败: { ok:false, intent, salvage:<兜底JSON>, attempted, circuit }
   */
  async run(tree, context = {}) {
    try {
      return await this._run(tree, context);
    } catch (err) {
      // 防呆：执行器自身炸了也要交差，绝不把异常抛给上层、绝不躺平。
      const salvage = SalvageProtector.assemble({
        intent: tree && tree.intent,
        description: tree && tree.description,
        attempted: [],
        salvageData: [],
        lastFailure: classifyFailure(err),
        circuit: 'executor-error',
      });
      return { ok: false, intent: tree && tree.intent, salvage, attempted: salvage.attempted_paths, circuit: 'executor-error' };
    }
  }

  async _run(tree, context) {
    if (!this.runner) throw new Error('BudgetAwareExecutor 需要注入 runner');
    if (!tree || !Array.isArray(tree.plans) || tree.plans.length === 0) {
      throw new Error('无效的降级树');
    }
    // 双保险：再次裁到硬上限（即便树被绕过 builder 构造）。
    const plans = tree.plans.slice(0, MAX_FALLBACK_DEPTH);
    if (!this.budget) this.budget = makeStepBudget(plans.length);

    const ctx = { intent: tree.intent, ...context };
    const attempted = [];
    const salvageData = [];
    let lastFailure = null;

    for (let i = 0; i < plans.length; i++) {
      const node = plans[i];
      const remainingPlans = plans.length - i;
      const snap = this.budget.snapshot();

      // ── 预算闸门①：低于地板，禁止开启新 Plan → 立即兜底。
      if (snap.remainingPct < this.floorPct) {
        attempted.push({ plan: node.plan, reason: `skipped:budget-floor(${snap.remainingPct}%<${this.floorPct}%)`, retry: 0 });
        return this._toSalvage(tree, attempted, salvageData, lastFailure, 'budget-floor');
      }
      // ── 预算闸门②：剩余不足以支撑后续全部节点 → 立即兜底。
      if (snap.remainingUnits < remainingPlans) {
        attempted.push({ plan: node.plan, reason: `skipped:budget-insufficient(${snap.remainingUnits}<${remainingPlans})`, retry: 0 });
        return this._toSalvage(tree, attempted, salvageData, lastFailure, 'budget-insufficient');
      }

      // ── 执行该 Plan（含至多 1 次"修复后"重试）。
      const outcome = await this._runPlan(node, ctx, lastFailure);
      attempted.push(outcome.record);
      if (outcome.salvage !== null && outcome.salvage !== undefined && outcome.salvage !== '') {
        salvageData.push(outcome.salvage);
      }
      if (outcome.ok) {
        return { ok: true, intent: tree.intent, plan: node.plan, result: outcome.result, attempted };
      }
      lastFailure = outcome.failure;

      // ── 失败 → 强制向下降级（绝不回头重试本 Plan）。注入模型上下文。
      const next = plans[i + 1] || null;
      if (next && this.onDegrade) {
        try { this.onDegrade(this.buildDegradeContext(tree, node, next, lastFailure)); } catch { /* 注入失败不影响降级 */ }
      }
    }

    // ── 树遍历完毕仍失败 = 结束，绝不开启第二遍循环。
    return this._toSalvage(tree, attempted, salvageData, lastFailure, 'tree-exhausted');
  }

  /**
   * 执行单个 Plan：首发 + 至多一次"修复后"重试。
   * @returns {{ ok:boolean, result?:*, failure?:object, record:object, salvage:* }}
   */
  async _runPlan(node, ctx, priorFailure) {
    const params = _safeBuildParams(node, ctx);

    // 死循环检测：与上一发已执行调用完全相同 → 强制跳过，连首发都不打。
    const probe = this.detector.inspect(node.tool, params);
    if (probe.dead) {
      return {
        ok: false,
        failure: { code: 'DEAD_LOOP', reason: 'dead-loop', retryable: false, missingDependency: null, message: '与上一次调用完全相同，判定死循环，强制跳过。' },
        record: { plan: node.plan, reason: 'dead-loop-skip', retry: 0 },
        salvage: null,
      };
    }

    // 首发。
    this.budget.spendOne();
    let result = await _safeRun(this.runner, node.tool, params, { plan: node.plan, intent: ctx.intent, retry: 0 });
    if (_isSuccess(node, result)) {
      return { ok: true, result, record: { plan: node.plan, reason: 'ok', retry: 0 }, salvage: _salvageOf(node, result) };
    }
    let failure = classifyFailure(result);
    let salvage = _salvageOf(node, result);

    // ── 至多一次"修复后"重试（max_retry=1）。仅当：
    //    a) 协议允许（MAX_RETRY_PER_PLAN>=1），且
    //    b) ctx.repair 提供了修复，且把入参/依赖真正改变了（签名变了），且
    //    c) 改变后的新调用不构成死循环。
    if (MAX_RETRY_PER_PLAN >= 1 && typeof ctx.repair === 'function') {
      let repair = null;
      try { repair = await ctx.repair({ node, failure, params, context: ctx }); } catch { repair = null; }
      const nextParams = repair && repair.params && typeof repair.params === 'object' ? repair.params : null;
      const reallyChanged = !!(repair && repair.changed && nextParams
        && this.detector.changed(node.tool, params, node.tool, nextParams));
      if (reallyChanged) {
        const probe2 = this.detector.inspect(node.tool, nextParams);
        if (!probe2.dead) {
          this.budget.spendOne();
          const result2 = await _safeRun(this.runner, node.tool, nextParams, { plan: node.plan, intent: ctx.intent, retry: 1 });
          if (_isSuccess(node, result2)) {
            return { ok: true, result: result2, record: { plan: node.plan, reason: 'ok-after-repair', retry: 1 }, salvage: _salvageOf(node, result2) };
          }
          failure = classifyFailure(result2);
          const s2 = _salvageOf(node, result2);
          if (s2) salvage = s2;
          return { ok: false, failure, record: { plan: node.plan, reason: failure.reason, retry: 1 }, salvage };
        }
      }
    }

    // 无修复 / 修复没真正改变输入 → 不重试（同类错误严禁死缠），直接降级。
    return { ok: false, failure, record: { plan: node.plan, reason: failure.reason, retry: 0 }, salvage };
  }

  /** 组装兜底并包成统一返回形状。 */
  _toSalvage(tree, attempted, salvageData, lastFailure, circuit) {
    const salvage = SalvageProtector.assemble({
      intent: tree.intent,
      description: tree.description,
      attempted,
      salvageData,
      lastFailure,
      circuit,
    });
    return { ok: false, intent: tree.intent, salvage, attempted, circuit };
  }

  /**
   * 构造注入给模型的「强制降级」上下文（模型在环路径）。措辞对齐协议要求：
   * 点名失败原因、播报剩余预算、强制规划下一个 Plan、列出剩余工具、禁止道歉与"再试一次"。
   */
  buildDegradeContext(tree, failedNode, nextNode, failure) {
    const snap = this.budget.snapshot();
    const tools = (this.availableTools || tree.plans.map((p) => p.tool)).join(', ');
    const why = (failure && (failure.reason || failure.code)) || '未知原因';
    return [
      `Plan ${failedNode.plan} 因 [${why}] 失败。`,
      `剩余预算：${snap.remainingPct}%。`,
      `系统强制要求你基于剩余能力规划 Plan ${nextNode.plan}（工具：${nextNode.tool}）。`,
      `你的剩余工具：[${tools}]。`,
      '禁止道歉，禁止输出"让我再试一次"而不改变方法，直接输出 Plan 的工具调用。',
    ].join(' ');
  }
}

// ── 内部纯助手（全部 fail-safe）─────────────────────────────────────

function _safeBuildParams(node, ctx) {
  try {
    const p = node.buildParams(ctx);
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

async function _safeRun(runner, tool, params, meta) {
  try {
    const r = await runner(tool, params, meta);
    return r === undefined || r === null ? { success: false, error: 'runner 返回空结果' } : r;
  } catch (err) {
    // 把硬抛错收敛成结构化失败，交给 classifyFailure 归类。
    return { success: false, error: (err && err.message) || String(err) };
  }
}

function _isSuccess(node, result) {
  if (node.isSuccess) {
    try { return !!node.isSuccess(result); } catch { return false; }
  }
  return !!(result && result.success === true);
}

function _salvageOf(node, result) {
  if (!node.extractSalvage) return null;
  try {
    const s = node.extractSalvage(result);
    return s === undefined ? null : s;
  } catch {
    return null;
  }
}

module.exports = {
  BudgetAwareExecutor,
  makeStepBudget,
  makeTokenBudget,
  DEFAULT_FLOOR_PCT,
};
