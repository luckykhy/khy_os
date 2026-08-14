'use strict';

/**
 * toolUseLoopUrgentSteer.test.js — /s! 紧急 steer：抢占当前回合、保留上下文、原地续跑。
 *
 * 背景：忙碌态补充提示词原只有两端——/s（被动排队，等回合结束才注入）与 /i（取消整个
 * 循环、丢失已累积进度后作为新任务重跑）。中间档 /s! 取消当前在飞模型回合，但保留循环
 * 上下文，把用户修正注入后原地重发——几秒落地且不丢进度。
 *
 * 实现侧：repl 在 /s! 时同步 _steerQueue.push(hint) → 置 _urgentSteerPending → 触发
 * relay-cancel；网关把 cancel resolve 成 {errorType:'cancelled'}。toolUseLoop 在错误分支
 * 顶端用 consumeUrgentSteer()（pull-clear 信号）区分「这是 /s! 抢占」与「真实网络 cancel / /i」，
 * 前者注入 steer 后 continue 重入本轮，后者落入原 transient/terminal 行为不变。
 *
 * 三条不变量：
 *   1. 续跑保进度：/s! cancel → 注入 [用户方向修正] → 原地重发，loop 不 bail，用户拿到
 *      修正后的正常答案，第二次 chat 收到的 message 含修正文本。
 *   2. 有界：信号恒真 + chat 恒 cancelled → 重发次数封顶 URGENT_STEER_MAX，随后落终态，
 *      绝不无限重发。
 *   3. 回归：无 consumeUrgentSteer（真实网络 cancel / /i）→ 走原 transient 后返回
 *      「请求已取消。」，证明非紧急 cancel 行为零变化。
 *
 * 这些场景不产生工具调用：一个计数 mock chat 驱动真实 loop。零网络、零进程。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const toolUseLoop = require('../../src/services/toolUseLoop');

// 非动作类 prompt → 依赖 actionTask 的 nudge 保持休眠，隔离 cancel/steer 路径。
const NON_ACTION_PROMPT = '你是什么模型';

describe('toolUseLoop — /s! 紧急 steer 抢占重入', () => {
  let _savedGate;
  let _savedDelay;

  before(() => {
    _savedGate = process.env.KHY_TASK_CAPABILITY_GATE;
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    // transient 重试退避默认 1.2s+，测试里压到地板（min 300ms）以保持快速。
    _savedDelay = process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS;
    process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS = '1';
  });

  after(() => {
    if (_savedGate === undefined) delete process.env.KHY_TASK_CAPABILITY_GATE;
    else process.env.KHY_TASK_CAPABILITY_GATE = _savedGate;
    if (_savedDelay === undefined) delete process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS;
    else process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS = _savedDelay;
  });

  test('续跑保进度：/s! cancel → 注入修正 → 原地重发拿到正常答案', async () => {
    const seenMessages = [];
    let calls = 0;
    const chat = async (message) => {
      calls += 1;
      seenMessages.push(String(message));
      if (calls === 1) {
        // 用户用 /s! 抢占在飞回合 → 网关把 cancel resolve 成 cancelled。
        return { errorType: 'cancelled', cancelled: true, provider: 'mock' };
      }
      // 重发回合：模型读到方向修正后给出正常答案。
      return { reply: '好的，已改用 TypeScript 重写完成。', stopReason: 'stop', provider: 'mock' };
    };

    // consumeUrgentSteer：首调返回 true（pull-clear），之后 false——模拟 repl 的一次性信号。
    let urgentArmed = true;
    const consumeUrgentSteer = () => {
      const v = urgentArmed;
      urgentArmed = false;
      return v;
    };

    // getSteerMessages：首调返回修正，之后清空——模拟 _steerQueue 的 pull-clear 语义。
    let steerPending = ['改用 TypeScript 实现'];
    const getSteerMessages = () => {
      const v = steerPending;
      steerPending = [];
      return v;
    };

    const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, {
      chat,
      consumeUrgentSteer,
      getSteerMessages,
      maxIterations: 8,
    });

    // 抢占一次 → 重发一次：chat 恰好两次。
    assert.equal(calls, 2, 'chat 应被调用两次（cancel 抢占 → 注入重发）');
    // loop 没有 bail：用户拿到正常答案，而非「请求已取消。」。
    assert.match(result.finalResponse, /已改用 TypeScript/, '用户应收到修正后的正常答案');
    assert.doesNotMatch(result.finalResponse, /请求已取消/, '紧急 steer 不应整体 bail');
    // 第二次重发的 message 必须带上注入的方向修正块（携 steer 重入本轮）。
    assert.match(seenMessages[1], /\[用户方向修正/, '重发 message 应含方向修正块');
    assert.match(seenMessages[1], /改用 TypeScript 实现/, '重发 message 应含用户修正文本');
    // 第一次的原始 message 不含修正块（注入只发生在重发前）。
    assert.doesNotMatch(seenMessages[0], /\[用户方向修正/, '首轮 message 不应预先注入');
  });

  test('有界：信号恒真 + chat 恒 cancelled → 重发封顶 URGENT_STEER_MAX，随后落终态', async () => {
    const MAX = parseInt(String(process.env.KHY_URGENT_STEER_MAX || '5'), 10) || 5;
    let calls = 0;
    const chat = async () => {
      calls += 1;
      return { errorType: 'cancelled', cancelled: true, provider: 'mock' };
    };
    const consumeUrgentSteer = () => true; // 恒真：模拟滥用 / 卡死场景
    const getSteerMessages = () => ['继续改'];

    const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, {
      chat,
      consumeUrgentSteer,
      getSteerMessages,
      maxIterations: 30,
      maxTransientRecoveries: 0, // 隔离紧急重发计数，不让 transient 叠加干扰断言
    });

    // 重发封顶：MAX 次紧急重入 + 1 次最终落入终态判定 = MAX+1 次 chat，绝不无限。
    assert.ok(calls <= MAX + 1, `紧急重发须有界，最多 ${MAX + 1} 次 chat，实得 ${calls}`);
    assert.ok(calls >= 2, `应至少重发一次，实得 ${calls}`);
    // 超限后落终态：cancelled → 「请求已取消。」。
    assert.match(result.finalResponse, /请求已取消/, '超过上限后应落入取消终态');
  });

  test('回归：无 consumeUrgentSteer（真实 cancel / /i）→ 走原 transient 后返回「请求已取消。」', async () => {
    let calls = 0;
    const chat = async () => {
      calls += 1;
      return { errorType: 'cancelled', cancelled: true, provider: 'mock' };
    };

    const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, {
      chat,
      // 故意不传 consumeUrgentSteer：模拟非 /s! 的普通取消。
      maxIterations: 8,
      maxTransientRecoveries: 1, // 1 次 transient 重试后落终态，路径确定
    });

    // 1 次初调 + 1 次 transient 重试 = 2 次 chat，随后终态。
    assert.equal(calls, 2, '非紧急 cancel 应走 1 次 transient 重试后落终态');
    assert.match(result.finalResponse, /请求已取消/, '非紧急 cancel 行为零变化');
    assert.equal(result.errorType, 'cancelled');
  });
});
