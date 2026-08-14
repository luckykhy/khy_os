'use strict';

/**
 * toolUseLoopHabitThread.test.js — pins the contract that runToolUseLoop threads
 * the CLEAN original user message to chat() so the "太懂我了" preference learning
 * (ai.js, detectPreferenceSignal) survives the loop's per-turn prompt injection.
 *
 * goal(2026-06-25):the adaptive preference layer learns from short remarks like
 * "太长了" via a code-point<=18 / meta-marker gate. Inside runToolUseLoop the
 * per-iteration `currentMessage` gets planning / key-findings text prepended,
 * which would defeat that gate. The loop must therefore pass `_originalUserMessage`
 * (clean) in the chat opts, and mark continuation turns with `_isFollowUp` so the
 * detector learns exactly once. Without this, learning silently dies in the
 * default Ink TUI and classic REPL (both drive turns through runToolUseLoop).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const toolUseLoop = require('../../src/services/toolUseLoop');

describe('toolUseLoop — threads clean original message for habit learning', () => {
  let _savedGate;
  beforeEach(() => {
    _savedGate = process.env.KHY_TASK_CAPABILITY_GATE;
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
  });
  afterEach(() => {
    if (_savedGate === undefined) delete process.env.KHY_TASK_CAPABILITY_GATE;
    else process.env.KHY_TASK_CAPABILITY_GATE = _savedGate;
  });

  test('chat() opts carry _originalUserMessage equal to the raw prompt', async () => {
    const seen = [];
    const chat = async (message, opts = {}) => {
      seen.push({ message, _orig: opts._originalUserMessage, _followUp: opts._isFollowUp });
      return { reply: '收到。', stopReason: 'stop', provider: 'mock' };
    };
    await toolUseLoop.runToolUseLoop('太长了', { chat, maxIterations: 4 });

    assert.ok(seen.length >= 1, 'chat should be called at least once');
    // The clean original reaches the detector regardless of any prompt wrapping
    // the loop applies to the per-turn `message`.
    assert.equal(seen[0]._orig, '太长了');
    // First iteration must NOT be flagged a follow-up, so learning fires once.
    assert.ok(!seen[0]._followUp, 'first turn must not be a follow-up');
  });

  test('continuation turns are flagged _isFollowUp (learn-once guard)', async () => {
    const seen = [];
    // First turn requests a tool; second turn closes out. This forces a 2nd
    // chat() call so we can assert the follow-up flag on it.
    let call = 0;
    const chat = async (message, opts = {}) => {
      seen.push({ _followUp: opts._isFollowUp });
      call += 1;
      if (call === 1) {
        return {
          reply: '',
          stopReason: 'tool_use',
          provider: 'mock',
          toolUseBlocks: [{ id: 't1', name: 'noop_tool', input: {} }],
        };
      }
      return { reply: '完成。', stopReason: 'stop', provider: 'mock' };
    };
    // A no-op tool executor so the loop advances past the tool turn.
    const executeTool = async () => ({ ok: true, result: 'done' });
    await toolUseLoop.runToolUseLoop('太长了', { chat, executeTool, maxIterations: 4 });

    assert.ok(seen.length >= 2, 'expected a continuation turn');
    assert.ok(!seen[0]._followUp, 'iteration 1 not a follow-up');
    assert.equal(seen[1]._followUp, true, 'iteration 2 must be a follow-up');
  });
});
