'use strict';

/**
 * toolUseLoopReplyGuard.test.js — 空回复守卫端到端(e2e),驱动真 runToolUseLoop。
 *
 * 覆盖被既有 emptyReplyRetry 测试遗漏的**诊断占位空漏路**:
 *   cli/ai.js 对真正空的模型回合会塞入**非空诊断占位串** + errorType:'empty_reply'。
 *   它非 transient(_isTransientLoopErrorType 只认裸 'empty'),旧路径走 errorType 分支直接把
 *   占位串当 stopped:true 失败抛给用户——既没丢弃也没要求重发(用户报告的现象)。
 *
 * 与 emptyReplyRetry.test.js 的关键差异:那里 chat 返回 `reply:''`(真正空,走 2490 块);
 * 这里 chat 返回 `reply:'<非空占位>', errorType:'empty_reply'`(走 errorType 分支 → 新守卫 seam)。
 *
 * 注入计数 fake chat,零网络/进程。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const toolUseLoop = require('../src/services/toolUseLoop');

const PROMPT = '你是什么模型';
const PLACEHOLDER = '抱歉，AI 未能生成有效回复。这可能是模型暂时不可用，请稍后重试。';

describe('toolUseLoop — 空回复守卫(诊断占位空:主动丢弃 + 要求重发)', () => {
  let _savedGate;
  let _savedReplyGuard;

  before(() => {
    _savedGate = process.env.KHY_TASK_CAPABILITY_GATE;
    _savedReplyGuard = process.env.KHY_REPLY_GUARD;
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS = '1';
  });

  after(() => {
    if (_savedGate === undefined) delete process.env.KHY_TASK_CAPABILITY_GATE;
    else process.env.KHY_TASK_CAPABILITY_GATE = _savedGate;
    if (_savedReplyGuard === undefined) delete process.env.KHY_REPLY_GUARD;
    else process.env.KHY_REPLY_GUARD = _savedReplyGuard;
    delete process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS;
  });

  test('门控开:占位空被丢弃,模型被要求重发并给出真实答案', async () => {
    process.env.KHY_REPLY_GUARD = '1';
    let calls = 0;
    const retryStatuses = [];
    const chat = async () => {
      calls += 1;
      if (calls === 1) return { reply: PLACEHOLDER, errorType: 'empty_reply', stopReason: 'stop', provider: 'mock' };
      return { reply: '我是基于大模型的助手。', stopReason: 'stop', provider: 'mock' };
    };

    const result = await toolUseLoop.runToolUseLoop(PROMPT, {
      chat,
      maxIterations: 5,
      onToolResult: (name, _p, _r, _i, _e, summary) => {
        if (name === '_system_retry') retryStatuses.push(String(summary || ''));
      },
    });

    assert.equal(calls, 2, '占位空 → 丢弃 + 重发一次 → 真实答案(chat 调 2 次)');
    assert.match(result.finalResponse, /大模型的助手/);
    assert.ok(!/未能生成有效回复/.test(result.finalResponse), '占位串已被丢弃,不外露给用户');
    assert.equal(result.errorType, undefined, '丢弃后重发成功的回合不是错误回合');
    assert.ok(retryStatuses.some((s) => /空回复已丢弃/.test(s)), '用户被告知空回复已丢弃正在重新生成');
  });

  test('门控关:字节回退——占位串照旧抛出,不重发', async () => {
    process.env.KHY_REPLY_GUARD = 'off';
    let calls = 0;
    const chat = async () => {
      calls += 1;
      return { reply: PLACEHOLDER, errorType: 'empty_reply', stopReason: 'stop', provider: 'mock' };
    };

    const result = await toolUseLoop.runToolUseLoop(PROMPT, { chat, maxIterations: 5 });

    assert.equal(calls, 1, '门控关 → 不重发,chat 仅调 1 次(字节回退)');
    assert.match(result.finalResponse, /未能生成有效回复/, '占位串照旧抛给用户');
    assert.equal(result.errorType, 'empty_reply');
    assert.equal(result.stopped, true);
  });

  test('门控开但占位空持续:有界(预算耗尽)→ 终端报真因,绝不死循环', async () => {
    process.env.KHY_REPLY_GUARD = '1';
    let calls = 0;
    const chat = async () => {
      calls += 1;
      return { reply: PLACEHOLDER, errorType: 'empty_reply', stopReason: 'stop', provider: 'mock' };
    };

    // 复用 emptyRecoveryUsed/Max 预算;显式设 2 → 守卫触发 2 次后落回终端。
    const result = await toolUseLoop.runToolUseLoop(PROMPT, { chat, maxIterations: 10, maxEmptyRecoveries: 2 });

    assert.equal(calls, 3, '预算 2 → 丢弃重发 2 次 → 第 3 次落回终端,有界绝不死循环');
    assert.match(result.finalResponse, /未能生成有效回复/, '耗尽后如实把占位串/真因交还用户');
    assert.equal(result.errorType, 'empty_reply');
  });

  test('NON_RESUMABLE(content_filter)即便门控开也绝不重发(防御纵深红线)', async () => {
    process.env.KHY_REPLY_GUARD = '1';
    let calls = 0;
    const chat = async () => {
      calls += 1;
      return { reply: '内容被安全策略拦截。', errorType: 'content_filter', stopReason: 'stop', provider: 'mock' };
    };

    const result = await toolUseLoop.runToolUseLoop(PROMPT, { chat, maxIterations: 5 });

    assert.equal(calls, 1, 'content_filter 是 NON_RESUMABLE → 守卫绝不重发,chat 仅调 1 次');
    assert.equal(result.errorType, 'content_filter');
  });

  test('门控开:正常非空回复零重发(无额外延迟)', async () => {
    process.env.KHY_REPLY_GUARD = '1';
    let calls = 0;
    const chat = async () => {
      calls += 1;
      return { reply: '正常的完整回答。', stopReason: 'stop', provider: 'mock' };
    };

    const result = await toolUseLoop.runToolUseLoop(PROMPT, { chat, maxIterations: 5 });

    assert.equal(calls, 1, '正常回复必须只调一次,守卫绝不误杀');
    assert.match(result.finalResponse, /正常的完整回答/);
  });
});
