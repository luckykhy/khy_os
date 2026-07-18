'use strict';

/**
 * toolUseLoop.unknownExploration.test.js — 放弃前的主动探索,端到端跑真 loop。
 *
 * 锁定核心行为(提升 Khy-os 对未知的鲁棒性):
 *   当一个工具持续失败、loop 即将「诚实放弃」时,系统会**先注入一次主动探索指令**
 *   (列真实工具 / 检索 / 探查环境)再给模型一轮,而不是直接放弃把球踢给用户;
 *   探索有界——一旦预算用尽就回到原降级链,绝不死循环;
 *   未知工具场景下,注入的指令带**真实可用工具清单**,让模型从中重选。
 *
 * 用计数式假 chat + monkeypatch executeTool 驱动真 runToolUseLoop,零网络/进程。
 */

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';

const toolCalling = require('../src/services/toolCalling');
const toolUseLoop = require('../src/services/toolUseLoop');

describe('toolUseLoop — 放弃前的主动探索', () => {
  let _origExecute;
  before(() => { process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS = '1'; });
  after(() => { delete process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS; });
  beforeEach(() => {
    _origExecute = toolCalling.executeTool;
    // 工具始终失败,逼 loop 走向「连续失败 → 放弃」分支。
    toolCalling.executeTool = async () => ({ success: false, error: 'shell_command failed: opaque error' });
  });
  afterEach(() => { toolCalling.executeTool = _origExecute; });

  test('持续失败时,放弃前注入探索指令并再给一轮', async () => {
    const seen = [];
    let calls = 0;
    const chat = async (msg) => {
      seen.push(String(msg));
      calls += 1;
      // 模型每轮变着法子试同一个工具(持续失败);一旦收到探索指令就收口。
      if (/\[SYSTEM:.*(真实可用|web_search|探查本地环境)/s.test(String(msg))) {
        return { reply: '我先查清楚事实,再继续。已了解情况。', stopReason: 'stop', provider: 'mock' };
      }
      return {
        reply: '', stopReason: 'tool_use', provider: 'mock', model: 'deepseek-v4-flash',
        toolUseBlocks: [{ type: 'tool_use', id: 't' + calls, name: 'shell_command', input: { command: 'attempt-' + calls } }],
      };
    };

    const result = await toolUseLoop.runToolUseLoop('帮我处理这个陌生的东西', { chat, maxIterations: 14 });
    assert.ok(seen.some((d) => /\[SYSTEM:/.test(d) && /(真实可用|web_search|探查本地环境)/.test(d)),
      '放弃前必须注入一次主动探索指令,而不是直接放弃');
    assert.ok(calls < 14, 'loop 应在探索后收口,不是耗尽全部迭代');
    assert.ok(typeof result.finalResponse === 'string' && result.finalResponse.length > 0, '给出终态回复');
  });

  test('未知工具:探索指令带真实可用工具清单', async () => {
    let calls = 0;
    let toolListDirective = null;
    // 未知工具错误来自 executeTool 的返回。
    toolCalling.executeTool = async () => ({ success: false, error: 'Unknown tool: frobnicate' });
    const chat = async (msg) => {
      const m = String(msg);
      if (/真实可用/.test(m)) {
        toolListDirective = m;
        return { reply: '明白,我改用清单里的正确工具。', stopReason: 'stop', provider: 'mock' };
      }
      calls += 1;
      return {
        reply: '', stopReason: 'tool_use', provider: 'mock', model: 'deepseek-v4-flash',
        toolUseBlocks: [{ type: 'tool_use', id: 'u' + calls, name: 'frobnicate', input: { n: calls } }],
      };
    };

    await toolUseLoop.runToolUseLoop('用 frobnicate 工具', { chat, maxIterations: 14 });
    assert.ok(toolListDirective, '未知工具应触发列出真实可用工具清单');
    // 指令里应出现真实注册的内置工具名(而不是模型编造的 frobnicate)
    assert.match(toolListDirective, /apply_patch|AskUserQuestion|Config|Agent|createTool/);
    // 编造的工具名不应作为「可用工具」列表项出现(整条消息的错误上下文里可含 frobnicate,这里只查清单项)
    assert.doesNotMatch(toolListDirective, /^- frobnicate/m);
  });

  test('探索可关闭:KHY_UNKNOWN_EXPLORATION=0 时回到原放弃链', async () => {
    process.env.KHY_UNKNOWN_EXPLORATION = '0';
    try {
      const seen = [];
      let calls = 0;
      const chat = async (msg) => {
        seen.push(String(msg));
        calls += 1;
        if (calls > 10) return { reply: '尽力了。', stopReason: 'stop', provider: 'mock' };
        return {
          reply: '', stopReason: 'tool_use', provider: 'mock', model: 'deepseek-v4-flash',
          toolUseBlocks: [{ type: 'tool_use', id: 'z' + calls, name: 'shell_command', input: { command: 'x' + calls } }],
        };
      };
      const result = await toolUseLoop.runToolUseLoop('做点什么', { chat, maxIterations: 12 });
      assert.ok(!seen.some((d) => /真实可用|探查本地环境/.test(d)),
        '关闭开关后不应注入探索指令');
      assert.ok(typeof result.finalResponse === 'string', '仍给出终态回复(原放弃链)');
    } finally {
      delete process.env.KHY_UNKNOWN_EXPLORATION;
    }
  });
});
