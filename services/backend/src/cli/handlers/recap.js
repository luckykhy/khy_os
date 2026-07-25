'use strict';

/**
 * recap.js — `/recap` 命令薄壳:回顾当前会话「发生了什么」。对齐 Claude Code `/recap`
 * (CC 用一次 forked 单轮模型查询生成「离开期间」回顾)。
 *
 * **背后逻辑**(主题/决策/改动文件/命令/未决问题/洞见的抽取 + 渲染)全在既有 SSOT
 * `services/sessionRecapService.js`(`generateRecap` 确定性、零模型零网络;`formatRecap`
 * 渲染);本薄壳绝不另起炉灶,只做:门控、解析当前 sessionId(既有
 * `sessionForestService.getCurrentSessionId`)、读 chain(既有
 * `sessionPersistence.buildConversationChain`)、调用服务并打印。
 *
 * **诚实差异**:CC 的 /recap 是「离开期间」的模型生成回顾;khy 无「away 边界」追踪,故对
 * **整段当前会话**做**确定性**回顾(无模型也可用)。这与 turn-end consolidate 复用同一
 * `generateRecap` 底座;若环境有模型,本命令仍走确定性底座(模型升级只发生在后台
 * consolidate 路径,/recap 永远即时、离线、可复现,绝不阻塞等模型)。
 *
 * 门控 KHY_RECAP 默认开;关 → 命令不接管(返回 false 字节回退到既有路由兜底)。
 */

const { printInfo, printError } = require('../formatters');

function _recapEnabled(env) {
  const raw = env && env.KHY_RECAP;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

async function handleRecap(_subCommand, _args = [], _options = {}) {
  if (!_recapEnabled(process.env)) {
    printInfo('recap 命令未启用(KHY_RECAP=off)。');
    return false;
  }

  let sessionId = null;
  try {
    sessionId = require('../../services/session/sessionForestService').getCurrentSessionId();
  } catch { /* best-effort */ }
  if (!sessionId) {
    printInfo('暂无活动会话 —— 先开始一段对话,再用 /recap 回顾本次会话。');
    return true;
  }

  let messages = [];
  try {
    messages = require('../../services/sessionPersistence').buildConversationChain(sessionId);
  } catch (e) {
    printError('读取会话 transcript 失败:' + (e && e.message ? e.message : String(e)));
    return true;
  }

  let recap;
  try {
    recap = require('../../services/sessionRecapService').generateRecap(messages);
  } catch (e) {
    printError('生成会话回顾失败:' + (e && e.message ? e.message : String(e)));
    return true;
  }

  // 空会话:generateRecap 返回 { turns:0, sections:{} },直接走 formatRecap 会因
  // sections.topics 缺失而抛 —— 诚实降级为只打印 summary。
  if (!recap || !recap.sections || typeof recap.sections.topics === 'undefined') {
    printInfo('  ' + ((recap && recap.summary) || 'Empty conversation.'));
    return true;
  }

  let chalk = null;
  try { chalk = require('chalk'); } catch { /* 无 chalk → formatRecap 用恒等回退 */ }

  try {
    console.log(require('../../services/sessionRecapService').formatRecap(recap, chalk ? { chalk } : {}));
  } catch (e) {
    printError('渲染会话回顾失败:' + (e && e.message ? e.message : String(e)));
    return true;
  }
  return true;
}

module.exports = { handleRecap };
