'use strict';

/**
 * selfRepair/transactionRunner — 自修复事务的编排器(纯编排 + 依赖注入)。
 *
 * 仿 auditFixLoop/index.js:本模块不知道如何 git stash、如何跑 node --check、如何 require
 * 守卫——这些 IO 原语由调用方(toolUseLoop / selfRepair/primitives.js)注入。决策(去留、
 * 改动集归一、配置)全部委托纯叶子 selfRepairTransaction.js。这样本模块可用 stub 原语做
 * 零真 IO 的单元测试,且不背 AgentTool / git / fs 的重机器。
 *
 *   runRepairTransaction({ runFix, snapshot, restore, validateFiles, onEvent, env })
 *     runFix()                      => Promise<{ text, filesModified?:string[], success? }>
 *     snapshot()                    => Promise<snap|null>   // 改前快照句柄(null=无回滚能力)
 *     restore(snap, changeSet)      => Promise<boolean>     // true=回滚完整执行
 *     validateFiles(files, plan)    => Promise<{ syntax?, guards?, tests? }>
 *
 * 流程:plan → snapshot → runFix → classify → validate → decide → keep|rollback。
 *
 * fail-soft(绝不比今天差):事务机器自身任一原语抛错,都吞掉、回退到「未包装的 fixResult」
 * (保留修复、不回滚)。绝不因校验机器故障而丢弃一个可能正确的修复。门控关时直接跑 runFix。
 */

const leaf = require('../selfRepairTransaction');
const evo = require('../evolutionPolicy');
const safety = require('../evolutionSafety');

/**
 * 包裹一次 fix 派发为可校验、可回滚的事务。
 * @param {object} opts
 * @returns {Promise<object>} fix 结果,成功包裹时附 `transaction` 字段
 */
async function runRepairTransaction(opts = {}) {
  const {
    runFix,
    snapshot = async () => null,
    restore = async () => true,
    validateFiles = async () => ({}),
    onEvent = null,
    env = (typeof process !== 'undefined' ? process.env : {}),
  } = opts;

  if (typeof runFix !== 'function') {
    return { text: '', filesModified: [], success: false, error: 'no runFix injected' };
  }

  const _emit = (evt) => { if (onEvent) { try { onEvent(evt); } catch { /* best-effort */ } } };

  const plan = leaf.planTransaction({}, env);

  // 门控关:字节回退到 fix agent 直接改。
  if (!plan.enabled) {
    return runFix();
  }

  let snap = null;
  let snapshotMissing = false;
  let fixResult;
  try {
    // ① 改前快照(best-effort:失败/缺失则继续,但失去回滚能力)。
    _emit({ type: 'repair_snapshot_start' });
    try {
      snap = await snapshot();
    } catch (e) {
      snap = null;
      _emit({ type: 'repair_snapshot_error', error: e && e.message });
    }
    if (!snap) snapshotMissing = true;
    _emit({ type: 'repair_snapshot_done', snapshot: !snapshotMissing });

    // ② 跑既有 fix agent(全程在稳定的旧内存代码上)。
    fixResult = await runFix();
    fixResult = fixResult && typeof fixResult === 'object'
      ? fixResult
      : { text: '', filesModified: [], success: false };

    // ③ 归一改动集 + 进化策略评估(对**全量** filesModified 分级,不可变文件可能落在 skipped,
    //    所以策略评估不能只看 validatable)。门控关 → assessEvolution 返回 enabled:false 的安全空。
    const changeSet = leaf.classifyChangeSet(fixResult.filesModified, plan);
    const evolution = evo.assessEvolution({ changedFiles: fixResult.filesModified, env });

    // 无可校验源文件 **且** 未触碰不可变区域 **且** 无授权越权留痕 → 保持既有早返回(字节不变)。
    // 触碰了不可变区域(哪怕没有可校验源)仍要进决策 → 回滚;
    // 已授权越权(overrides 非空)也要进决策,以产出审计告警(满足「越权全程审计」不变量)。
    // 越权门控关时 evolution.overrides 恒为 [] → 条件不变 → 字节回退。
    const hasOverride = Array.isArray(evolution.overrides) && evolution.overrides.length > 0;
    if (changeSet.validatable.length === 0 && !evolution.blocked && !hasOverride) {
      return { ...fixResult, transaction: { decision: null, changeSet, snapshotMissing } };
    }

    // ④ 校验改动集(语法 + 守卫 + 可选测试),并把进化评估并入 validation 交决策器。
    //    进化安全(门控开):有行为源改动 → 强制把受影响测试跑起来(effPlan.runTests=true),
    //    否则「不引入 bug」无从验证。primitives 只会跑存在且 node:test 的测试(jest 文件不误跑),
    //    并回传 coverage;门控关 → requiresVerification 恒 false → effPlan===plan → 字节回退。
    _emit({ type: 'repair_validate_start', files: changeSet.validatable.length });
    const needVerify = safety.requiresVerification({ changedFiles: changeSet.validatable, env });
    const effPlan = needVerify ? { ...plan, runTests: true } : plan;
    const validation = changeSet.validatable.length
      ? await validateFiles(changeSet.validatable, effPlan)
      : {};
    // 由实测结果 + 覆盖率构安全裁决(门控关 → enabled:false 的安全空 → decideOutcome 不读不写)。
    const safetyAssessment = safety.assessSafety({
      changedFiles: changeSet.validatable,
      tests: validation.tests,
      coverage: validation.coverage,
      env,
    });
    const decision = leaf.decideOutcome({ ...validation, evolution, safety: safetyAssessment }, env);
    // 安全报告(AI 可读 [SYSTEM:] 指令)随事件透传给 onEvent 消费方(toolUseLoop 可据此反馈);
    // 门控关 → buildSafetyReport 返 '' → 字段为空。
    _emit({
      type: 'repair_validate_done',
      keep: decision.keep,
      failures: decision.failures.length,
      safetyReport: safety.buildSafetyReport(safetyAssessment),
    });

    // ⑤ 不通过且有快照 → 回滚。
    let rolledBack = null;
    if (!decision.keep && snap) {
      _emit({ type: 'repair_rollback_start' });
      try {
        rolledBack = await restore(snap, changeSet);
      } catch (e) {
        rolledBack = false;
        _emit({ type: 'repair_rollback_error', error: e && e.message });
      }
      _emit({ type: 'repair_rollback_done', rolledBack });
    }

    const annotation = leaf.summarizeTransaction({ decision, changeSet, rolledBack, snapshotMissing });
    return {
      ...fixResult,
      // 回滚后这些文件已还原,不应再算作会话改动 —— 交由调用方按 transaction.rolledBack 处理。
      transaction: { decision, changeSet, snapshotMissing, rolledBack, annotation },
    };
  } catch (err) {
    // 事务机器自身故障:fail-soft,返回 fix 结果(若已得)或安全空壳,绝不抛进调用方。
    _emit({ type: 'repair_error', error: err && err.message });
    if (fixResult && typeof fixResult === 'object') return fixResult;
    return { text: '', filesModified: [], success: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = { runRepairTransaction };
