'use strict';

/**
 * toolUseLoop.verifyNonEdit.test.js — P6 of the KHY⇄CC mode-alignment work.
 *
 * CC keeps a verification reflex for research/shell/API work, not just code
 * edits. KHY's hard verification gate only fired when files were modified
 * (_allModifiedFiles.size > 0), so a task that ran substantive non-edit tools
 * (shell/web/search) but wrote nothing could conclude on thin evidence with no
 * self-check at all.
 *
 * P6 (KHY_VERIFY_NONEDIT, default on): after >= THRESHOLD substantive non-edit
 * tool calls and no file changes, when the model tries to conclude, run ONE
 * lightweight evidence-sufficiency probe. A FAIL re-injects the gaps and forces
 * another iteration; PASS concludes normally. Disabled with KHY_VERIFY_NONEDIT=off.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-verify-nonedit-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';
process.env.KHY_METACONSTRAINT = 'off';
process.env.KHY_SYSCALL_GATEWAY = 'off';
process.env.KHY_VERIFY_NONEDIT_THRESHOLD = '1';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const toolUseLoop = require('../src/services/toolUseLoop');

// Build a chat stub that: (1) issues one shellCommand, then (2) tries to
// conclude. The probe verdict is controlled by `probeVerdict`.
function makeChat(captured, probeVerdict) {
  let calls = 0;
  return async (message, opts) => {
    calls += 1;
    if (opts && opts._verificationProbe) {
      captured.probeFired = true;
      return { reply: JSON.stringify(probeVerdict), stopReason: 'stop', provider: 'mock' };
    }
    if (calls === 1) {
      return {
        reply: '',
        toolUseBlocks: [{ type: 'tool_use', id: 's1', name: 'shellCommand', input: { command: 'echo hi' } }],
        stopReason: 'tool_use',
        provider: 'mock',
      };
    }
    captured.conclusions = (captured.conclusions || 0) + 1;
    captured.lastMessage = message;
    return { reply: 'done.', stopReason: 'stop', provider: 'mock' };
  };
}

describe('non-edit evidence-sufficiency gate (P6)', () => {
  afterEach(() => {
    delete process.env.KHY_VERIFY_NONEDIT;
    delete process.env.KHY_VERIFY_NONEDIT_ROUNDS;
  });

  test('default on: a FAIL verdict re-injects an EVIDENCE GATE and forces another turn', async () => {
    const captured = {};
    await toolUseLoop.runToolUseLoop('run echo and report', {
      chat: makeChat(captured, { verdict: 'FAIL', gaps: ['output not verified'] }),
      maxIterations: 6,
      sessionId: 'sess-p6-fail',
      requestId: 'req-p6-fail',
      onControlRequest: async () => true,
    });
    assert.equal(captured.probeFired, true, 'evidence probe should have fired');
    assert.match(captured.lastMessage, /EVIDENCE GATE/);
    assert.match(captured.lastMessage, /output not verified/);
    // The model concluded more than once (gate forced a re-iteration).
    assert.ok((captured.conclusions || 0) >= 2, 'gate should force at least one extra conclusion attempt');
  });

  test('a PASS verdict lets the turn conclude without re-injection', async () => {
    const captured = {};
    await toolUseLoop.runToolUseLoop('run echo and report', {
      chat: makeChat(captured, { verdict: 'PASS', gaps: [] }),
      maxIterations: 6,
      sessionId: 'sess-p6-pass',
      requestId: 'req-p6-pass',
      onControlRequest: async () => true,
    });
    assert.equal(captured.probeFired, true, 'evidence probe should have fired');
    assert.equal(captured.conclusions, 1, 'PASS should conclude in a single attempt');
  });

  test('KHY_VERIFY_NONEDIT=off skips the gate entirely (no probe)', async () => {
    process.env.KHY_VERIFY_NONEDIT = 'off';
    const captured = {};
    await toolUseLoop.runToolUseLoop('run echo and report', {
      chat: makeChat(captured, { verdict: 'FAIL', gaps: ['should not be used'] }),
      maxIterations: 6,
      sessionId: 'sess-p6-off',
      requestId: 'req-p6-off',
      onControlRequest: async () => true,
    });
    assert.notEqual(captured.probeFired, true, 'probe must not fire when disabled');
    assert.equal(captured.conclusions, 1);
  });
});
