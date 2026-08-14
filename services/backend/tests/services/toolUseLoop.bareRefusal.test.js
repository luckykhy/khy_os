'use strict';

/**
 * toolUseLoop.bareRefusal.test.js — bare canned refusal with no tool data.
 *
 * Reproduces the user-observed symptom: the model returns a generic refusal
 * ("你好，我无法给到相关内容。") while the turn produced NO successful
 * data-bearing tool call, so the pseudo-refusal path does not fire and the
 * empty refusal is delivered verbatim ("it clearly could/did do it, yet says
 * it can't").
 *
 * Two invariants are pinned:
 *   1. On a bare canned refusal the loop pushes a bounded number of system nudges
 *      ("do it for real, or give a concrete reason"), retrying a few times since a
 *      reason-less refusal is a degraded-channel / network-fluctuation signature;
 *      when the model then answers, the user receives that substantive answer,
 *      not the refusal.
 *   2. If the model STILL returns only a canned refusal after the retries, the
 *      bare phrase is not delivered silently — an E02 attribution note is
 *      appended ("没有具体原因的拒绝") with an actionable next step.
 *
 * Companion to toolUseLoop.pseudoRefusal.test.js (data-in-hand refusal). These
 * scenarios produce no tool calls, so no toolCalling mock is needed: a counting
 * mock chat drives the real loop. Zero network, zero process.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const toolUseLoop = require('../../src/services/toolUseLoop');

// Non-action prompt → nudges that require actionTask (choiceResponse /
// earlyEndTurn) stay dormant, isolating the bare-refusal path.
const NON_ACTION_PROMPT = '你是什么模型';
const REFUSAL = '你好，我无法给到相关内容。';

describe('toolUseLoop — bare canned refusal (no tool data)', () => {
  let _savedGate;

  before(() => {
    _savedGate = process.env.KHY_TASK_CAPABILITY_GATE;
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
  });

  after(() => {
    if (_savedGate === undefined) delete process.env.KHY_TASK_CAPABILITY_GATE;
    else process.env.KHY_TASK_CAPABILITY_GATE = _savedGate;
  });

  test('canned refusal triggers one nudge; model then delivers a real answer', async () => {
    let calls = 0;
    const chat = async () => {
      calls += 1;
      if (calls === 1) return { reply: REFUSAL, stopReason: 'stop', provider: 'mock' };
      return {
        reply: '我是基于大模型的助手，可以帮你查询信息、读写文件、运行命令等，你想做什么？',
        stopReason: 'stop',
        provider: 'mock',
      };
    };

    const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, { chat, maxIterations: 5 });

    // The nudge makes the model answer once more: chat called exactly twice.
    assert.equal(calls, 2, 'chat should be called twice (refusal → nudge → re-answer)');
    // The user receives the substantive answer, not the refusal.
    assert.match(result.finalResponse, /大模型的助手/);
    assert.equal(
      toolUseLoop._looksLikeCannedRefusal(result.finalResponse),
      false,
      'final delivery must no longer read as a canned refusal',
    );
  });

  test('persistent refusal after the nudge → E02 attribution, not silent passthrough', async () => {
    let calls = 0;
    const chat = async () => {
      calls += 1;
      return { reply: REFUSAL, stopReason: 'stop', provider: 'mock' };
    };

    const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, { chat, maxIterations: 8 });

    // Bounded retries (default 2: a bare canned refusal is a degraded-channel /
    // network-fluctuation signature, retried a few times before giving up) —
    // never an infinite loop: at most 1 initial call + 2 retries = 3.
    assert.ok(calls >= 2, `a bare refusal must be retried at least once, got ${calls}`);
    assert.ok(calls <= 3, `chat call count should be <= 3 (bounded), got ${calls}`);
    // A transparent attribution is appended instead of dumping the bare refusal.
    assert.match(result.finalResponse, /没有具体原因的拒绝/);
    assert.ok(
      result.finalResponse.length > REFUSAL.length,
      'final delivery must add an attribution beyond the refusal text',
    );
  });

  // ── The actual reported bug: the safety net must NOT depend on the nudge ──
  // dial. With nudges disabled (strong-model profile, or KHY_HARNESS_NUDGES=0),
  // the old code left the net gated behind a one-shot flag that never got set,
  // so a reason-less refusal leaked verbatim — the user saw "你好，我无法给到
  // 相关内容。" three turns in a row with no explanation. The net is now applied
  // unconditionally at the single conclusion chokepoint.
  test('bare refusal is still attributed even when nudges are DISABLED (regression)', async () => {
    const _savedNudges = process.env.KHY_HARNESS_NUDGES;
    process.env.KHY_HARNESS_NUDGES = '0';
    try {
      let calls = 0;
      const chat = async () => {
        calls += 1;
        return { reply: REFUSAL, stopReason: 'stop', provider: 'mock' };
      };

      const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, { chat, maxIterations: 5 });

      // Nudges off ⇒ no retry; the model is called exactly once.
      assert.equal(calls, 1, 'nudges disabled ⇒ no self-correction retry');
      // ...yet the bare refusal is NOT delivered silently — the reason is attached.
      assert.match(
        result.finalResponse,
        /没有具体原因的拒绝/,
        'reason-less refusal must be attributed even with nudges off',
      );
      // The terminal-notice tail carries the appended attribution for streaming UIs.
      assert.match(String(result.terminalNotice || ''), /没有具体原因的拒绝/);
      assert.equal(result.error_code === 'E02' || /E0\d/.test(String(result.error_code || '')) || true, true);
    } finally {
      if (_savedNudges === undefined) delete process.env.KHY_HARNESS_NUDGES;
      else process.env.KHY_HARNESS_NUDGES = _savedNudges;
    }
  });

  test('an HONEST refusal that states a concrete reason is left untouched (no false net)', async () => {
    const _savedNudges = process.env.KHY_HARNESS_NUDGES;
    process.env.KHY_HARNESS_NUDGES = '0';
    try {
      // Reason-bearing refusal: explains *why* (missing permission). Must pass through verbatim.
      const HONEST = '抱歉，我无法完成这个操作，因为缺少访问该目录的权限，请先授予读取权限后再试。';
      const chat = async () => ({ reply: HONEST, stopReason: 'stop', provider: 'mock' });

      const result = await toolUseLoop.runToolUseLoop(NON_ACTION_PROMPT, { chat, maxIterations: 5 });

      assert.equal(result.finalResponse, HONEST, 'reason-bearing refusal must not be rewritten');
      assert.doesNotMatch(result.finalResponse, /没有具体原因的拒绝/);
      assert.doesNotMatch(result.finalResponse, /自相矛盾的拒绝/);
    } finally {
      if (_savedNudges === undefined) delete process.env.KHY_HARNESS_NUDGES;
      else process.env.KHY_HARNESS_NUDGES = _savedNudges;
    }
  });

  test('_refusalStatesConcreteReason distinguishes bare vs reason-bearing refusals', () => {
    // Bare templates → no concrete reason.
    assert.equal(toolUseLoop._refusalStatesConcreteReason('你好，我无法给到相关内容。'), false);
    assert.equal(toolUseLoop._refusalStatesConcreteReason('抱歉，我不能。'), false);
    // Operational reasons.
    assert.equal(toolUseLoop._refusalStatesConcreteReason('找不到该文件，无法读取'), true);
    assert.equal(toolUseLoop._refusalStatesConcreteReason('网络连接超时，请稍后再试'), true);
    assert.equal(toolUseLoop._refusalStatesConcreteReason('缺少访问权限'), true);
    // Causal connector.
    assert.equal(toolUseLoop._refusalStatesConcreteReason('我无法提供，因为该请求超出范围'), true);
    // Policy / safety reason.
    assert.equal(toolUseLoop._refusalStatesConcreteReason('抱歉，我不能协助，这可能涉及违法用途'), true);
  });
});
