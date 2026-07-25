'use strict';

/**
 * selfHeal/index.js — 「诊断-修复-重试」自愈微循环子系统门面。
 *
 * 把五大件收成稳定 API，供上层（toolUseLoop / 子代理 / 网关）以零侵入方式接入：
 *
 *   const { FallbackTreeWithHeal } = require('.../selfHeal');
 *   const { makeToolRunner } = require('.../resilience');
 *   const heal = new FallbackTreeWithHeal({
 *     runner: makeToolRunner(executeTool),
 *     confirm: async ({diagnosis}) => askUser(diagnosis.action),  // L1 获批
 *     onDegrade: (text) => injectSystemTurn(text),
 *   });
 *   const outcome = await heal.run('fetch-web-content', { url, query, control });
 *   // outcome.status === 'ok' ? outcome.result : outcome（Goal3 兜底报告）
 *
 * 设计：自愈微循环（左半，本子系统）+ resilience 降级树（右半，复用）= 完整闭环。
 * 规范：docs/03_DESIGN_设计/[DESIGN-ARCH-029] Agent 自愈微循环.md
 */

const diagnosisDictionary = require('./diagnosisDictionary');
const { ErrorDiagnostician } = require('./errorDiagnostician');
const { PrescriptionDeadLoopDetector } = require('./deadLoopDetector');
const { FixActions } = require('./fixActions');
const { MicroLoopExecutor, MAX_LOOP } = require('./microLoopExecutor');
const { FallbackTreeWithHeal } = require('./fallbackTree');

module.exports = {
  // 门面
  FallbackTreeWithHeal,
  // 组件
  ErrorDiagnostician,
  MicroLoopExecutor,
  PrescriptionDeadLoopDetector,
  FixActions,
  // 字典（单一真源）
  diagnosisDictionary,
  diagnose: diagnosisDictionary.diagnose,
  RISK: diagnosisDictionary.RISK,
  RUNTIME_FALLBACKS: diagnosisDictionary.RUNTIME_FALLBACKS,
  // 常量
  MAX_LOOP,
};
