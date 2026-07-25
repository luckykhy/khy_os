'use strict';

/**
 * toolUseLoopSentinel.test.js — Bug 哨兵接进 runToolUseLoop 返回契约的集成。
 *
 * goal(2026-06-25):bug 从被动响应升级为主动监听发现 + 被动兜底。循环里 fail-soft catch
 * 经 tripwire 登记的信号,必须能浮到返回契约顶层(供 UI/health/doctor 主动呈现),而不是
 * 埋在日志里被动等人去翻。
 *
 * 用一个干净成功的 mock chat 驱动真实 loop:
 *   - 预先 seed 一条 tripwire 信号 → 返回对象应带 sentinel 快照(含该 code);
 *   - 无任何信号(reset 后)→ 返回对象不挂 sentinel(被动兜底:无噪音)。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const toolUseLoop = require('../../src/services/toolUseLoop');
const sentinel = require('../../src/services/bugSentinel');

const NON_ACTION_PROMPT = '你是什么模型';

describe('toolUseLoop — Bug 哨兵返回契约', () => {
  let _savedGate;
  beforeEach(() => {
    _savedGate = process.env.KHY_TASK_CAPABILITY_GATE;
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    sentinel.reset();
  });
  afterEach(() => {
    if (_savedGate === undefined) delete process.env.KHY_TASK_CAPABILITY_GATE;
    else process.env.KHY_TASK_CAPABILITY_GATE = _savedGate;
    sentinel.reset();
  });

  test('循环内累积的吞咽信号 → 返回对象顶层带 sentinel 快照', async () => {
    // 模拟循环执行期间某处 fail-soft catch 登记了一条信号。
    sentinel.tripwire(new Error('boom'), { code: 'loop.someOptional' });

    const chat = async () => ({ reply: '我是测试模型。', stopReason: 'stop', provider: 'mock' });
    const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, { chat, maxIterations: 4 });

    assert.ok(result.sentinel, 'result.sentinel 应存在');
    assert.equal(result.sentinel.swallowed >= 1, true);
    assert.equal(result.sentinel.byCode['loop.someOptional'] >= 1, true);
  });

  test('无任何哨兵信号 → 返回对象不挂 sentinel(被动兜底,零噪音)', async () => {
    const chat = async () => ({ reply: '我是测试模型。', stopReason: 'stop', provider: 'mock' });
    const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, { chat, maxIterations: 4 });
    assert.equal(result.sentinel, undefined);
  });
});
