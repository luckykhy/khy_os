'use strict';

/**
 * redLine.js — 「L2 红灯」的人类可读单一真源（明确「哪些属于红灯」）。
 *
 * 决策权威仍是 resourceClassifier.classify（三级动作矩阵）与
 * riskGate.isUnbypassableGate（不可旁路闸门）——本模块**不重复造决策**，只把
 * 「红线是什么、为什么这一条调用是/不是红线」讲成一句小白也能懂的话，供执行前
 * 说明器（preExecutionExplainer）与文档统一引用，杜绝口径分散。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * L2 红灯 = 真正**不可逆 / 破坏性 / 系统级提权**的操作（收敛后的明确定义）：
 *   · 删除或覆盖既有数据      rm / del / drop table / git reset --hard / 覆盖写
 *   · 修改宿主环境            改环境变量(ENV) / 写系统级路径(/etc、C:\Windows…)
 *   · 全局装包                npm i -g / pip install / apt install …
 *   · 杀进程 / 监听物理端口 / 执行任意代码 / 跳出 OS 沙箱全权执行
 *
 * **不属于**红线（默认放行或仅黄灯问一次）：
 *   · 只读                    读文件 / grep / ls / git status / 系统信息查询
 *   · 可逆的项目内写入        在工作区内新建/编辑文件、本地构建、npm test、git add
 *   · 普通网络出站            一次 API 调用 / 下载到工作区
 * ──────────────────────────────────────────────────────────────────────────
 *
 * 纯函数、fail-closed：任何判定异常一律按「是红线」（宁可多提示一次）。
 */

const { ACTIONS } = require('./intentSchema');
const { classify, LEVELS } = require('./resourceClassifier');

// 红线动作 → 一句话「为什么这是红线」。键与 intentSchema.ACTIONS 一一对应。
// 这是「哪些属于红灯」的明确清单，与 resourceClassifier._ALWAYS_L2_ACTIONS 对齐
// （同一批动作），此处补足面向人的语义说明。
const RED_LINE_ACTION_LABELS = Object.freeze({
  [ACTIONS.DELETE]: '删除 / 覆盖数据（不可逆）',
  [ACTIONS.KILL]: '终止进程',
  [ACTIONS.ENV]: '修改宿主环境变量',
  [ACTIONS.INSTALL]: '全局安装软件包',
  [ACTIONS.LISTEN]: '监听物理端口（对外开放）',
  [ACTIONS.EXEC_CODE]: '执行任意代码',
  [ACTIONS.SANDBOX_ESCAPE]: '跳出 OS 沙箱 / 全权执行',
});

// 「破坏性」的人类语义：修改/删除等会改变或销毁既有状态的动作。用于把
// isDestructive 这个布尔翻译成小白能懂的话。
const DESTRUCTIVE_SUMMARY = '会修改或删除既有数据，属破坏性操作';

/**
 * 这一条意图是否落在 L2 红线上。**委托** resourceClassifier.classify，绝不另立判据。
 * @param {object} intent  buildIntent() 产出的规约意图
 * @returns {boolean}
 */
function isRedLine(intent) {
  try {
    return classify(intent).level === LEVELS.L2;
  } catch {
    return true; // fail-closed：判定失败按红线处理
  }
}

/**
 * 用一句话解释「为什么是/不是红线」，面向小白。
 * @param {object} intent
 * @returns {{ isRedLine:boolean, level:string, summary:string, reasons:string[] }}
 */
function describe(intent) {
  let level = LEVELS.L2;
  let reasons = [];
  try {
    const r = classify(intent);
    level = r.level;
    reasons = Array.isArray(r.reasons) ? r.reasons.slice() : [];
  } catch {
    reasons = ['分级判定异常，保守按红线处理'];
  }
  const red = level === LEVELS.L2;

  let summary;
  if (red) {
    const action = intent && intent.action;
    if (RED_LINE_ACTION_LABELS[action]) summary = `红线操作：${RED_LINE_ACTION_LABELS[action]}`;
    else if (intent && intent.isDestructive === true) summary = `红线操作：${DESTRUCTIVE_SUMMARY}`;
    else summary = '红线操作：高危 / 不可逆，需明确确认';
  } else if (level === LEVELS.L1) {
    summary = '有限影响：可逆的写入 / 网络 / 进程操作，确认一次即可';
  } else {
    summary = '只读 / 低风险：不改变任何状态，默认放行';
  }

  return { isRedLine: red, level, summary, reasons };
}

module.exports = {
  RED_LINE_ACTION_LABELS,
  DESTRUCTIVE_SUMMARY,
  isRedLine,
  describe,
  LEVELS,
};
