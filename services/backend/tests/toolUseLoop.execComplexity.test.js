'use strict';

/**
 * toolUseLoop.execComplexity.test.js — 执行中复杂度升级的**接线**回归。
 *
 * executionComplexitySignals.test.js 只覆盖叶子的打分/门控/文案;本件覆盖真正有风险
 * 的那一半:叶子有没有被 runToolUseLoop 真的调用、指令有没有真的进到下一轮的输入里。
 *
 * 背景:复杂度此前只在开工前按用户措辞打一次分,「重构登录模块」这类简短表述的真实
 * 复杂任务判为 simple,拿不到 <execution_plan> 注入,跑几十轮后失焦。本机制按执行证据
 * (已改文件数/跨目录数/已用轮次/连续失败)复核规模,越线一次性补计划 + 登记任务板。
 *
 * 驱动真实 runToolUseLoop + 计数假 chat + monkeypatch executeTool。零网络、零进程。
 */

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';

const toolCalling = require('../src/services/toolCalling');
const toolUseLoop = require('../src/services/toolUseLoop');

// 三个文件、三个目录 → 叶子打分 files+2 / dirs+2 = 4,正好越过默认阈值 4。
// 用**真实存在且可解析**的路径:executeTool 已被替身,不会真写盘,但循环里的语法
// 验证门会去 require 这些路径——指向不存在的文件会让它反复要求修复而空转。
const SPREAD_CALLS = [
  { type: 'tool_use', id: 'e1', name: 'write_file', input: { path: 'src/services/taskComplexity.js', content: 'x' } },
  { type: 'tool_use', id: 'e2', name: 'write_file', input: { path: 'src/cli/router.js', content: 'x' } },
  { type: 'tool_use', id: 'e3', name: 'write_file', input: { path: 'src/utils/logger.js', content: 'x' } },
];

// 单文件 → 打分 0,不该越线。
const NARROW_CALLS = [
  { type: 'tool_use', id: 'n1', name: 'write_file', input: { path: 'src/services/taskComplexity.js', content: 'x' } },
];

const DIRECTIVE_RE = /规模复核/;

describe('toolUseLoop — 执行中复杂度升级(措辞判简单、事实判复杂)', () => {
  let _origExecute;

  before(() => {
    process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS = '1';
  });
  after(() => {
    delete process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS;
    delete process.env.KHY_EXEC_COMPLEXITY_ESCALATION;
  });
  beforeEach(() => {
    _origExecute = toolCalling.executeTool;
    toolCalling.executeTool = async () => ({ success: true, output: 'ok' });
  });
  afterEach(() => {
    toolCalling.executeTool = _origExecute;
  });

  /**
   * 跑一轮:第 1 次 chat 发工具调用,之后收尾。返回每次 chat 收到的消息文本。
   * @param {Array<object>} blocks - 第 1 轮返回的 tool_use 块
   */
  async function runWith(blocks) {
    const seen = [];
    let calls = 0;
    const chat = async (msg, _opts = {}) => {
      seen.push(String(msg || ''));
      calls += 1;
      if (calls === 1) {
        return {
          reply: '',
          stopReason: 'tool_use',
          provider: 'mock',
          model: 'deepseek-v4-flash',
          toolUseBlocks: blocks,
        };
      }
      return { reply: '三处改动已完成，行为保持不变。', stopReason: 'stop', provider: 'mock' };
    };
    await toolUseLoop.runToolUseLoop('把错误处理统一成一套', { chat, maxIterations: 3 });
    return seen;
  }

  test('跨目录多文件改动 → 下一轮输入里带上补计划指令', async () => {
    const seen = await runWith(SPREAD_CALLS);
    assert.ok(seen.length >= 2, '应至少发生两次 chat(工具轮 + 续接轮)');
    const injected = seen.slice(1).join('\n');
    assert.match(injected, DIRECTIVE_RE, '越线后续接轮输入必须带「规模复核」指令');
    assert.match(injected, /<execution_plan>/, '指令要求摆计划');
    assert.match(injected, /TaskCreate/, '指令要求登记任务板');
    assert.match(injected, /已改动 3 个文件/, '指令要带具体证据(状态透明红线)');
  });

  test('单文件改动 → 不注入(零上下文开销)', async () => {
    const seen = await runWith(NARROW_CALLS);
    assert.doesNotMatch(seen.join('\n'), DIRECTIVE_RE, '未越线不得注入');
  });

  test('门控关闭 → 不注入', async () => {
    process.env.KHY_EXEC_COMPLEXITY_ESCALATION = '0';
    try {
      const seen = await runWith(SPREAD_CALLS);
      assert.doesNotMatch(seen.join('\n'), DIRECTIVE_RE, '门控关闭时必须完全静默');
    } finally {
      delete process.env.KHY_EXEC_COMPLEXITY_ESCALATION;
    }
  });
});
