'use strict';

/**
 * emptyReplyRetry.test.js — empty-result auto-retry regression for DESIGN-ARCH-046.
 *
 * Constructs the "返回空结果 / 回复被截断需二次触发" exception scenario: the model
 * call returns an empty reply. The loop must auto-trigger ONE bounded retry
 * (informing the user via onToolResult) BEFORE surfacing the canned fallback —
 * never leaving the user to manually re-ask. Honors the hard constraints:
 *
 *   • zero latency on the normal path — a non-empty first reply triggers no retry
 *     (chat called exactly once);
 *   • no infinite loop / no repetition — the retry budget is bounded (default 2),
 *     and an empty reply carries no content to repeat;
 *   • after the budget is exhausted, the canned fallback is returned WITH the
 *     E01 attribution (so chatStateIsolation can keep it out of history).
 *
 * Drives the real runToolUseLoop with a counting fake chat. Zero network/process.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const toolUseLoop = require('../../../src/services/toolUseLoop');

const NON_ACTION_PROMPT = '你是什么模型';

describe('toolUseLoop — empty-reply auto-retry (DESIGN-ARCH-046)', () => {
  let _savedGate;
  let _savedMax;

  before(() => {
    _savedGate = process.env.KHY_TASK_CAPABILITY_GATE;
    _savedMax = process.env.KHY_TOOL_LOOP_EMPTY_RECOVERIES;
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    // Keep the retry delay tiny so the test is fast and deterministic.
    process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS = '1';
    delete process.env.KHY_TOOL_LOOP_EMPTY_RECOVERIES; // use default (2)
  });

  after(() => {
    if (_savedGate === undefined) delete process.env.KHY_TASK_CAPABILITY_GATE;
    else process.env.KHY_TASK_CAPABILITY_GATE = _savedGate;
    if (_savedMax === undefined) delete process.env.KHY_TOOL_LOOP_EMPTY_RECOVERIES;
    else process.env.KHY_TOOL_LOOP_EMPTY_RECOVERIES = _savedMax;
    delete process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS;
  });

  test('empty reply auto-retries once, then delivers the real answer (no re-ask needed)', async () => {
    let calls = 0;
    const statuses = [];
    const chat = async () => {
      calls += 1;
      if (calls === 1) return { reply: '', stopReason: 'stop', provider: 'mock' };
      return { reply: '我是基于大模型的助手。', stopReason: 'stop', provider: 'mock' };
    };

    const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, {
      chat,
      maxIterations: 5,
      onToolResult: (name, _p, _r, _i, _e, summary) => {
        if (name === '_system_retry') statuses.push(String(summary || ''));
      },
    });

    assert.equal(calls, 2, 'empty → one auto-retry → answer (chat called twice)');
    assert.match(result.finalResponse, /大模型的助手/);
    assert.equal(result.errorType, undefined, 'a recovered turn is not an error turn');
    assert.ok(statuses.some((s) => /正在重试/.test(s)), 'user is told it is retrying, not left waiting');
  });

  test('persistent empty reply → bounded (no infinite loop) → canned fallback + E01', async () => {
    let calls = 0;
    const chat = async () => {
      calls += 1;
      return { reply: '', stopReason: 'stop', provider: 'mock' };
    };

    const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, { chat, maxIterations: 8 });

    // Default budget = 2 retries ("网络波动 → 重试几次") → exactly three calls, bounded.
    assert.equal(calls, 3, 'default budget = 2 retries → exactly three calls, never an infinite loop');
    assert.match(result.finalResponse, /未能生成有效回复/);
    // "重试失败后再报真实错误": the dead-end is transparent about the auto-retries.
    assert.match(result.finalResponse, /已自动重试 2 次/, 'exhausted recovery states it auto-retried');
    assert.equal(result.error_code, 'E01', 'fallback carries E01 so isolation keeps it out of history');
  });

  test('retry budget is env-tunable (KHY_TOOL_LOOP_EMPTY_RECOVERIES)', async () => {
    const _saved = process.env.KHY_TOOL_LOOP_EMPTY_RECOVERIES;
    process.env.KHY_TOOL_LOOP_EMPTY_RECOVERIES = '3';
    try {
      let calls = 0;
      const chat = async () => {
        calls += 1;
        return { reply: '', stopReason: 'stop', provider: 'mock' };
      };
      const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, { chat, maxIterations: 10 });
      assert.equal(calls, 4, '3 retries → four calls total');
      assert.match(result.finalResponse, /已自动重试 3 次/);
    } finally {
      if (_saved === undefined) delete process.env.KHY_TOOL_LOOP_EMPTY_RECOVERIES;
      else process.env.KHY_TOOL_LOOP_EMPTY_RECOVERIES = _saved;
    }
  });

  test('HARD CONSTRAINT: a non-empty first reply triggers ZERO retry (no added latency)', async () => {
    let calls = 0;
    const chat = async () => {
      calls += 1;
      return { reply: '正常的完整回答。', stopReason: 'stop', provider: 'mock' };
    };

    const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, { chat, maxIterations: 5 });

    assert.equal(calls, 1, 'normal path must call chat exactly once — no recovery latency');
    assert.match(result.finalResponse, /正常的完整回答/);
  });

  // ── 无感衔接保底轻推（Goal：无感顺滑）──────────────────────────────────
  describe('stall safety-net nudge — seamless: silent first nudge, 1-2 total', () => {
    test('budget=0: a stall recovers on the SILENT first nudge — no visible status (无感顺滑)', async () => {
      let calls = 0;
      const visibleNudges = [];
      const chat = async () => {
        calls += 1;
        if (calls === 1) return { reply: '', stopReason: 'stop', provider: 'mock' };
        return { reply: '续接之后给出的完整答案。', stopReason: 'stop', provider: 'mock' };
      };

      // The first nudge is silent: the user perceives no hitch at all.
      const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, {
        chat,
        maxIterations: 5,
        maxEmptyRecoveries: 0,
        onToolResult: (name, _p, _r, _i, _e, summary) => {
          if (name === '_system_nudge') visibleNudges.push(String(summary || ''));
        },
      });

      assert.equal(calls, 2, 'stall → silent nudge → answer (chat called twice)');
      assert.equal(visibleNudges.length, 0, 'the first nudge is SILENT — seamless, no status line');
      assert.match(result.finalResponse, /续接之后给出的完整答案/);
      assert.equal(result.errorType, undefined, 'a nudged-then-recovered turn is not an error turn');
    });

    test('budget=0: needs two nudges → first SILENT, second VISIBLE, then recovers', async () => {
      let calls = 0;
      const visibleNudges = [];
      const chat = async () => {
        calls += 1;
        // Empty on the stall AND the silent first nudge; second nudge succeeds.
        if (calls <= 2) return { reply: '', stopReason: 'stop', provider: 'mock' };
        return { reply: '第二次续接后给出的答案。', stopReason: 'stop', provider: 'mock' };
      };

      const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, {
        chat,
        maxIterations: 6,
        maxEmptyRecoveries: 0,
        onToolResult: (name, _p, _r, _i, _e, summary) => {
          if (name === '_system_nudge') visibleNudges.push(String(summary || ''));
        },
      });

      assert.equal(calls, 3, 'stall → silent nudge#1 (empty) → visible nudge#2 → answer = three calls');
      assert.equal(visibleNudges.length, 1, 'only the SECOND nudge surfaces a status (first stayed silent)');
      assert.match(visibleNudges[0], /续接（2\/2）/, 'visible status shows progress 2/2');
      assert.match(result.finalResponse, /第二次续接后给出的答案/);
      assert.equal(result.errorType, undefined);
    });

    test('budget=0: persistent stall → at most TWO nudges (1 silent + 1 visible) then error', async () => {
      let calls = 0;
      let visibleNudges = 0;
      const chat = async () => {
        calls += 1;
        return { reply: '', stopReason: 'stop', provider: 'mock' };
      };

      const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, {
        chat,
        maxIterations: 8,
        maxEmptyRecoveries: 0,
        onToolResult: (name) => { if (name === '_system_nudge') visibleNudges += 1; },
      });

      // 1 stall + 2 nudge attempts = exactly three calls, then bounded error.
      assert.equal(calls, 3, 'budget=0 → at most two nudges → exactly three calls, never an infinite loop');
      assert.equal(visibleNudges, 1, 'only the second nudge is visible; the first is seamless');
      assert.match(result.finalResponse, /未能生成有效回复/);
      assert.equal(result.error_code, 'E01', 'after the nudges fail, it still reports the real error with E01');
    });

    test('stall nudge count is env-tunable to 1 (KHY_TOOL_LOOP_STALL_NUDGES) — one silent nudge', async () => {
      const _saved = process.env.KHY_TOOL_LOOP_STALL_NUDGES;
      process.env.KHY_TOOL_LOOP_STALL_NUDGES = '1';
      try {
        let calls = 0;
        let visibleNudges = 0;
        const chat = async () => {
          calls += 1;
          return { reply: '', stopReason: 'stop', provider: 'mock' };
        };
        const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, {
          chat,
          maxIterations: 8,
          maxEmptyRecoveries: 0,
          onToolResult: (name) => { if (name === '_system_nudge') visibleNudges += 1; },
        });
        assert.equal(calls, 2, 'one stall + one (silent) nudge = two calls');
        assert.equal(visibleNudges, 0, 'max=1 → the single nudge is silent (fully seamless)');
        assert.equal(result.error_code, 'E01');
      } finally {
        if (_saved === undefined) delete process.env.KHY_TOOL_LOOP_STALL_NUDGES;
        else process.env.KHY_TOOL_LOOP_STALL_NUDGES = _saved;
      }
    });

    test('budget>0: existing retries already nudge, so the safety-net does NOT double-fire', async () => {
      let calls = 0;
      let nudgeCount = 0;
      let retryCount = 0;
      const chat = async () => {
        calls += 1;
        return { reply: '', stopReason: 'stop', provider: 'mock' };
      };

      // Default budget (2) handles the nudging; the safety-net must stay dormant.
      const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, {
        chat,
        maxIterations: 8,
        onToolResult: (name) => {
          if (name === '_system_nudge') nudgeCount += 1;
          if (name === '_system_retry') retryCount += 1;
        },
      });

      assert.ok(retryCount >= 1, 'the existing empty-recovery retries handle the nudging');
      assert.equal(nudgeCount, 0, 'safety-net does not double-nudge when retries already ran');
      assert.equal(result.error_code, 'E01');
    });
  });
});
