'use strict';

/**
 * toolUseLoopInertia.test.js — 断线惯性「完成 + 无感衔接」的循环集成。
 *
 * 背景(goal 2026-06-25):流式层在瞬断且已有进度时交回 PARTIAL(interrupted:true +
 * 模型已下达的 toolUseBlocks,无 errorType)。这些已下达的工具调用不需要模型即可完成。
 * 循环应当:
 *   1. 把已下达的(可执行)工具调用按惯性跑完;
 *   2. 在「重连」的下一次模型调用前,注入 [SYSTEM] 重连提示告知模型「曾断线、据惯性结果
 *      续跑勿重复」—— 实现无感衔接;
 *   3. 在返回对象上带 inertia 摘要(供 UI/程序消费)。
 *
 * 用一个计数 mock chat 驱动真实 loop:首回合返回断线 partial(带一个未知工具的 block,
 * 执行会得到 failure 结果但循环照常续跑),次回合是「重连」——断言其收到的 message 含
 * 重连提示,且最终返回的 inertia 摘要正确。零网络、零进程。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const toolUseLoop = require('../../src/services/toolUseLoop');

// 非动作类 prompt → 让依赖 actionTask 的 nudge 保持休眠,隔离惯性路径。
const NON_ACTION_PROMPT = '你是什么模型';

describe('toolUseLoop — 断线惯性完成 + 无感衔接', () => {
  let _savedGate;
  let _savedInertia;

  before(() => {
    _savedGate = process.env.KHY_TASK_CAPABILITY_GATE;
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    _savedInertia = process.env.KHY_INERTIA_COMPLETION;
    delete process.env.KHY_INERTIA_COMPLETION; // 默认开
  });

  after(() => {
    if (_savedGate === undefined) delete process.env.KHY_TASK_CAPABILITY_GATE;
    else process.env.KHY_TASK_CAPABILITY_GATE = _savedGate;
    if (_savedInertia === undefined) delete process.env.KHY_INERTIA_COMPLETION;
    else process.env.KHY_INERTIA_COMPLETION = _savedInertia;
  });

  test('断线 partial → 惯性执行已下达调用 → 重连那次模型调用收到重连提示 → 返回 inertia 摘要', async () => {
    const seenMessages = [];
    let calls = 0;
    const chat = async (message) => {
      calls += 1;
      seenMessages.push(String(message));
      if (calls === 1) {
        // 流式层断线 partial:interrupted + 模型已下达的 tool_use(未知工具,执行得 failure
        // 但不影响循环续跑),无 errorType → 自然 fall-through 到惯性执行路径。
        return {
          reply: '',
          interrupted: true,
          interruptError: 'socket hang up',
          finishReason: 'length',
          toolUseBlocks: [{ name: '__inertia_probe__', input: { ok: 1 } }],
          provider: 'mock',
        };
      }
      // 「重连」回合:模型据惯性结果给出正常答案,实现无感衔接。
      return { reply: '已基于已完成的步骤继续并给出结论。', stopReason: 'stop', provider: 'mock' };
    };

    const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, {
      chat,
      maxIterations: 6,
    });

    // 断线一次 → 惯性执行 → 重连一次:chat 恰好两次。
    assert.equal(calls, 2, `expected 2 chat calls, got ${calls}`);
    // 无感衔接:重连那次(第二次)模型调用的 message 携带显式重连提示。
    assert.match(seenMessages[1], /上一回合模型通道中途断开/);
    assert.match(seenMessages[1], /切勿重复已完成的调用/);
    // 返回对象带 inertia 摘要:一次惯性回合、执行 1 个已下达调用、丢弃 0。
    assert.ok(result.inertia, 'result.inertia 应存在');
    assert.equal(result.inertia.turns, 1);
    assert.equal(result.inertia.executed, 1);
    assert.equal(result.inertia.dropped, 0);
    // 用户拿到的是模型续接后的正常答案(成功路径不被断线噪音污染)。
    assert.match(String(result.finalResponse), /继续并给出结论|已基于已完成的步骤/);
  });

  test('KHY_INERTIA_COMPLETION=0 → 回退盲目行为:不注入重连提示、无 inertia 摘要', async () => {
    process.env.KHY_INERTIA_COMPLETION = '0';
    try {
      const seenMessages = [];
      let calls = 0;
      const chat = async (message) => {
        calls += 1;
        seenMessages.push(String(message));
        if (calls === 1) {
          return {
            reply: '',
            interrupted: true,
            toolUseBlocks: [{ name: '__inertia_probe__', input: { ok: 1 } }],
            provider: 'mock',
          };
        }
        return { reply: '完成。', stopReason: 'stop', provider: 'mock' };
      };

      const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, {
        chat,
        maxIterations: 6,
      });

      // 关闭后:第二次 message 不含重连提示,返回对象无 inertia。
      if (seenMessages[1] !== undefined) {
        assert.doesNotMatch(seenMessages[1], /上一回合模型通道中途断开/);
      }
      assert.equal(result.inertia, undefined);
    } finally {
      process.env.KHY_INERTIA_COMPLETION = '0';
    }
  });
});
