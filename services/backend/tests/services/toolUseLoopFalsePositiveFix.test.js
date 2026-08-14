'use strict';

/**
 * toolUseLoopFalsePositiveFix.test.js — 复现先行守卫接进 runToolUseLoop 的安全/契约集成。
 *
 * goal(2026-06-25):防小模型误判 bug 把正确代码改坏。守卫状态(_fpfState)是 loop 局部、
 * 不可外部 seed,phantom/覆盖/漂移裁决逻辑由 falsePositiveFixGuard 单测全矩阵覆盖;这里只守
 * 三条接缝安全:
 *   1. 干净非动作回合(无编辑/无测试)→ 不浮告诫 → 返回对象不挂 falsePositiveFix(零噪音)。
 *   2. 主闸 off → 接缝完全惰性,不建状态、不挂 _fpfState、正常返回 finalResponse。
 *   3. 接缝不破坏正常 loop(成功路径照常返回 finalResponse);开启时 _fpfState 透传供 harness 收口。
 *
 * 纯叶子主脑用 node:test;此处亦用 node:test(由 test:node 自动发现)。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const toolUseLoop = require('../../src/services/toolUseLoop');

const NON_ACTION_PROMPT = '你是什么模型';

describe('toolUseLoop — 复现先行守卫返回契约', () => {
  let _savedGate;
  beforeEach(() => {
    _savedGate = process.env.KHY_TASK_CAPABILITY_GATE;
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
  });
  afterEach(() => {
    if (_savedGate === undefined) delete process.env.KHY_TASK_CAPABILITY_GATE;
    else process.env.KHY_TASK_CAPABILITY_GATE = _savedGate;
  });

  test('干净回合 → 不浮告诫,返回对象不挂 falsePositiveFix', async () => {
    const chat = async () => ({ reply: '我是测试模型。', stopReason: 'stop', provider: 'mock' });
    const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, { chat, maxIterations: 4 });
    assert.ok(result.finalResponse, '正常返回 finalResponse');
    assert.equal(result.falsePositiveFix, undefined, '无告诫不应挂 falsePositiveFix');
  });

  test('KHY_FALSE_POSITIVE_FIX_GUARD=off → 接缝惰性,不挂 _fpfState', async () => {
    const saved = process.env.KHY_FALSE_POSITIVE_FIX_GUARD;
    process.env.KHY_FALSE_POSITIVE_FIX_GUARD = 'off';
    try {
      const chat = async () => ({ reply: '我是测试模型。', stopReason: 'stop', provider: 'mock' });
      const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, { chat, maxIterations: 4 });
      assert.ok(result.finalResponse);
      assert.equal(result.falsePositiveFix, undefined);
      assert.equal(result._fpfState, undefined, 'off 时不应建/透传守卫状态');
    } finally {
      if (saved === undefined) delete process.env.KHY_FALSE_POSITIVE_FIX_GUARD;
      else process.env.KHY_FALSE_POSITIVE_FIX_GUARD = saved;
    }
  });

  test('守卫开启 → 成功路径正常,_fpfState 透传供 harness 收口', async () => {
    const saved = process.env.KHY_FALSE_POSITIVE_FIX_GUARD;
    process.env.KHY_FALSE_POSITIVE_FIX_GUARD = 'on';
    try {
      const chat = async () => ({ reply: '我是测试模型。', stopReason: 'stop', provider: 'mock' });
      const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, { chat, maxIterations: 4 });
      assert.ok(result.finalResponse);
      // 非 bugfix 意图也会建状态(供 harness 统一收口),但绝不浮出告诫。
      assert.ok(result._fpfState && typeof result._fpfState === 'object', '_fpfState 应透传');
      assert.equal(result._fpfState.bugfixIntent, false, '非 bugfix 意图');
      assert.equal(result.falsePositiveFix, undefined, '零噪音');
    } finally {
      if (saved === undefined) delete process.env.KHY_FALSE_POSITIVE_FIX_GUARD;
      else process.env.KHY_FALSE_POSITIVE_FIX_GUARD = saved;
    }
  });
});
