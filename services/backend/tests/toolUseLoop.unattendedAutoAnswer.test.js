'use strict';

/**
 * toolUseLoop.unattendedAutoAnswer.test.js — 无人值守自动作答接线(goal 2026-07-11)。
 *
 * 连续几天不中断的隐性阻塞点:AskUserQuestion 会阻塞等人回答。开启
 * KHY_UNATTENDED_AUTOANSWER(默认关)后,循环用 questionQuality 排好序的推荐选项(index 0)
 * 确定性作答、无感续跑——优先于「有通道阻塞」与「无通道保守自决」两分支。门控关 → 逐字节回退。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-autoanswer-'));
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
    if (captured.secondMessage === undefined) captured.secondMessage = message;
    return { reply: 'Proceeding with postgres.', stopReason: 'stop', provider: 'mock' };
  };
}

describe('AskUserQuestion unattended auto-answer', () => {
  afterEach(() => {
    delete process.env.KHY_UNATTENDED_AUTOANSWER;
    delete process.env.KHY_ASK_NOCHANNEL_STRICT;
  });

  test('gate on (no channel): auto-answers with the recommended index-0 option, not the conservative pause', async () => {
    process.env.KHY_UNATTENDED_AUTOANSWER = '1';
    const captured = {};
    await toolUseLoop.runToolUseLoop('Set up the database for the service', {
      chat: makeChat(captured),
      maxIterations: 3,
      sessionId: 'sess-aa-a',
      requestId: 'req-aa-a',
      // No onControlRequest — auto-answer must fire regardless of channel presence.
    });
    assert.ok(captured.secondMessage, 'model should have been called a second time');
    // The chosen answer (index-0 = postgres) is spliced back as the answer.
    assert.match(captured.secondMessage, /postgres/);
    // Auto-answer takes precedence: the no-channel conservative text must NOT appear.
    assert.equal(/No interactive user channel/.test(captured.secondMessage), false);
    assert.equal(/Question queued for user/.test(captured.secondMessage), false);
  });

  test('gate on WITH channel: bypasses onControlRequest entirely (never blocks on a human)', async () => {
    process.env.KHY_UNATTENDED_AUTOANSWER = '1';
    const captured = {};
    let controlCalled = false;
    await toolUseLoop.runToolUseLoop('Set up the database for the service', {
      chat: makeChat(captured),
      maxIterations: 3,
      sessionId: 'sess-aa-b',
      requestId: 'req-aa-b',
      onControlRequest: async () => { controlCalled = true; return null; },
    });
    assert.equal(controlCalled, false, 'onControlRequest must NOT be invoked when auto-answer is on');
    assert.match(captured.secondMessage, /postgres/);
  });

  test('gate off (default): falls through to no-channel conservative pause (byte-identical legacy)', async () => {
    delete process.env.KHY_UNATTENDED_AUTOANSWER; // default off
    const captured = {};
    await toolUseLoop.runToolUseLoop('Set up the database for the service', {
      chat: makeChat(captured),
      maxIterations: 3,
      sessionId: 'sess-aa-c',
      requestId: 'req-aa-c',
    });
    assert.ok(captured.secondMessage, 'model should have been called a second time');
    assert.match(captured.secondMessage, /No interactive user channel/);
  });

  // 不偏离用户本意:盲选 index-0 会挑 sqlite,但用户原始诉求点名 postgres →
  // autoAnswerIntentGuard(默认开)据原始消息把选择校准回 postgres。
  test('intent-fidelity: realigns the blind index-0 pick to the user\'s original intent', async () => {
    process.env.KHY_UNATTENDED_AUTOANSWER = '1';
    const captured = {};
    let calls = 0;
    const chat = async (message) => {
      calls += 1;
      if (calls === 1) {
        return {
          reply: '',
          toolUseBlocks: [{
            type: 'tool_use',
            id: 'auq-intent',
            name: 'AskUserQuestion',
            input: {
              questions: [{
                question: 'Which database should the service use?',
                header: 'Database',
                options: [
                  { label: 'sqlite', description: 'Embedded, zero-config' },
                  { label: 'postgres', description: 'Relational server' },
                ],
                multiSelect: false,
              }],
            },
          }],
          stopReason: 'tool_use',
          provider: 'mock',
        };
      }
      if (captured.secondMessage === undefined) captured.secondMessage = message;
      return { reply: 'done', stopReason: 'stop', provider: 'mock' };
    };
    await toolUseLoop.runToolUseLoop('Migrate the service database to postgres for reliability', {
      chat,
      maxIterations: 3,
      sessionId: 'sess-aa-intent',
      requestId: 'req-aa-intent',
    });
    assert.ok(captured.secondMessage, 'model should have been called a second time');
    // Blind index-0 would be sqlite; the guard realigns to postgres (the stated intent).
    assert.match(captured.secondMessage, /postgres/);
    assert.equal(/「Which database.*sqlite/i.test(captured.secondMessage), false, 'must not answer sqlite');
  });
});
