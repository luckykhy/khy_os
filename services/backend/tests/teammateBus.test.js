'use strict';

/**
 * Tests for the s15 fix: real in-process teammate collaboration.
 *
 * Before this fix, TeamCreate/TeamDelete were stubs (fake IDs, no backing
 * store) and SendMessage could only reach coordinator process workers, so a
 * teammate could never deliver a message back to the lead. This suite asserts
 * the full collaboration cycle now works through one shared teammateBus:
 *
 *   create -> runner does work -> teammate replies -> lead inbox -> injected as
 *   <teammate-message>; plus lead -> teammate messaging and delete round-trips.
 */

const assert = require('assert');

const bus = require('../src/tools/teammateBus');
const TeamCreateTool = require('../src/tools/TeamCreateTool');
const TeamDeleteTool = require('../src/tools/TeamDeleteTool');
const SendMessage = require('../src/tools/SendMessageTool');

const TeamCreate = new TeamCreateTool();
const TeamDelete = new TeamDeleteTool();

// Wait for the async dispatch chain (runner -> status -> sendToLead) to settle.
const flush = () => new Promise((r) => setImmediate(r));

afterEach(() => bus._resetForTest());

describe('s15 — teammateBus registry', () => {
  test('createTeammate registers a running teammate with a real id', async () => {
    bus.setTeammateRunner(() => 'done'); // deterministic, no LLM
    const t = bus.createTeammate({ name: 'scout', task: 'survey the repo' });
    assert.ok(!t.error, 'should not error');
    assert.ok(/^team_/.test(t.id), 'id should be a real generated id');
    assert.strictEqual(t.name, 'scout');
    assert.strictEqual(bus.getTeammate(t.id).id, t.id);
    assert.strictEqual(bus.listTeammates().length, 1);
    await flush();
  });

  test('rejects missing name or task', () => {
    assert.ok(bus.createTeammate({ task: 'x' }).error);
    assert.ok(bus.createTeammate({ name: 'x' }).error);
  });

  test('enforces the teammate limit', () => {
    bus.setTeammateRunner(() => 'ok');
    const max = bus.maxTeammates();
    for (let i = 0; i < max; i++) {
      assert.ok(!bus.createTeammate({ name: `t${i}`, task: 'work' }).error);
    }
    const overflow = bus.createTeammate({ name: 'one-too-many', task: 'work' });
    assert.ok(overflow.error);
    assert.ok(/limit/.test(overflow.error));
  });

  test('deleteTeammate removes it and discards its inbox', () => {
    bus.setTeammateRunner(() => new Promise(() => {})); // never resolves
    const t = bus.createTeammate({ name: 'worker', task: 'long job' });
    assert.strictEqual(bus.deleteTeammate(t.id), true);
    assert.strictEqual(bus.getTeammate(t.id), null);
    assert.strictEqual(bus.deleteTeammate(t.id), false, 'second delete is a no-op');
  });
});

describe('s15 — message flow', () => {
  test('a teammate completion lands in the lead inbox and formats as <teammate-message>', async () => {
    bus.setTeammateRunner((tm) => `finished: ${tm.task}`);
    bus.createTeammate({ name: 'analyst', task: 'summarize logs' });
    await flush();

    const text = bus.collectTeammateMessagesAsText();
    assert.ok(text, 'lead inbox should have a message');
    assert.ok(text.includes('<teammate-message from="analyst"'));
    assert.ok(text.includes('type="completion"'));
    assert.ok(text.includes('finished: summarize logs'));

    // Draining is destructive — a second read returns nothing.
    assert.strictEqual(bus.collectTeammateMessagesAsText(), null);
  });

  test('a failing runner marks the teammate failed and reports to the lead', async () => {
    bus.setTeammateRunner(() => { throw new Error('boom'); });
    const t = bus.createTeammate({ name: 'flaky', task: 'risky job' });
    await flush();

    assert.strictEqual(bus.getTeammate(t.id).status, 'failed');
    const text = bus.collectTeammateMessagesAsText();
    assert.ok(text.includes('type="error"'));
    assert.ok(text.includes('boom'));
  });

  test('lead -> teammate messages queue in the teammate inbox', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'builder', task: 'build' });
    assert.strictEqual(bus.sendToTeammate(t.id, 'also run the linter'), true);
    const inbox = bus.drainTeammateInbox(t.id);
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].message, 'also run the linter');
    assert.strictEqual(bus.drainTeammateInbox(t.id).length, 0, 'drain is destructive');
  });

  test('sendToTeammate on an unknown id fails cleanly', () => {
    assert.strictEqual(bus.sendToTeammate('team_nope', 'hi'), false);
  });
});

describe('s15 — tools operate on the shared bus', () => {
  test('TeamCreate -> SendMessage -> TeamDelete round-trip', async () => {
    bus.setTeammateRunner(() => new Promise(() => {})); // keep it running

    const created = await TeamCreate.execute({ name: 'helper', task: 'assist' });
    assert.strictEqual(created.success, true);
    assert.ok(created.teammate_id);
    assert.strictEqual(created.status, 'running');

    // SendMessage routes to the teammate (not a coordinator worker).
    const sent = await SendMessage.execute({ to: created.teammate_id, message: 'focus on tests' });
    assert.strictEqual(sent.success, true);
    const inbox = bus.drainTeammateInbox(created.teammate_id);
    assert.strictEqual(inbox[0].message, 'focus on tests');

    const del = await TeamDelete.execute({ teammate_id: created.teammate_id, force: true });
    assert.strictEqual(del.success, true);
    assert.strictEqual(bus.getTeammate(created.teammate_id), null);
  });

  test('TeamCreate surfaces validation errors instead of a fake id', async () => {
    const res = await TeamCreate.execute({ name: '', task: 'x' });
    assert.strictEqual(res.success, false);
    assert.ok(res.error);
  });

  test('TeamDelete on an unknown teammate reports not found', async () => {
    const res = await TeamDelete.execute({ teammate_id: 'team_ghost' });
    assert.strictEqual(res.success, false);
    assert.ok(/not found/.test(res.error));
  });

  test('SendMessage is enabled once a teammate exists', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    assert.strictEqual(SendMessage.isEnabled(), false, 'disabled with no teammates / no coordinator');
    bus.createTeammate({ name: 'x', task: 'y' });
    assert.strictEqual(SendMessage.isEnabled(), true);
  });
});
