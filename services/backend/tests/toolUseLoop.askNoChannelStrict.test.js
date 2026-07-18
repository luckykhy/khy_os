'use strict';

/**
 * toolUseLoop.askNoChannelStrict.test.js — P3 of the KHY⇄CC mode-alignment work.
 *
 * When AskUserQuestion fires but there is no interactive host channel
 * (subagent / CI / background loop, i.e. no onControlRequest), KHY used to let
 * the tool's "Question queued for user" message pass through — so the model
 * barreled ahead as if it had asked. P3 (KHY_ASK_NOCHANNEL_STRICT, default on)
 * rewrites that result into a conservative instruction: pick a sensible default,
 * state the assumption, flag anything that truly needs the user. Setting the env
 * flag off restores the legacy fire-and-continue behavior.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ask-nochannel-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const toolUseLoop = require('../src/services/toolUseLoop');

const QUESTION_INPUT = {
  questions: [{
    question: 'Which database should the service use?',
    header: 'Database',
    options: [
      { label: 'postgres', description: 'Relational, default for the stack' },
      { label: 'sqlite', description: 'Embedded, zero-config' },
    ],
    multiSelect: false,
  }],
};

function makeChat(captured) {
  let calls = 0;
  return async (message) => {
    calls += 1;
    if (calls === 1) {
      return {
        reply: '',
        toolUseBlocks: [{ type: 'tool_use', id: 'auq1', name: 'AskUserQuestion', input: QUESTION_INPUT }],
        stopReason: 'tool_use',
        provider: 'mock',
      };
    }
    // Second turn carries the tool-result message back to the model.
    if (captured.secondMessage === undefined) captured.secondMessage = message;
    return { reply: 'Proceeding with postgres as the reasonable default.', stopReason: 'stop', provider: 'mock' };
  };
}

describe('AskUserQuestion no-channel conservative pause (P3)', () => {
  afterEach(() => { delete process.env.KHY_ASK_NOCHANNEL_STRICT; });

  test('default (strict on): re-injects a conservative instruction, not the queued stub', async () => {
    delete process.env.KHY_ASK_NOCHANNEL_STRICT; // default = on
    const captured = {};
    await toolUseLoop.runToolUseLoop('Set up the database for the service', {
      chat: makeChat(captured),
      maxIterations: 3,
      sessionId: 'sess-p3-a',
      requestId: 'req-p3-a',
      // No onControlRequest → no interactive channel.
    });
    assert.ok(captured.secondMessage, 'model should have been called a second time');
    assert.match(captured.secondMessage, /No interactive user channel/);
    assert.match(captured.secondMessage, /most reasonable default/);
    // The question text is echoed so the model has the context.
    assert.match(captured.secondMessage, /Which database should the service use\?/);
    // The silent legacy stub must NOT be what the model sees.
    assert.equal(/Question queued for user/.test(captured.secondMessage), false);
  });

  test('strict off: restores legacy fire-and-continue stub', async () => {
    process.env.KHY_ASK_NOCHANNEL_STRICT = '0';
    const captured = {};
    await toolUseLoop.runToolUseLoop('Set up the database for the service', {
      chat: makeChat(captured),
      maxIterations: 3,
      sessionId: 'sess-p3-b',
      requestId: 'req-p3-b',
    });
    assert.ok(captured.secondMessage, 'model should have been called a second time');
    assert.match(captured.secondMessage, /Question queued for user/);
    assert.equal(/No interactive user channel/.test(captured.secondMessage), false);
  });
});
