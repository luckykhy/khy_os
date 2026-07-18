'use strict';

/**
 * Goal Command Handler — `khy goal …`(对齐 Claude Code 的 /goal)。
 *
 * 持久目标:设定后每轮注入系统提示词提醒模型朝它推进,直到清除。判定/规范化/指令在纯叶子
 * goalCore(单一真源);持久化在 goalStore(~/.khyos/goals)。本 handler 只做 IO/打印。
 *
 *   goal [show|status]      — 查看当前项目的活动目标(只读)
 *   goal set <text…>        — 设定持久目标(--global 设为全局目标)
 *   goal clear [--all]      — 清除当前项目活动目标(--all 清全部)
 *   goal list               — 列出所有目标(含历史)
 *   goal endurance [--apply [--session|--goal]]
 *                           — 「连续几天不中断」底气自检(两维度:交互式会话 + 目标 /goal);
 *                             --apply 把一键配置落盘到 khy 的 .env(同 khy goal on),
 *                             --session 仅落交互会话、--goal 仅落目标治理器,默认两者都落。
 *   goal on | off           — 开/关持久目标能力(持久化 KHY_GOAL)
 *
 * @module handlers/goal
 */

const { printInfo, printError, printTable, printSuccess } = require('../formatters');

function _store() { return require('../../services/goalStore'); }
function _core() { return require('../../services/goalCore'); }
function _kickoff() { return require('../../services/goalKickoff'); }
function _endurance() { return require('../../services/goalEndurance'); }

function _persist(value, deps) {
  const writeEnvPatch = (deps && typeof deps.writeEnvPatch === 'function')
    ? deps.writeEnvPatch
    : require('./config')._writeEnvPatch;
  return writeEnvPatch({ KHY_GOAL: value });
}

// 终止态词汇 → 中文短标签(与 goalCore.GOAL_TERMINAL_STATUSES 同族)。
const _TERMINAL_LABEL = { done: '已完成', exhausted: '已到期', abandoned: '已清除' };

function _handleShow() {
  const goal = _store().getActiveGoal(process.cwd());
  if (!goal) {
    printInfo('当前没有活动的持久目标。设定:khy goal set <目标文本>');
    return 0;
  }
  const core = _core();
  const cap = core.resolveMaxTurns(undefined, goal.maxTurns);
  const remaining = core.remainingTurns(goal);
  printInfo('当前持久目标(每轮提醒模型朝它推进并朝有限交付物收敛):');
  printInfo(`  「${goal.text}」`);
  printInfo(`  作用域:${goal.scope === 'global' ? '全局' : '本项目'}${goal.cwd ? ` (${goal.cwd})` : ''}`);
  printInfo(`  轮次预算:还剩 ${remaining} 轮 / 共 ${cap} 轮(耗尽自动进入终止态并产出报告)`);
  if (goal.createdAt) printInfo(`  设定于:${goal.createdAt}`);
  printInfo('清除:khy goal clear（或自然语言「清除目标」）；调整预算:khy goal set <文本> --max-turns N');
  printInfo('想连续跑几天不中断?先跑 khy goal endurance 自检配置。');
  return 0;
}

function _handleSet(args, options) {
  const text = Array.isArray(args) ? args.join(' ').trim() : String(args || '').trim();
  if (!text) {
    printError('用法:khy goal set <目标文本> [--global] [--max-turns N]');
    return 1;
  }
  const maxTurns = (options && (options.maxTurns != null ? options.maxTurns : options['max-turns']));
  const res = _store().setGoal(text, { global: Boolean(options && options.global), maxTurns });
  if (!res.ok) {
    printError(`设定失败:${res.error || '未知错误'}`);
    return 1;
  }
  printSuccess(`✅ 持久目标已设定（${options && options.global ? '全局' : '本项目'}，最多 ${res.goal.maxTurns} 轮）。`);
  printInfo(`  「${res.goal.text}」`);
  // 设定即开跑(对齐 CC /goal:设定后立即执行,不等用户再发消息)。门控 KHY_GOAL_AUTODRIVE
  // 默认开 → 返回 { code, aiForward } 让 REPL/TUI 主循环立刻跑一轮 agentic 朝目标推进;
  // 门控关 → 返回 0(逐字节回退:设定但等用户下一条消息才推进)。
  let kickoff = null;
  try { kickoff = _kickoff().buildGoalKickoffMessage(res.goal, { env: process.env }); } catch { kickoff = null; }
  if (kickoff) {
    printInfo('从现在起,khy 会立即朝它推进并朝有限交付物收敛;达上限或达成自动进入终止态。');
    printInfo('提前清除:khy goal clear 或说「清除目标」。');
    return { code: 0, aiForward: kickoff };
  }
  printInfo('从下一轮起,khy 会每轮提醒模型朝它推进并朝有限交付物收敛;达上限自动进入终止态。');
  printInfo('提前清除:khy goal clear 或说「清除目标」。');
  return 0;
}

function _handleClear(options) {
  const res = _store().clearGoal({ all: Boolean(options && options.all), reason: 'abandoned' });
  if (!res.ok) {
    printError(`清除失败:${res.error || '未知错误'}`);
    return 1;
  }
  if (res.cleared === 0) {
    printInfo('当前没有活动目标可清除。');
    return 0;
  }
  printSuccess(`✅ 已清除 ${res.cleared} 个活动目标。`);
  return 0;
}

function _handleList() {
  const goals = _store().listGoals();
  if (!goals.length) {
    printInfo('还没有任何目标。设定:khy goal set <目标文本>');
    return 0;
  }
  const core = _core();
  const rows = goals.map((g) => {
    let statusCell;
    if (g.active) {
      const remaining = core.remainingTurns(g);
      const cap = core.resolveMaxTurns(undefined, g.maxTurns);
      statusCell = `● 活动 (剩${remaining}/${cap})`;
    } else {
      statusCell = `○ ${_TERMINAL_LABEL[g.terminalStatus] || '历史'}`;
    }
    return [
      statusCell,
      g.scope === 'global' ? '全局' : (g.cwd || g.scope),
      (g.text || '').length > 60 ? `${g.text.slice(0, 57)}...` : g.text,
      g.createdAt || '-',
    ];
  });
  printTable(['状态', '作用域', '目标', '设定于'], rows);
  return 0;
}

/**
 * 「连续几天不中断」底气自检:扫描所有决定目标寿命的开关,判定当前配置能否连续跑约 N 小时
 * (默认 72h ≈「连续几天」),逐条列出阻断项 + 可照抄的 env 修法。判定/文案在纯叶子
 * goalEndurance(单一真源);本处只读活动目标 + 打印。
 * @param {object} [options] - { hours|target } 覆盖评估视界
 * @returns {number}
 */
function _resolveEnduranceScope(options, args) {
  const lc = Array.isArray(args) ? args.map((a) => String(a).toLowerCase()) : [];
  const wantGoal = Boolean(options && options.goal) || lc.includes('goal') || lc.includes('目标');
  const wantSession = Boolean(options && options.session) || lc.includes('session') || lc.includes('会话');
  if (wantGoal && !wantSession) return 'goal';
  if (wantSession && !wantGoal) return 'session';
  return 'all';
}

function _handleEndurance(options, args, deps) {
  const goal = _store().getActiveGoal(process.cwd());
  const end = _endurance();
  const targetHours = options && (options.hours != null ? options.hours : options.target);
  const scope = _resolveEnduranceScope(options, args);
  const applyReq = Boolean(options && (options.apply || options.persist || options.save || options.fix))
    || (Array.isArray(args) && args.some((a) => ['apply', 'persist', 'save', 'fix', '落盘'].includes(String(a).toLowerCase())));
  if (applyReq) return _handleEnduranceApply({ goal, end, targetHours, scope, deps });

  // 只读:两维度都汇报 —— 交互会话(无需目标)在前(更普适),目标(/goal)在后(仅设定目标后适用)。
  const session = end.assessSessionEndurance({ env: process.env, targetHours });
  for (const line of end.buildSessionEnduranceReport(session)) printInfo(line);
  printInfo('');
  const assessment = end.assessGoalEndurance({
    goal, env: process.env, nowMs: Date.now(), targetHours,
  });
  printInfo('—— 目标(/goal)专属治理器(仅设定 /goal 后适用)——');
  for (const line of end.buildEnduranceReport(assessment)) printInfo(line);
  printInfo('');
  printInfo('一键落盘(写入 khy 的 .env,与 khy goal on 同一处,新会话/重启自动生效):');
  printInfo('  khy goal endurance --apply            # 两维度都落盘');
  printInfo('  khy goal endurance --apply --session  # 仅交互会话');
  printInfo('  khy goal endurance --apply --goal     # 仅目标治理器');
  return 0;
}

/**
 * 「底气落盘」:把一键 endurance env 写入 khy 的 .env 配置(SSOT 写入器 config._writeEnvPatch,与 `khy goal on`
 * 同一处;canonical=KHY_ENV_FILE 或 <backend>/.env),使「连续几天不中断」的配置跨会话/重启持久生效。
 * 写后用**合并 env** 复评给出真实 after 判定。
 * 计划/文案在纯叶子 goalEndurance(单一真源);本处只做写入 + 打印。绝不写入任何 key/token。
 * @returns {number}
 */
function _handleEnduranceApply({ goal, end, targetHours, scope = 'all', deps }) {
  const before = end.assessGoalEndurance({ goal, env: process.env, nowMs: Date.now(), targetHours });
  const plan = end.buildEndurancePersistPlan({ env: process.env, scope });
  let envPath;
  try {
    const writeEnvPatch = (deps && typeof deps.writeEnvPatch === 'function')
      ? deps.writeEnvPatch
      : require('./config')._writeEnvPatch;
    envPath = writeEnvPatch(plan.patch);
  } catch (e) {
    printError(`落盘失败:${(e && e.message) || e}`);
    return 1;
  }
  // 用合并 env 复评,after 判定真实(不依赖写入器是否已改动 process.env)。
  const mergedEnv = Object.assign({}, process.env, plan.patch);
  const goalAfter = end.assessGoalEndurance({ goal, env: mergedEnv, nowMs: Date.now(), targetHours });
  const sessionAfter = end.assessSessionEndurance({ env: mergedEnv, targetHours });
  const headline = end.buildEnduranceHeadline({ sessionAfter, goalAfter, scope });
  for (const line of end.buildEndurancePersistReport({ before, after: goalAfter, plan, envPath, headline })) printInfo(line);
  return 0;
}

function _handleToggle(turnOn, deps) {
  const value = turnOn ? 'true' : 'off';
  try {
    const p = _persist(value, deps);
    printSuccess(`✅ 持久目标能力${turnOn ? '已开启' : '已关闭'}（KHY_GOAL=${value}）。已即时生效并持久化。`);
    printInfo(`已写入:${p}`);
    return 0;
  } catch (e) {
    printError(`无法持久化:${(e && e.message) || e}`);
    return 1;
  }
}

/**
 * @param {string} subCommand
 * @param {string[]} args
 * @param {object} options
 * @param {object} [deps] - { writeEnvPatch } 可注入便于测试
 * @returns {number}
 */
function handleGoal(subCommand, args = [], options = {}, deps = {}) {
  const sub = String(subCommand || 'show').toLowerCase();
  const hasFreeform = Array.isArray(args) && args.length > 0;
  if (sub === 'help' || options.help) {
    printInfo('用法: goal [show] | goal set <文本> [--global] [--max-turns N] | goal clear [--all] | goal list | goal endurance [--apply [--session|--goal]] | goal on | goal off');
    return 0;
  }
  // 显式的只读动词(show/status)照旧走只读视图,忽略多余尾参。
  if (subCommand != null && (sub === 'show' || sub === 'status')) return _handleShow();
  if (sub === 'set' || sub === 'add') return _handleSet(args, options);
  if (sub === 'clear' || sub === 'done' || sub === 'reset') return _handleClear(options);
  if (sub === 'list' || sub === 'ls') return _handleList();
  if (sub === 'endurance' || sub === 'stamina' || sub === 'endure') return _handleEndurance(options, args, deps);
  if (sub === 'on') return _handleToggle(true, deps);
  if (sub === 'off') return _handleToggle(false, deps);
  // subCommand 为 null(parser 对 freeform 文本的产物):`/goal`(无参)→ 只读状态;
  // `/goal <目标文本>` → 直设并开跑(对齐 CC 的 freeform 直设,不再丢弃文本)。
  if (subCommand == null) {
    if (!hasFreeform) return _handleShow();
    return _handleSet(args, options);
  }
  // 未知的非空子命令(如直接调用 handleGoal('把今天发布完'))→ 当作 "set <整串>" 便捷写法。
  return _handleSet([subCommand, ...(Array.isArray(args) ? args : [])], options);
}

module.exports = { handleGoal };
