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

describe('s15 â€?teammateBus registry', () => {
  test('createTeammate registers a running teammate with a real id', async () => {
    bus.setTeammateRunner(() => 'done'); // deterministic, no LLM
    const t = bus.createTeammate({ name: 'scout', task: 'survey the repo' });
    expect(!t.error).toBeTruthy();
    expect(/^team_/.test(t.id)).toBeTruthy();
    expect(t.name).toBe('scout');
    expect(bus.getTeammate(t.id).id).toBe(t.id);
    expect(bus.listTeammates().length).toBe(1);
    await flush();
  });

  test('rejects missing name or task', () => {
    expect(bus.createTeammate({ task: 'x' }).error).toBeTruthy();
    expect(bus.createTeammate({ name: 'x' }).error).toBeTruthy();
  });

  test('enforces the teammate limit', () => {
    bus.setTeammateRunner(() => 'ok');
    const max = bus.maxTeammates();
    for (let i = 0; i < max; i++) {
      expect(!bus.createTeammate({ name: `t${i}`, task: 'work' }).error).toBeTruthy();
    }
    const overflow = bus.createTeammate({ name: 'one-too-many', task: 'work' });
    expect(overflow.error).toBeTruthy();
    expect(/limit/.test(overflow.error)).toBeTruthy();
  });

  test('deleteTeammate removes it and discards its inbox', () => {
    bus.setTeammateRunner(() => new Promise(() => {})); // never resolves
    const t = bus.createTeammate({ name: 'worker', task: 'long job' });
    expect(bus.deleteTeammate(t.id)).toBe(true);
    expect(bus.getTeammate(t.id)).toBe(null);
    expect(bus.deleteTeammate(t.id)).toBe(false);
  });
});

describe('s15 â€?message flow', () => {
  test('a teammate completion lands in the lead inbox and formats as <teammate-message>', async () => {
    bus.setTeammateRunner((tm) => `finished: ${tm.task}`);
    bus.createTeammate({ name: 'analyst', task: 'summarize logs' });
    await flush();

    const text = bus.collectTeammateMessagesAsText();
    expect(text).toBeTruthy();
    expect(text).toContain('<teammate-message from="analyst"');
    expect(text).toContain('type="completion"');
    expect(text).toContain('finished: summarize logs');

    // Draining is destructive â€?a second read returns nothing.
    expect(bus.collectTeammateMessagesAsText()).toBe(null);
  });

  test('a failing runner marks the teammate failed and reports to the lead', async () => {
    bus.setTeammateRunner(() => { throw new Error('boom'); });
    const t = bus.createTeammate({ name: 'flaky', task: 'risky job' });
    await flush();

    expect(bus.getTeammate(t.id).status).toBe('failed');
    const text = bus.collectTeammateMessagesAsText();
    expect(text).toContain('type="error"');
    expect(text).toContain('boom');
  });

  test('lead -> teammate messages queue in the teammate inbox', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'builder', task: 'build' });
    expect(bus.sendToTeammate(t.id, 'also run the linter')).toBe(true);
    const inbox = bus.drainTeammateInbox(t.id);
    expect(inbox.length).toBe(1);
    expect(inbox[0].message).toBe('also run the linter');
    expect(bus.drainTeammateInbox(t.id).length).toBe(0);
  });

  test('sendToTeammate on an unknown id fails cleanly', () => {
    expect(bus.sendToTeammate('team_nope', 'hi')).toBe(false);
  });
});

describe('s15 â€?tools operate on the shared bus', () => {
  test('TeamCreate -> SendMessage -> TeamDelete round-trip', async () => {
    bus.setTeammateRunner(() => new Promise(() => {})); // keep it running

    const created = await TeamCreate.execute({ name: 'helper', task: 'assist' });
    expect(created.success).toBe(true);
    expect(created.teammate_id).toBeTruthy();
    expect(created.status).toBe('running');

    // SendMessage routes to the teammate (not a coordinator worker).
    const sent = await SendMessage.execute({ to: created.teammate_id, message: 'focus on tests' });
    expect(sent.success).toBe(true);
    const inbox = bus.drainTeammateInbox(created.teammate_id);
    expect(inbox[0].message).toBe('focus on tests');

    const del = await TeamDelete.execute({ teammate_id: created.teammate_id, force: true });
    expect(del.success).toBe(true);
    expect(bus.getTeammate(created.teammate_id)).toBe(null);
  });

  test('TeamCreate surfaces validation errors instead of a fake id', async () => {
    const res = await TeamCreate.execute({ name: '', task: 'x' });
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
  });

  test('TeamDelete on an unknown teammate reports not found', async () => {
    const res = await TeamDelete.execute({ teammate_id: 'team_ghost' });
    expect(res.success).toBe(false);
    expect(/not found/.test(res.error)).toBeTruthy();
  });

  test('SendMessage is enabled once a teammate exists', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    expect(SendMessage.isEnabled()).toBe(false);
    bus.createTeammate({ name: 'x', task: 'y' });
    expect(SendMessage.isEnabled()).toBe(true);
  });
});

