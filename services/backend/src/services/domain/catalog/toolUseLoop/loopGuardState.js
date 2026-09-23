'use strict';

/**
 * domain/catalog/toolUseLoop/loopGuardState.js — the pre-loop guard / iteration-state
 * cluster, extracted verbatim from runToolUseLoop's body (T-021 in-body phase slice #1).
 *
 * `createLoopGuardState()` returns the 47 one-time (pre-loop) loop-state bindings: nudge
 * one-shot flags, bounded redrive/retry counters + their env-derived caps, the refusal/
 * repetition/closure signature trackers, the streaming-repetition handles, and the
 * per-turn Set accumulators. Every value is a literal, a `new Set()`, or an IIFE that
 * reads only `process.env` — NO reference to other loop state, NO IO, NO control flow.
 *
 * Behavior-preserving: the core destructures the returned bag back into the ORIGINAL
 * underscore names (`let { … } = _createLoopGuardState()`) at the exact source position,
 * so all downstream reads AND reassignments (`_stallNudgeUsed++`, `executionPlan = …`,
 * `_allModifiedFiles.add(…)`, …) are byte-identical. Caps are computed at call time =
 * the original block's position in the turn. Leaf has ZERO static requires → no core
 * back-edge (M6 cycles stay 0); `process.env` is a global, read at the same instant.
 */

function createLoopGuardState() {
  let executionPlan = null; // Parsed execution plan { steps: [...] }
  let currentPlanStep = 0;
  let noToolNudgeUsed = false; // 精简后仅允许 1 次 nudge（对标 CC/DS 无 nudge 策略）
  let _codingVerifyNudgeUsed = false; // coding mode 验证提示只触发一次
  let _verificationNudgeUsed = false; // Phase R2-3B: 3+ writes without verify → one-shot nudge
  // 执行中复杂度升级(executionComplexitySignals):开场按措辞判定为简单、但执行证据
  // (改动文件数/跨目录数/已用轮次/连续失败)显示规模更大时,一次性要求补计划 + 登记任务板。
  let _execComplexityEscalated = false;
  let _deliveryConclusionNudgeUsed = false; // 交付结论 nudge 只触发一次
  let _resultGuardNoticeUsed = false; // 结果守卫诚实收尾只追加一次/轮
  let _intentCoverageNudgeUsed = false; // [答得没接住意图] 意图接住回核 nudge 只触发一次
  let _errorCoverageNudgeUsed = false; // [先枚举再修复] 错误覆盖回核 nudge 只触发一次
  let _followThroughNudgeUsed = false; // [修复智能体纪律] 说了却没做就收场 → 跟进回核只触发一次
  let _failureRecoveryNudgeUsed = false; // 工具失败后模型短回复放弃 → 推一次换方法/解释
  let _unfulfilledIntentNudges = 0; // 虚假完成守卫:回复以承诺句收尾却零工具调用 → 有界再推(最多 2 次)
  let _unknownProbesUsed = 0; // 面对未知(未知工具/陌生概念/无法归类错误)→ 放弃前的有界主动探索次数
  let _pseudoRefusalNudgeUsed = false; // 工具成功取回数据后却套话拒绝 → 推一次「用已有结果作答」
  // 无感衔接保底（Goal）：AI 卡壳（空回复终态）报错前，先轻推 1-2 次再报。即便上游把
  // 各重试预算配成 0（KHY_TOOL_LOOP_EMPTY_RECOVERIES=0 等），也保证至少一次「继续」轻推，
  // 不行才报错。计数器 + 上限确保至多 2 次，绝不死循环。
  let _stallNudgeUsed = 0;
  const _stallNudgeMax = (() => {
    const v = parseInt(String(process.env.KHY_TOOL_LOOP_STALL_NUDGES ?? '2'), 10);
    return Number.isFinite(v) ? Math.max(1, Math.min(2, v)) : 2;
  })();
  // 无工具数据时的纯套话拒绝（「你好，我无法给到相关内容」）是上游通道降级/网络波动的
  // 典型签名，而非真做不了。有界重试几次（带退避）再保底报错，绝不一次就放弃，也绝不死循环。
  let _bareRefusalRetries = 0;
  const _bareRefusalRetryMax = (() => {
    const v = parseInt(String(process.env.KHY_TOOL_LOOP_REFUSAL_RETRIES ?? '2'), 10);
    return Number.isFinite(v) ? Math.max(0, Math.min(3, v)) : 2;
  })();
  // 死循环 break：上一轮套话拒绝的归一签名。若 nudge 之后模型又**原样**吐回同一句
  // 拒绝（同签名），说明它在「同一个地方反复跌倒」——立即跳出重试，不再重复同一条
  // 错误路径（用户复盘指出的「缺少的 break」）。null = 本会话尚无拒绝。
  let _lastRefusalSig = null;
  // 重复退化（degeneration）矫正：弱模型把同一短片段（如「要,」）反复输出上千次，
  // 在流式通道淹没用户。检测到即「及时矫正而非断命」——掐住流式洪水、丢废稿、重发
  // 一次纠偏指令让模型干净重写；仅当重写仍退化才回落已抢救的干净前缀（绝不报错断连）。
  let _repetitionRetries = 0;
  const _repetitionRetryMax = (() => {
    const v = parseInt(String(process.env.KHY_TOOL_LOOP_REPETITION_RETRIES ?? '1'), 10);
    return Number.isFinite(v) ? Math.max(0, Math.min(3, v)) : 1;
  })();
  let _lastRepetitionSig = null; // 上轮重复签名：纠偏后又同样退化 → 停止重试，回落抢救
  let _streamRepGuard = null; // 每轮新建的流式重复检测实例（onChunk 包装器引用）
  let _streamRepetitionTripped = false; // 本轮流式是否已判定退化（判定后吞掉后续洪水）
  let _uphSanitizeUsed = false; // Unknown-Problem Handler: 偏离预警净化指令每轮只注入一次（防自旋）
  // ── Hard verification gate state (edit → verify → iterate) ─────────
  const _allModifiedFiles = new Set(); // session-level accumulator of successfully edited files
  // 自维护顾问「每文件每轮去重」集合(函数作用域=随每个顶层 turn 天然新鲜,无需显式 reset)。
  const _selfEditAdvised = new Set();
  // 弱模型改红线/敏感顾问「每文件每轮去重」集合(与上同作用域,同一 turn 内每文件只提示一次)。
  const _weakModelAdvised = new Set();
  let _verifyGateRounds = 0; // bounded retries forced by the gate
  let _verifyGateExhausted = false; // ceiling reached → conclude but annotate
  let _nonEditVerifyRounds = 0; // [P6] bounded retries for non-edit evidence self-check
  let _stopReasonRecoveryUsed = false; // 批1: native stop_reason=tool_use 但 blocks 丢失 → 一次性续跑恢复
  // ── 项目整体一致性门 + 自驱收尾保障 ([DESIGN-ARCH-050]) ────────────
  let _coherenceGateRounds = 0; // 整体性门已用轮次（有界，绝不死循环）
  let _coherenceGateExhausted = false; // 到顶仍不自洽 → 放行但标注
  let _closureGuardCount = 0; // 自驱收尾保障：有界计数（替代旧一次性，治「工具后连续过渡语就收场」）
  let _lastClosureSig = null; // 上次收尾 nudge 时的回复签名 —— 同句原样重复即停，防死循环燃 Token
  let _kickoffGuardCount = 0; // 自驱启动/续作保障：有界计数（替代旧一次性，治「半截话反复手推」）
  let _lastKickoffSig = null; // 上次自驱时的前言签名 —— 同句原样重复即停，防死循环燃 Token
  // ── 持久目标 Stop-gate（goal 2026-07-03「让 khy 学会使用 CC 的 goal 模式」）───────
  let _goalStopRedrives = 0; // 本轮内 goal 感知再驱动次数（有界，跨轮由轮次预算兜底）
  let _lastGoalStopSig = null; // 上次 goal 再驱动时的回复签名 —— 同句原样重复即停，防死循环
  // Self-heal: parse error (e.g. "Unexpected token '}'") retry guard — retry at most once per loop
  let _parseErrorRetried = false;
  // ── 完成时审计→修复闭环 state（阶段性/大任务收尾自动审计并修复）─────────
  let _auditFixDone = false; // 本轮已跑过审计闭环（一次性，绝不重复 spawn）
  let _auditFixAnnotation = ''; // 透明标注（遗留问题）→ 追加到 finalText 末尾
  // ── 任务收尾仲裁门（taskClosure.decideClosure）────────────────────
  // 未终态交付 → 有界 redrive（默认 1，KHY_TASK_CLOSURE_REDRIVE_MAX）；预算耗尽
  // → close_partial：诚实标注「未能完整闭环」随交付追加（规则 3，绝不假装成功）。
  let _taskClosureRedrives = 0; // 本轮已 redrive 次数（有界，绝不死循环）
  let _lastTaskClosureSig = null; // 上次仲裁门 redrive 时的回复签名 —— 同句原样重复即停，防死循环
  let _taskClosurePartialNote = ''; // close_partial 诚实标注（收尾汇合处追加到 finalText）
  return {
    executionPlan,
    currentPlanStep,
    noToolNudgeUsed,
    _codingVerifyNudgeUsed,
    _verificationNudgeUsed,
    _execComplexityEscalated,
    _deliveryConclusionNudgeUsed,
    _resultGuardNoticeUsed,
    _intentCoverageNudgeUsed,
    _errorCoverageNudgeUsed,
    _followThroughNudgeUsed,
    _failureRecoveryNudgeUsed,
    _unfulfilledIntentNudges,
    _unknownProbesUsed,
    _pseudoRefusalNudgeUsed,
    _stallNudgeUsed,
    _stallNudgeMax,
    _bareRefusalRetries,
    _bareRefusalRetryMax,
    _lastRefusalSig,
    _repetitionRetries,
    _repetitionRetryMax,
    _lastRepetitionSig,
    _streamRepGuard,
    _streamRepetitionTripped,
    _uphSanitizeUsed,
    _allModifiedFiles,
    _selfEditAdvised,
    _weakModelAdvised,
    _verifyGateRounds,
    _verifyGateExhausted,
    _nonEditVerifyRounds,
    _stopReasonRecoveryUsed,
    _coherenceGateRounds,
    _coherenceGateExhausted,
    _closureGuardCount,
    _lastClosureSig,
    _kickoffGuardCount,
    _lastKickoffSig,
    _goalStopRedrives,
    _lastGoalStopSig,
    _parseErrorRetried,
    _auditFixDone,
    _auditFixAnnotation,
    _taskClosureRedrives,
    _lastTaskClosureSig,
    _taskClosurePartialNote,
  };
}

module.exports = { createLoopGuardState };
