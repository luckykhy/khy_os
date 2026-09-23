'use strict';

/**
 * Per-task auxiliary monitor-state bootstrap extracted from runToolUseLoop
 * (T-021 C3-P5 — reuses the mutation-free cluster pattern proven by
 * protocolContext.js / intentGuards.js).
 *
 * Owns, verbatim from the former loop body, the one-time (pre-loop) creation of
 * five per-run handles, each SUPPRESSED for sub-agents (tactical execution must
 * not course-correct / re-assess the top-level plan) and fail-soft to null when
 * its service module is absent:
 *   - courseState       devCourseMonitor       (in-flight course correction)
 *   - reflectState      adaptiveExecution      (plan-vs-reality reflection)
 *   - attributionState  actionAttribution      (self-action claiming; NOT suppressed)
 *   - fpfState          falsePositiveFixGuard  (repro-before guard; bugfixIntent latch)
 *   - promptRound       repeatedPromptRounds   (which repeat round of the prompt)
 *
 * The creation must stay at its ORIGINAL position: it reads the RAW chatOpts for
 * ._isSubagent because effectiveChatOpts is not yet declared there (TDZ). The
 * caller keeps the lazy _tryOr requires of the five service modules and injects
 * them here, so this leaf has ZERO static requires and never joins the
 * require-graph SCC the R3 gate guards. The caller destructures the returned bag
 * back into the original underscore names, so every downstream reference — and
 * every in-place mutation of the returned state objects — stays unchanged.
 */

function createLoopMonitorStates(deps) {
  const {
    chatOpts,
    userMessage,
    initialMessages,
    courseMonitor,
    adaptiveExec,
    promptRounds,
    fpfGuard,
    actionAttribution,
  } = deps;

  // 子 agent 抑制:开发轨迹 / 反思 / 复现守卫 / 重复轮次皆不回核顶层计划。
  // _attributionState 是唯一不抑制者(见下)。
  const isSubagent = !!(chatOpts && chatOpts._isSubagent);

  const courseState =
    courseMonitor && !isSubagent && courseMonitor.isEnabled()
      ? courseMonitor.createState()
      : null;

  // 边做边想:「计划 vs 现实」反思状态。与 courseState 同源读原始 chatOpts 避 TDZ。fail-soft。
  const reflectState =
    adaptiveExec && !isSubagent && adaptiveExec.isEnabled()
      ? adaptiveExec.createState()
      : null;

  // 自我动作认领:子 agent 不抑制——子 agent 同样会执行删除/写入并叙述结果,认领规则对它
  // 同样适用。fail-soft:模块缺失则 null。
  const attributionState = actionAttribution
    ? actionAttribution.createAttributionState()
    : null;

  // 防 bug 误判:复现先行守卫状态;bugfixIntent 决定是否 engage。fail-soft。
  let fpfState = null;
  try {
    if (fpfGuard && !isSubagent && fpfGuard.isEnabled()) {
      fpfState = fpfGuard.createState();
      fpfState.bugfixIntent = fpfGuard.looksLikeBugfixTask(userMessage);
    }
  } catch {
    fpfState = null;
  }

  // 重复请求轮次:从历史 user 轮(initialMessages)数出当前提示词是第几轮重复。子 agent 抑制
  // (派生执行不是用户重复请求)。fail-soft。
  let promptRound = 1;
  try {
    if (promptRounds && !isSubagent && promptRounds.isEnabled()) {
      promptRound = promptRounds.countRound(
        userMessage,
        promptRounds.priorUserTextsFrom(initialMessages)
      );
    }
  } catch {
    promptRound = 1;
  }

  return { courseState, reflectState, attributionState, fpfState, promptRound };
}

module.exports = { createLoopMonitorStates };
