'use strict';

/**
 * proactiveTogglePlan.js — `/proactive`(主动 idle-tick 模式开关)的零 IO 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;当前是否激活、env 全经入参注入,本叶子绝不读
 * process.env、绝不触文件、绝不计时、绝不调 Date、绝不持有状态。真正的 activate/deactivate(有定时器
 * 副作用)与状态读取都在薄壳 handlers/proactive.js,委托既有 assistant/index.js 的 wired 激活路径
 * (绝不另起炉灶,绝不裸起一个没有 tick 消费者的空定时器)。本叶子只做:语法解析 + 由「当前态 + 动作」
 * 推导期望态 + 把状态/结果渲染成文本。
 *
 * 背后的逻辑(对齐 Claude Code /proactive):CC 的 /proactive 是一个**开关** ——「Toggle proactive
 * (autonomous tick-driven) mode」:已开则关、未开则开。khy 早已**真有**这一层(assistant/proactive.js 的
 * activate/deactivate/isProactiveActive,且 assistant/index.js:119 已把 onTick 接到真实消费者 ——
 * dream-check 触发的记忆整理),只是从无一个 `/proactive` 入口去切换它。本叶子把**纯确定性**那块(语法 +
 * 期望态推导 + 文本渲染)收敛成单一真源。
 *
 * 诚实边界(刻意不编造 khy 没有的语义):CC 的 tick 是给**模型**注入 `<tick>` 提示让其自主工作(SleepTool
 * 控速);khy 的 tick 消费者是**记忆 dream 整理**(后台合并),不是自主模型回合。故开启文案如实描述 khy
 * 的真实机制,绝不假称「模型会在 tick 间自主干活」。也不在此叶子伪造任何 model-loop 注入。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器把它当成幽灵依赖边。本叶子零依赖。
 */

const _ON_WORDS = new Set(['on', 'enable', 'start', 'activate', 'open', '开', '开启', '启用']);
const _OFF_WORDS = new Set(['off', 'disable', 'stop', 'deactivate', 'close', '关', '关闭', '停用']);
const _TOGGLE_WORDS = new Set(['toggle', '切换']);
const _STATUS_WORDS = new Set(['status', 'state', 'stat', '状态', '查看']);
const _HELP_WORDS = new Set(['help', '-h', '--help', '帮助', '用法']);

/**
 * 解析 `/proactive [on|off|toggle|status|help]`。空参 = toggle(对齐 CC immediate 切换)。
 * @param {string[]} args
 * @returns {{action:'toggle'|'on'|'off'|'status'|'help', valid:boolean, parseError:(string|null)}}
 */
function parseProactiveArgs(args) {
  const list = Array.isArray(args) ? args : [];
  const first = list.length > 0 ? String(list[0] == null ? '' : list[0]).trim().toLowerCase() : '';

  if (first === '') return { action: 'toggle', valid: true, parseError: null };
  if (_HELP_WORDS.has(first)) return { action: 'help', valid: true, parseError: null };
  if (_ON_WORDS.has(first)) return { action: 'on', valid: true, parseError: null };
  if (_OFF_WORDS.has(first)) return { action: 'off', valid: true, parseError: null };
  if (_TOGGLE_WORDS.has(first)) return { action: 'toggle', valid: true, parseError: null };
  if (_STATUS_WORDS.has(first)) return { action: 'status', valid: true, parseError: null };

  return { action: 'status', valid: false, parseError: 'unknown_action' };
}

/**
 * 由「当前是否激活」+「动作」推导期望态。纯函数,无副作用。
 * @param {boolean} currentActive
 * @param {'toggle'|'on'|'off'|'status'|'help'} action
 * @returns {{desired:(boolean|null), changes:boolean}}
 *   desired=null 表示纯查看(status/help,不改状态);changes=false 表示期望态与当前态相同(no-op)。
 */
function resolveToggle(currentActive, action) {
  const cur = currentActive === true;
  if (action === 'status' || action === 'help') return { desired: null, changes: false };
  let desired;
  if (action === 'on') desired = true;
  else if (action === 'off') desired = false;
  else desired = !cur; // toggle
  return { desired, changes: desired !== cur };
}

/**
 * 渲染状态文本。snapshot 缺面诚实留白,绝不编造。
 * @param {object} snapshot - { proactive, assistantMode, dreamNeeded, dreamReason, lastDream }
 * @returns {string}
 */
function buildStatusText(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const active = s.proactive === true;
  const lines = [];
  lines.push('🌀 Proactive idle-tick 模式');
  lines.push(`  当前: ${active ? '已开启 ✓' : '已关闭'}`);
  if (typeof s.assistantMode === 'boolean') {
    lines.push(`  助手模式: ${s.assistantMode ? '激活' : '未激活'}`);
  }
  // khy 的 tick 消费者 = 记忆 dream 整理(诚实描述真实机制)。
  if (typeof s.dreamNeeded === 'boolean') {
    lines.push(`  记忆整理(dream): ${s.dreamNeeded ? '待触发' : '暂不需要'}${s.dreamReason ? `(${s.dreamReason})` : ''}`);
  }
  if (s.lastDream) {
    lines.push(`  上次整理: ${s.lastDream}`);
  }
  lines.push('  机制: 开启后后台周期性 idle-tick 驱动记忆 dream 整理(非自主模型回合)。');
  return lines.join('\n');
}

/**
 * 渲染切换结果文本。
 * @param {boolean} desired - 期望态(true=开)
 * @param {boolean} changed - 是否真的发生了变化(false=已是该态的 no-op)
 * @returns {string}
 */
function buildToggleResult(desired, changed) {
  if (desired) {
    return changed
      ? '✓ Proactive idle-tick 模式已开启 —— 后台将周期性触发记忆 dream 整理。'
      : 'ℹ Proactive idle-tick 模式本就已开启(无变化)。';
  }
  return changed
    ? '✓ Proactive idle-tick 模式已关闭。'
    : 'ℹ Proactive idle-tick 模式本就已关闭(无变化)。';
}

function buildHelpText() {
  return [
    '/proactive —— 主动 idle-tick 模式开关(对齐 Claude Code /proactive)',
    '  用法:',
    '    /proactive            切换开/关(默认)',
    '    /proactive on         开启',
    '    /proactive off        关闭',
    '    /proactive toggle     切换',
    '    /proactive status     仅查看当前状态',
    '  说明: 开启后后台周期性 idle-tick 驱动记忆 dream 整理(khy 的真实 tick 消费者,非自主模型回合)。',
  ].join('\n');
}

/**
 * 门控 KHY_PROACTIVE_COMMAND(默认开;关时薄壳字节回退为「不接管」)。
 * @param {object} env
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || {};
  const raw = e.KHY_PROACTIVE_COMMAND === undefined ? 'true' : e.KHY_PROACTIVE_COMMAND;
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'off' || s === 'no');
}

module.exports = {
  parseProactiveArgs,
  resolveToggle,
  buildStatusText,
  buildToggleResult,
  buildHelpText,
  isEnabled,
};
