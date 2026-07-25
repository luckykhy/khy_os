'use strict';

/**
 * planModeSink.js — 零依赖 provider 接收槽，承载「计划只读」状态标志。
 *
 * 解耦依据（[DESIGN-ARCH-051] §6.11）：toolCalling 在每次工具执行前要查一次
 * “当前是否处于计划只读窗口”（EnterPlanMode 已声明、尚未批准），历史上它直接
 * 惰性 require planModeService 调 isPlanReadOnly()。这条单向只读查询边把整条
 * 计划链（planModeService / goalModeService）拽进巨型依赖 SCC，因为
 * planModeService 自身又回指 goalModeService，闭环成圈。
 *
 * 这里用叶子把方向倒置：planModeService 在加载时把自己的 isPlanReadOnly
 * 读取器登记到本叶子，toolCalling 改为穿过叶子读，而不再 import 计划服务。
 * 叶子零依赖、永不入环，于是这次读取不再把 toolCalling 绑死在计划链上。
 *
 * 语义逐字保持：该读取本就是尽力而为、非关键。未登记 provider 时（计划服务
 * 尚未加载）读取得 false —— 与“无活动计划、非只读窗口”完全同义。而计划只读
 * 状态只可能在 EnterPlanModeTool/ExitPlanModeTool（经 tools 扫描表急加载、
 * 必先 require planModeService）跑过之后才为真，故标志可能为真时 provider
 * 必已登记，绝不会把真实的只读窗口误读成 false（无静默回归）。
 *
 * 注意：本文件刻意不在任何位置（含注释）书写模块装载调用样式，以免架构债扫描器
 * 把它误判成依赖边（扫描器按 token 匹配、不剔注释——幽灵边会把叶子重新拖回环里）。
 */

/** @type {null | (() => boolean)} */
let _provider = null;

// per-turn 覆盖:CC 对齐计划模式(KHY_PLAN_CC_RESEARCH)让计划提交改走真·工具循环,而非
// 单次 enterPlanMode。循环跑的那一轮里,planModeService._state 仍是 idle(没走 enterPlanMode),
// provider() 读不到只读窗口。bridge 在计划轮开始把本标志置真、finally 清零,使 toolCalling
// 的只读闸在这一轮照样生效(只读窗口 = provider() 或 本标志)。默认 false,不影响任何非计划轮。
let _turnReadOnly = false;

/**
 * 登记“计划只读”状态读取器。传入非函数即清空。
 * @param {() => boolean} fn
 */
function setPlanReadOnlyProvider(fn) {
  _provider = typeof fn === 'function' ? fn : null;
}

/**
 * per-turn 只读窗口开关(CC 对齐计划模式:循环驱动的计划轮)。bridge 在计划轮开始置真、finally 清零。
 * @param {boolean} on
 */
function setTurnReadOnly(on) {
  _turnReadOnly = on === true;
}

/**
 * 穿过已登记 provider 读取当前“计划只读”标志。
 * 未登记或 provider 抛错时返回 false，调用方按“无活动计划、非只读窗口”处理。
 * @returns {boolean}
 */
function isPlanReadOnly() {
  if (_turnReadOnly) return true;
  if (!_provider) return false;
  try {
    return _provider() === true;
  } catch {
    return false;
  }
}

module.exports = { setPlanReadOnlyProvider, setTurnReadOnly, isPlanReadOnly };
