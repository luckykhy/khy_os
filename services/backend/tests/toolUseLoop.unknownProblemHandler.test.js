'use strict';

/**
 * toolUseLoop.unknownProblemHandler.test.js — execution-chain wiring for the
 * Unknown-Problem Handler state machine (DESIGN-ARCH-043).
 *
 * Pins the CODE half of the double-constraint that makes the agent unable to
 * skip 信息请求 and jump straight to 执行:
 *   1. Flag ON  + reply carries 🔍 未知点识别 + a tool call → the tool call is
 *      CLEARED, the loop concludes, and control returns to the user (the tool
 *      never runs, no second model turn driven by a tool result).
 *   2. Flag OFF → zero behavior change: the same reply's tool call executes and
 *      a second model turn happens (legacy behavior).
 *   3. Flag ON, no info-request structure → a normal tool call still executes
 *      (the gate is structure-scoped, not a blanket block).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-uph-loop-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
// Hermetic gates so the funnel runs registered tools without prompts/stores.
process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';
process.env.KHY_METACONSTRAINT = 'off';
process.env.KHY_SYSCALL_GATEWAY = 'off';
process.env.KHY_PERMISSION_STORE = 'false';

const { describe, test, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');

const toolUseLoop = require('../src/services/toolUseLoop');
const registry = require('../src/tools');

const FLAG = 'KHY_UNKNOWN_PROBLEM_HANDLER';

let probeCalls = 0;
before(() => {
  registry.register({
    name: 'uphProbeTool',
    description: 'fake read-only probe tool for the UPH gate test',
    risk: 'low',
    isReadOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => { probeCalls += 1; return { success: true, output: 'probe-ran' }; },
  });
});

const INFO_REPLY = [
  '🔍 **未知点识别**',
  '- 目标平台未指定',
  '',
  '❓ **确认信息**',
  '1. 目标是 Linux 还是 Windows？若不回答，默认按【Linux】处理',
].join('\n');

function makeChat(captured, firstReply) {
  let calls = 0;
  return async (message) => {
    calls += 1;
    captured.calls = calls;
    if (calls === 1) {
      return {
        reply: firstReply,
        toolUseBlocks: [{ type: 'tool_use', id: 'p1', name: 'uphProbeTool', input: {} }],
        stopReason: 'tool_use',
        provider: 'mock',
      };
    }
    captured.secondMessage = message;
    return { reply: 'concluded', stopReason: 'stop', provider: 'mock' };
  };
}

describe('Unknown-Problem Handler execution-chain gate', () => {
  afterEach(() => { delete process.env[FLAG]; probeCalls = 0; });

  test('flag on + 🔍 info-request: tool call is cleared, control returns to user', async () => {
    process.env[FLAG] = 'on';
    const captured = {};
    const result = await toolUseLoop.runToolUseLoop('帮我把项目部署一下', {
      chat: makeChat(captured, INFO_REPLY),
      maxIterations: 4,
      sessionId: 'uph-on',
      requestId: 'uph-on',
    });
    assert.equal(probeCalls, 0, 'info-request must block tool execution');
    assert.equal(captured.calls, 1, 'no second model turn (no tool result fed back)');
    assert.equal(captured.secondMessage, undefined);
    assert.match(result.finalResponse, /🔍 \*\*未知点识别\*\*/, 'questions returned to user');
  });

  test('flag off: same reply executes the tool (zero behavior change)', async () => {
    delete process.env[FLAG];
    const captured = {};
    await toolUseLoop.runToolUseLoop('帮我把项目部署一下', {
      chat: makeChat(captured, INFO_REPLY),
      maxIterations: 4,
      sessionId: 'uph-off',
      requestId: 'uph-off',
    });
    assert.equal(probeCalls, 1, 'tool must run when handler is off');
    assert.ok(captured.secondMessage, 'tool result drives a second model turn');
  });

  test('flag on, no info-request structure: a normal tool call still executes', async () => {
    process.env[FLAG] = 'on';
    const captured = {};
    await toolUseLoop.runToolUseLoop('帮我把项目部署一下', {
      chat: makeChat(captured, '我现在开始检查环境。'),
      maxIterations: 4,
      sessionId: 'uph-normal',
      requestId: 'uph-normal',
    });
    assert.equal(probeCalls, 1, 'gate is structure-scoped, must not block normal tool calls');
    assert.ok(captured.secondMessage, 'normal tool call drives a second model turn');
  });
});
