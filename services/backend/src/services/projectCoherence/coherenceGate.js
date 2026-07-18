'use strict';

/**
 * coherenceGate.js — 一致性门决策与注入文案（[DESIGN-ARCH-050] §3.4）。
 *
 * 纯决策：给定一次「模型想收尾」的时刻 + 分析出的断裂清单，判断是否拦下这一轮、
 * 强制模型先把项目装配好。它不读文件、不调模型，只做策略与文案——便于单测与复用。
 *
 * 拦截铁律：
 *   • 单文件改动不触发（codeFileCount 须 ≥ minFiles，默认 2）——「整体意识」只对多文件项目有意义。
 *   • 默认只对 HIGH 断裂硬拦截；MEDIUM（命名导出）随文案提示但是否拦截由 blockOnMedium 决定。
 *   • 有轮次上限（maxRounds），到顶即放行并标注，绝不死循环。
 */

const SEV_HIGH = 'high';

/**
 * @param {object} input
 * @param {Array}  input.gaps            analyze() 的产物
 * @param {number} input.codeFileCount   本会话写过的「代码/清单」文件数
 * @param {number} input.rounds          已用门轮次
 * @param {number} [input.maxRounds=2]
 * @param {number} [input.minFiles=2]
 * @param {boolean}[input.blockOnMedium=false]
 * @returns {{shouldGate:boolean, blocking:Array, reason:string}}
 */
function decide(input = {}) {
  const gaps = Array.isArray(input.gaps) ? input.gaps : [];
  const maxRounds = input.maxRounds || 2;
  const minFiles = input.minFiles || 2;
  const rounds = input.rounds || 0;
  const blockOnMedium = !!input.blockOnMedium;

  if ((input.codeFileCount || 0) < minFiles) {
    return { shouldGate: false, blocking: [], reason: 'too_few_files' };
  }
  if (rounds >= maxRounds) {
    return { shouldGate: false, blocking: [], reason: 'rounds_exhausted' };
  }
  const blocking = gaps.filter((g) => g.severity === SEV_HIGH || (blockOnMedium && g.severity === 'medium'));
  if (blocking.length === 0) {
    return { shouldGate: false, blocking: [], reason: 'no_blocking_gaps' };
  }
  return { shouldGate: true, blocking, reason: 'incoherent' };
}

/**
 * 构造注入给模型的中文系统消息，逐条列出断裂并要求用工具修复后再收尾。
 * @param {Array}  blocking  decide().blocking
 * @param {number} round
 * @param {number} maxRounds
 * @param {Array}  [allGaps] 完整清单（用于附带 MEDIUM 提示）
 */
function buildGateMessage(blocking, round, maxRounds, allGaps) {
  const lines = blocking.slice(0, 12).map((g, i) => `  ${i + 1}. ${g.detail}`);
  const mediums = (allGaps || [])
    .filter((g) => g.severity === 'medium' && !blocking.includes(g))
    .slice(0, 6)
    .map((g) => `  - ${g.detail}`);

  let msg = '[项目整体一致性门 — 单个文件看似没问题，但把它们装配成一个项目后存在以下断裂，'
    + '直接交付会导致项目跑不起来。请用工具（写文件/改文件/补文件）逐一修复后再收尾：]\n'
    + lines.join('\n');
  if (mediums.length) {
    msg += '\n\n[以下为疑似问题（置信度较低，请自行判断是否需要处理）：]\n' + mediums.join('\n');
  }
  msg += `\n\n[一致性轮次 ${round}/${maxRounds}。修复断裂后再给最终结论；`
    + '若判断某条是误报（如该模块由外部依赖提供），请简要说明理由再收尾。]';
  return msg;
}

module.exports = { decide, buildGateMessage };
