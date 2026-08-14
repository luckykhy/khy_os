'use strict';

/**
 * toolUseLoopCourse.test.js — 开发过程在途纠偏接进 runToolUseLoop 的安全/契约集成。
 *
 * goal(2026-06-25):开发过程主动监听,跑偏前提示修正航向。轨迹状态(_courseState)是
 * loop 局部、不可外部 seed,故漂移逻辑由 devCourseMonitor 单测覆盖;这里只守两条接缝安全:
 *   1. 干净非动作回合(无编辑/无测试)→ 不跑偏 → 返回对象不挂 courseCorrections(零噪音)。
 *   2. 接缝不破坏正常 loop(成功路径照常返回 finalResponse)。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const toolUseLoop = require('../../src/services/toolUseLoop');

const NON_ACTION_PROMPT = '你是什么模型';

describe('toolUseLoop — 开发过程在途纠偏返回契约', () => {
  let _savedGate;
  beforeEach(() => {
    _savedGate = process.env.KHY_TASK_CAPABILITY_GATE;
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
  });
  afterEach(() => {
    if (_savedGate === undefined) delete process.env.KHY_TASK_CAPABILITY_GATE;
    else process.env.KHY_TASK_CAPABILITY_GATE = _savedGate;
  });

  test('干净回合 → 不跑偏,返回对象不挂 courseCorrections', async () => {
    const chat = async () => ({ reply: '我是测试模型。', stopReason: 'stop', provider: 'mock' });
    const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, { chat, maxIterations: 4 });
    assert.ok(result.finalResponse, '正常返回 finalResponse');
    assert.equal(result.courseCorrections, undefined, '无漂移不应挂 courseCorrections');
  });

  test('KHY_DEV_COURSE_MONITOR=off → 接缝不激活,正常返回', async () => {
    const saved = process.env.KHY_DEV_COURSE_MONITOR;
    process.env.KHY_DEV_COURSE_MONITOR = 'off';
    try {
      const chat = async () => ({ reply: '我是测试模型。', stopReason: 'stop', provider: 'mock' });
      const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, { chat, maxIterations: 4 });
      assert.ok(result.finalResponse);
      assert.equal(result.courseCorrections, undefined);
    } finally {
      if (saved === undefined) delete process.env.KHY_DEV_COURSE_MONITOR;
      else process.env.KHY_DEV_COURSE_MONITOR = saved;
    }
  });
});
