'use strict';

/**
 * GoalTool — 让模型自己设定 / 查看 / 清除「持久目标」(对齐 Claude Code 的 GoalTool)。
 *
 * 持久目标设定后会被每轮注入系统提示词(单一真源 goalCore,持久化 goalStore,门控 KHY_GOAL),
 * 让模型把它当作一条持续指令朝其推进,直到达成后调用本工具 action=clear 清除。
 *
 * 纯 IO 委派:全部逻辑在 goalCore/goalStore;本工具只把模型意图翻译成存取调用。
 */

const { defineTool } = require('./_baseTool');

module.exports = defineTool({
  name: 'GoalTool',
  description:
    'Manage the persistent goal (Claude Code-aligned /goal). Set a standing goal the assistant keeps '
    + 'working toward every turn until cleared, check the current goal, or clear it once achieved. '
    + 'While a goal is active, khy blocks premature turn-end until the goal looks satisfied (Stop-gate, '
    + 'mirroring Claude Code\'s /goal Stop hook) and auto-clears once done. '
    + 'Call with action=clear when you are confident the goal is fully accomplished.',
  category: 'system',
  risk: 'low',
  aliases: ['goal', 'Goal'],
  // status 只读;set/clear 写持久状态(非破坏,可逆)
  isReadOnly: (input) => String((input && input.action) || 'status').toLowerCase() === 'status',
  isConcurrencySafe: false,
  inputSchema: {
    action: {
      type: 'string',
      required: false,
      enum: ['set', 'clear', 'status'],
      description: 'set a new persistent goal, clear the active goal, or report the current goal (default: status).',
    },
    goal: {
      type: 'string',
      required: false,
      description: 'The goal text (required when action=set).',
    },
    global: {
      type: 'boolean',
      required: false,
      description: 'When setting, make it a global goal (not bound to the current project directory).',
    },
    maxTurns: {
      type: 'number',
      required: false,
      description: 'Optional turn budget when action=set (bounded terminal state). '
        + 'The goal auto-retires (terminalStatus=exhausted) after this many user turns. Default 25.',
    },
  },
  async execute(params, context) {
    const store = require('../services/goalStore');
    const core = require('../services/goalCore');
    const action = String((params && params.action) || 'status').toLowerCase();
    const cwd = (context && context.cwd) || process.cwd();
    try {
      if (action === 'set') {
        const text = (params && params.goal) || '';
        if (!String(text).trim()) return { success: false, error: 'action=set requires a non-empty "goal".' };
        const res = store.setGoal(text, {
          cwd,
          global: Boolean(params && params.global),
          maxTurns: params && params.maxTurns,
        });
        if (!res.ok) return { success: false, error: res.error || 'failed to set goal' };
        return {
          success: true,
          data: {
            action: 'set',
            goal: res.goal.text,
            scope: params && params.global ? 'global' : 'project',
            maxTurns: res.goal.maxTurns,
            note: `已设定持久目标(有界:最多 ${res.goal.maxTurns} 轮),每轮都会提醒朝它推进并朝有限交付物收敛;`
              + '达成即调用 GoalTool(action=clear),或达上限自动进入终止态。',
          },
        };
      }
      if (action === 'clear') {
        // 模型自认目标已达成 → 记 done(与用户主动 abandoned 区分)。
        const res = store.clearGoal({ cwd, reason: 'done' });
        if (!res.ok) return { success: false, error: res.error || 'failed to clear goal' };
        return {
          success: true,
          data: { action: 'clear', cleared: res.cleared, note: res.cleared ? '持久目标已清除。' : '当前没有活动目标。' },
        };
      }
      // status (default)
      const goal = store.getActiveGoal(cwd);
      return {
        success: true,
        data: goal
          ? {
            action: 'status',
            active: true,
            goal: goal.text,
            scope: goal.scope,
            createdAt: goal.createdAt,
            maxTurns: core.resolveMaxTurns(undefined, goal.maxTurns),
            turnsSpent: Number(goal.turnsSpent) || 0,
            remaining: core.remainingTurns(goal),
          }
          : { action: 'status', active: false, note: '当前没有活动的持久目标。' },
      };
    } catch (err) {
      return { success: false, error: (err && err.message) || String(err) };
    }
  },
});
