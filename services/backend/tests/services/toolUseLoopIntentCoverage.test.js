'use strict';

/**
 * toolUseLoopIntentCoverage.test.js — 钉死「答得没接住意图」收尾回核接缝。
 *
 * goal(2026-06-25):用户选定的方向是「答得没接住意图」。runToolUseLoop 收尾时
 * 应回核最终回复是否接住了用户逐字点名的高精度诉求(此处:一个被点名却在长篇
 * 结论性回复里只字未提的文件名),漏接则一次性精确补全提示并再跑一轮;补齐后收尾。
 * KHY_INTENT_COVERAGE=0 时整条回核关闭,行为回退。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const toolUseLoop = require('../../src/services/toolUseLoop');

// 一段长(>400 非空白字符)、明显结论性、但**完全不提** zzz_special_module.js 的回复,
// 用以越过 concludeNow 短路与 summaryAssist,直抵意图回核分支。
const LONG_DONE_REPLY = (
  '我已经完成了登录功能的修复并且做了完整验证。'
  + '整个登录流程现在都能正常工作了，会话保持也没有问题，'
  + '相关的边界情况都已经处理妥当，错误提示也更清晰了。'
  + '我反复检查了校验逻辑、状态保持以及异常分支，确认行为符合预期。'
  + '总结:登录修复已全部完成，功能验证通过，可以放心使用了。'
).repeat(2);

describe('toolUseLoop — 意图接住回核(漏接被点名文件 → 追问一次)', () => {
  let _savedGate; let _savedNudge; let _savedCov;
  beforeEach(() => {
    _savedGate = process.env.KHY_TASK_CAPABILITY_GATE;
    _savedNudge = process.env.KHY_HARNESS_NUDGES;
    _savedCov = process.env.KHY_INTENT_COVERAGE;
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_HARNESS_NUDGES = 'true';
    delete process.env.KHY_INTENT_COVERAGE;
  });
  afterEach(() => {
    const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore('KHY_TASK_CAPABILITY_GATE', _savedGate);
    restore('KHY_HARNESS_NUDGES', _savedNudge);
    restore('KHY_INTENT_COVERAGE', _savedCov);
  });

  test('被点名的文件在回复里彻底沉默 → 注入一次性补全提示再跑一轮', async () => {
    const msgs = [];
    let call = 0;
    const chat = async (message) => {
      msgs.push(message);
      call += 1;
      if (call === 1) {
        return { reply: LONG_DONE_REPLY, stopReason: 'stop', provider: 'mock' };
      }
      // 第二轮:补齐后给出含文件名的结论 → 收尾。
      return { reply: '已确认 zzz_special_module.js 无需改动，原因已说明。', stopReason: 'stop', provider: 'mock' };
    };

    const res = await toolUseLoop.runToolUseLoop(
      '帮我修复登录，另外确认一下 zzz_special_module.js 这个文件要不要动',
      { chat, maxIterations: 4 },
    );

    assert.ok(msgs.length >= 2, '应至少跑两轮(原始 + 补全提示)');
    // 第二轮的输入应是意图回核补全提示,精确点名缺口文件。
    assert.match(msgs[1], /zzz_special_module\.js/);
    assert.match(msgs[1], /没接住|没提到|SYSTEM/);
    assert.ok(res && typeof res === 'object');
  });

  test('KHY_INTENT_COVERAGE=0 → 回核关闭,长结论性回复一轮收尾', async () => {
    process.env.KHY_INTENT_COVERAGE = '0';
    const msgs = [];
    const chat = async (message) => {
      msgs.push(message);
      return { reply: LONG_DONE_REPLY, stopReason: 'stop', provider: 'mock' };
    };
    await toolUseLoop.runToolUseLoop(
      '帮我修复登录，另外确认一下 zzz_special_module.js 这个文件要不要动',
      { chat, maxIterations: 4 },
    );
    // 关闭时不应因意图回核而追加补全轮(只跑一轮)。
    assert.equal(msgs.length, 1, '回核关闭时应一轮收尾');
  });
});
