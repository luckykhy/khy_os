'use strict';

/**
 * projectCoherence/index.js — 项目整体意识门面（[DESIGN-ARCH-050] §4 编排）。
 *
 * 给 Khyos 补上两块缺失的「整体性」基因：
 *
 *   ① 项目整体意识 —— 文件可以一个个写对，但聚成项目后导入断链、入口失配、清单指空，
 *      一跑就崩。analyzeProjectCoherence() 把一批产物当作整体静态体检，evaluateCoherenceGate()
 *      在模型想收尾时把断裂顶回去，逼它先把项目装配成一个能跑的整体再交付。
 *
 *   ② 自驱收尾 —— 不推它就不出结果。evaluateClosure() 与模型档无关地兜底：干了活却只回进度
 *      前言时，强制再推一轮写出最终结果。
 *
 * 两者都是**纯函数门面 + 有界 + fail-safe**：分析/决策不抛错、不调模型、不死循环；
 * 接入方（toolUseLoop）只需在收尾时刻调用并据返回的 message/continue 决定是否再推一轮。
 */

const path = require('path');
const { analyze, SEVERITY } = require('./coherenceAnalyzer');
const coherenceGate = require('./coherenceGate');
const deliverableClosure = require('./deliverableClosure');

const CODE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.json']);

/** 从一批文件里数出「代码/清单」文件数——单文件改动不该触发整体性门。 */
function countCodeFiles(files) {
  let n = 0;
  for (const f of files || []) {
    const ext = path.extname(String(f)).toLowerCase();
    const base = path.basename(String(f)).toLowerCase();
    if (CODE_EXT.has(ext) || base === 'package.json') n += 1;
  }
  return n;
}

/**
 * 对一批产物做整体一致性体检。fail-safe：任何异常都返回空断裂，绝不阻塞交付。
 * @param {object} opts  透传给 analyzer：{ files, cwd, readFile, knownFiles, maxFiles }
 * @returns {{gaps:Array, analyzed:number, skipped:number, codeFileCount:number}}
 */
function analyzeProjectCoherence(opts = {}) {
  try {
    const res = analyze(opts);
    return { ...res, codeFileCount: countCodeFiles(opts.files) };
  } catch {
    return { gaps: [], analyzed: 0, skipped: 0, codeFileCount: 0 };
  }
}

/**
 * 一站式评估：是否需要因「项目不自洽」而拦下收尾。
 * @param {object} opts
 * @param {string[]} opts.files
 * @param {string}   [opts.cwd]
 * @param {function} [opts.readFile]
 * @param {Iterable<string>} [opts.knownFiles]
 * @param {number}   [opts.rounds=0]
 * @param {number}   [opts.maxRounds=2]
 * @param {boolean}  [opts.blockOnMedium=false]
 * @param {number}   [opts.minFiles=2]
 * @returns {{shouldGate:boolean, message:string|null, gaps:Array, blocking:Array, reason:string}}
 */
function evaluateCoherenceGate(opts = {}) {
  try {
    const { gaps, codeFileCount } = analyzeProjectCoherence(opts);
    const decision = coherenceGate.decide({
      gaps,
      codeFileCount,
      rounds: opts.rounds || 0,
      maxRounds: opts.maxRounds,
      minFiles: opts.minFiles,
      blockOnMedium: opts.blockOnMedium,
    });
    if (!decision.shouldGate) {
      return { shouldGate: false, message: null, gaps, blocking: [], reason: decision.reason };
    }
    const round = (opts.rounds || 0) + 1;
    const message = coherenceGate.buildGateMessage(decision.blocking, round, opts.maxRounds || 2, gaps);
    return { shouldGate: true, message, gaps, blocking: decision.blocking, reason: decision.reason };
  } catch {
    return { shouldGate: false, message: null, gaps: [], blocking: [], reason: 'error' };
  }
}

/**
 * 自驱收尾评估（与模型档无关）。
 * @param {object} opts  透传 deliverableClosure.shouldForceClosure 入参 + userMessage
 * @returns {{shouldForce:boolean, message:string|null}}
 */
function evaluateClosure(opts = {}) {
  try {
    if (!deliverableClosure.shouldForceClosure(opts)) {
      return { shouldForce: false, message: null };
    }
    return { shouldForce: true, message: deliverableClosure.buildClosureMessage(opts.userMessage) };
  } catch {
    return { shouldForce: false, message: null };
  }
}

/**
 * 自驱启动评估（收尾评估的镜像，与模型档无关）。
 * 仅在「连一个工具都没调、只回了计划前言」时为真，命令模型现在就开始执行第一步。
 * @param {object} opts  透传 deliverableClosure.shouldForceKickoff 入参 + userMessage
 * @returns {{shouldForce:boolean, message:string|null}}
 */
function evaluateKickoff(opts = {}) {
  try {
    if (!deliverableClosure.shouldForceKickoff(opts)) {
      return { shouldForce: false, message: null };
    }
    return { shouldForce: true, message: deliverableClosure.buildKickoffMessage(opts.userMessage) };
  } catch {
    return { shouldForce: false, message: null };
  }
}

module.exports = {
  analyzeProjectCoherence,
  evaluateCoherenceGate,
  evaluateClosure,
  evaluateKickoff,
  countCodeFiles,
  SEVERITY,
  // 子模块直出，便于精细化测试/复用
  _analyzer: require('./coherenceAnalyzer'),
  _gate: coherenceGate,
  _closure: deliverableClosure,
};
