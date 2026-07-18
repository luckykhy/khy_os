'use strict';

/**
 * planModeDirective.js — 纯叶子:计划模式「先调研再做计划」的 per-turn [SYSTEM] 指令构造。
 *
 * 用户诉求(goal 2026-07-06):把 Khy 的计划模式与 Claude Code 对齐——学会**先调研再做计划**、
 * 有**实时工具调用显示**、**不要一来就直接是大方框**。旧计划模式是单次 ai.chat():提交即弹
 * 「◴ 正在生成执行计划…」大方框、模型零调研直接吐(或吐口语化「让我先了解一下环境」被当成失败)。
 *
 * CC 对齐后,计划提交改走真·工具循环(toolUseLoop),该循环在只读窗口内先让模型调研。本叶子只
 * 负责产出「计划模式该怎么做」的那段 [SYSTEM] 指令文本:告诉模型先用只读工具(Read/Grep/Glob/LS)
 * 调研、别急着出计划、调研够了再调 ExitPlanMode(action:'approve', plan:<编号步骤>)把计划交给用户。
 * 具体的循环注入点(toolUseLoop 首轮 currentMessage)与 ExitPlanMode 拦截由 caller 负责,本叶子
 * 与 TUI / 循环 / 计划服务彻底解耦,便于确定性测试与门控回退。
 *
 * 契约:纯叶子——零 I/O(不碰 fs / 网络 / 子进程 / 计划服务),确定性(无时钟 / 随机),绝不抛(fail-soft)。
 *
 * 门控(dogfood flagRegistry):
 *   KHY_PLAN_CC_RESEARCH  默认 on——计划模式 CC 对齐总开关。
 *     关 ⇒ buildPlanDirective 恒返 ''(空串;caller 不注入指令、计划模式逐字节回退旧单次 startPlan)。
 *
 * @module services/planModeDirective
 */


const _isEnabled = require('../utils/isEnabledDefaultOn');

/** 计划模式 CC 对齐总开关。默认 on。 */
function isPlanResearchEnabled(env) {
  return _isEnabled('KHY_PLAN_CC_RESEARCH', env);
}

// 单一真源:计划模式研究指令。以 [SYSTEM] 前缀,与 toolUseLoop 既有 app-launch / capability 注入同构,
// 只在计划模式(planMode)且门开时由 caller 追加到首轮 currentMessage。
const PLAN_DIRECTIVE = [
  '[SYSTEM: 你现在处于计划模式(PLAN MODE)——只调研、不改动。',
  '写入 / 执行类工具在本轮全部被禁用;只有只读工具(Read/Grep/Glob/LS/WebFetch 等)可用。',
  '第一步:先调研,别急着写计划。用只读工具真正了解需求相关的现状——',
  '读相关文件、搜索代码、确认环境与现有工具,像高级工程师做方案前的尽调一样。',
  '你的工具调用会实时显示给用户,这就是进度,不必额外解说。',
  '不要只回一句「让我先了解一下环境」然后停下——那不是计划;要么继续调研,要么给出计划。',
  '第二步:当你对现状理解足够,调用 ExitPlanMode(action:"approve", plan:"…") 把计划交给用户审阅。',
  'plan 字段写成编号的执行计划(1. 2. 3. …),每步一句、具体可执行、含关键文件/改动点。',
  '用 ExitPlanMode 呈现计划(不要用 AskUserQuestion);用户只有在你调用它时才能看到计划详情。',
  '在给出 ExitPlanMode 之前,不要尝试任何写入 / 执行操作(会被拒绝)。]',
].join('\n');

/**
 * 构造计划模式研究指令块。门关或异常 → 空串(caller 不注入)。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} 计划模式 [SYSTEM] 指令,或空串
 */
function buildPlanDirective(env) {
  try {
    if (!isPlanResearchEnabled(env)) return '';
    return PLAN_DIRECTIVE;
  } catch {
    return '';
  }
}

module.exports = {
  isPlanResearchEnabled,
  buildPlanDirective,
  PLAN_DIRECTIVE,
};
