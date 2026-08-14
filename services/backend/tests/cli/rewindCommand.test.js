'use strict';

/**
 * rewindCommand.test.js — the readline `/rewind <n>` path (CC double-ESC 对齐的
 * 命令降级). The numeric form is intercepted inside handlers/rollback.js's
 * handleRollback BEFORE the legacy checkpoint-rollback path, so `rewind list` /
 * `rewind file` / `rewind <checkpointId>` stay untouched while `/rewind 2`
 * rewinds the model history to the 2nd-from-last user turn via ai.rewindToUserTurn.
 *
 * Console output is silenced so the assertions read cleanly. Uses the same
 * __test__._pushRawMessage seam as rewindToUserTurn.test.js → run under
 * `node --test` (NOT jest).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ai = require('../../src/cli/ai');
const { handleRollback } = require('../../src/cli/handlers/rollback');
const { _pushRawMessage } = ai.__test__;

let _log;
let _restoreCalled;

beforeEach(() => {
  ai.clearHistory();
  _log = console.log;
  console.log = () => {};
  // Stub the checkpoint service so the handler's best-effort code restore
  // neither touches disk nor depends on the test cwd having checkpoints.
  const ckpt = require('../../src/services/workspace/checkpointService');
  _restoreCalled = [];
  ckpt.__origList = ckpt.listCheckpoints;
  ckpt.__origRestore = ckpt.restoreCheckpoint;
  ckpt.listCheckpoints = () => [{ id: 'ck_latest' }];
  ckpt.restoreCheckpoint = (dir, id) => { _restoreCalled.push(id); return { success: true }; };
});

afterEach(() => {
  console.log = _log;
  const ckpt = require('../../src/services/workspace/checkpointService');
  if (ckpt.__origList) ckpt.listCheckpoints = ckpt.__origList;
  if (ckpt.__origRestore) ckpt.restoreCheckpoint = ckpt.__origRestore;
});

describe('handleRollback — numeric /rewind <n> (conversation rewind)', () => {
  test('/rewind 1 drops the most recent user turn + everything after', async () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });
    _pushRawMessage({ role: 'assistant', content: 'A1' });
    _pushRawMessage({ role: 'user', content: 'Q2' });
    _pushRawMessage({ role: 'assistant', content: 'A2' });

    // parseInput keeps a bare number in args[0] (SUB_COMMANDS.rewind === ['list']).
    await handleRollback('rewind', null, ['1'], {});

    assert.deepEqual(ai.getConversation().map((m) => m.content), ['Q1', 'A1']);
    assert.deepEqual(_restoreCalled, ['ck_latest'], 'best-effort code restore fired');
  });

  test('/rewind 2 rewinds to the second-from-last user turn', async () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });
    _pushRawMessage({ role: 'assistant', content: 'A1' });
    _pushRawMessage({ role: 'user', content: 'Q2' });
    _pushRawMessage({ role: 'assistant', content: 'A2' });
    _pushRawMessage({ role: 'user', content: 'Q3' });

    await handleRollback('rewind', null, ['2'], {});

    assert.deepEqual(ai.getConversation().map((m) => m.content), ['Q1', 'A1']);
  });

  test('numeric token in subCommand is also honored', async () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });
    _pushRawMessage({ role: 'assistant', content: 'A1' });
    _pushRawMessage({ role: 'user', content: 'Q2' });

    await handleRollback('rewind', '1', [], {});

    assert.deepEqual(ai.getConversation().map((m) => m.content), ['Q1', 'A1']);
  });

  test('out-of-range n leaves history untouched (structured error, no throw)', async () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });
    _pushRawMessage({ role: 'assistant', content: 'A1' });

    await handleRollback('rewind', null, ['9'], {});

    assert.equal(ai.getConversation().length, 2, 'history untouched');
    assert.deepEqual(_restoreCalled, [], 'no code restore on failed rewind');
  });

  test('non-numeric subcommand (list) is NOT intercepted as conversation rewind', async () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });
    _pushRawMessage({ role: 'assistant', content: 'A1' });

    // `rewind list` must fall through to the legacy restore-point listing, which
    // does not mutate the model history.
    await handleRollback('rewind', 'list', [], {});

    assert.equal(ai.getConversation().length, 2, 'list path leaves history intact');
    assert.deepEqual(_restoreCalled, [], 'list path does not restore code');
  });
});
