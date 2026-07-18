'use strict';

/**
 * Tests for the s17 fix: autonomous teammates that self-claim board tasks.
 *
 * KHY already had the task board with claim() + canStart() + release() (s12) and
 * the teammate bus with protocols (s15/s16). What was missing — and what this
 * fix adds — is the bridge between them:
 *   - _taskStore.scanUnclaimed() / claimNext()  : the s17 scan + auto-claim.
 *   - teammateBus.autonomousPoll()              : the s17 idle_poll single step
 *     (inbox priority -> board auto-claim), so teammates find work themselves
 *     instead of the lead hand-assigning every task.
 */

const assert = require('assert');

const taskStore = require('../src/tools/_taskStore');
const bus = require('../src/tools/teammateBus');

let _n = 0;
const freshId = () => `t-s17-${process.pid}-${(_n += 1)}`;

afterEach(() => {
  try { taskStore.clear(); } catch { /* ignore */ }
  bus._resetForTest();
});

describe('s17 — _taskStore.scanUnclaimed', () => {
  test('returns only pending, unowned, startable tasks', () => {
    const a = freshId();
    const b = freshId();
    const owned = freshId();
    taskStore.add({ id: a, subject: 'schema', status: 'pending', createdAt: '2024-01-01T00:00:01Z' });
    taskStore.add({ id: b, subject: 'routes', status: 'pending', createdAt: '2024-01-01T00:00:02Z' });
    taskStore.add({ id: owned, subject: 'taken', status: 'pending', owner: 'someone', createdAt: '2024-01-01T00:00:03Z' });

    const ids = taskStore.scanUnclaimed().map((t) => t.id);
    assert.deepStrictEqual(ids, [a, b], 'oldest-first, owned task excluded');
  });

  test('excludes tasks whose dependencies are not yet completed', () => {
    const dep = freshId();
    const blocked = freshId();
    taskStore.add({ id: dep, subject: 'foundation', status: 'pending' });
    taskStore.add({ id: blocked, subject: 'roof', status: 'pending', blockedBy: [dep] });

    let ids = taskStore.scanUnclaimed().map((t) => t.id);
    assert.ok(ids.includes(dep));
    assert.ok(!ids.includes(blocked), 'blocked task must not be claimable yet');

    // Complete the dependency -> the blocked task becomes claimable.
    taskStore.update(dep, { status: 'in_progress' });
    taskStore.update(dep, { status: 'completed' });
    ids = taskStore.scanUnclaimed().map((t) => t.id);
    assert.ok(ids.includes(blocked), 'roof claimable once foundation is done');
  });
});

describe('s17 — _taskStore.claimNext', () => {
  test('claims the oldest available task and sets owner + in_progress', () => {
    const a = freshId();
    const b = freshId();
    taskStore.add({ id: a, subject: 'first', status: 'pending', createdAt: '2024-01-01T00:00:01Z' });
    taskStore.add({ id: b, subject: 'second', status: 'pending', createdAt: '2024-01-01T00:00:02Z' });

    const res = taskStore.claimNext('alice');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.task.id, a);
    assert.strictEqual(res.task.owner, 'alice');
    assert.strictEqual(taskStore.get(a).status, 'in_progress');
  });

  test('two workers claim two different tasks, never the same one', () => {
    const a = freshId();
    const b = freshId();
    taskStore.add({ id: a, subject: 'first', status: 'pending', createdAt: '2024-01-01T00:00:01Z' });
    taskStore.add({ id: b, subject: 'second', status: 'pending', createdAt: '2024-01-01T00:00:02Z' });

    const r1 = taskStore.claimNext('alice');
    const r2 = taskStore.claimNext('bob');
    assert.strictEqual(r1.task.id, a);
    assert.strictEqual(r2.task.id, b);
    assert.notStrictEqual(r1.task.id, r2.task.id);
  });

  test('returns none_available when the board has no claimable task', () => {
    const dep = freshId();
    const blocked = freshId();
    taskStore.add({ id: dep, subject: 'dep', status: 'pending' });
    taskStore.add({ id: blocked, subject: 'blocked', status: 'pending', blockedBy: [dep] });
    taskStore.claimNext('alice'); // takes dep
    const res = taskStore.claimNext('bob'); // blocked is not startable
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'none_available');
  });
});

describe('s17 — teammateBus.autonomousPoll', () => {
  function spawn(name) {
    bus.setTeammateRunner(() => new Promise(() => {})); // never resolves
    return bus.createTeammate({ name, task: 'work the board' });
  }

  test('empty inbox + claimable task -> claims it for the teammate', () => {
    const t = spawn('alice');
    const task = freshId();
    taskStore.add({ id: task, subject: 'db schema', status: 'pending' });

    const res = bus.autonomousPoll(t.id);
    assert.strictEqual(res.action, 'claimed');
    assert.strictEqual(res.task.id, task);
    assert.strictEqual(res.task.owner, t.id, 'claimed under the teammate id');
  });

  test('empty inbox + empty board -> idle', () => {
    const t = spawn('bob');
    assert.strictEqual(bus.autonomousPoll(t.id).action, 'idle');
  });

  test('a shutdown_request takes priority over the board and never claims', () => {
    const t = spawn('carol');
    const task = freshId();
    taskStore.add({ id: task, subject: 'work', status: 'pending' });
    bus.requestShutdown(t.id);

    const res = bus.autonomousPoll(t.id);
    assert.strictEqual(res.action, 'shutdown');
    // The task must remain unclaimed — shutdown short-circuited the board scan.
    assert.strictEqual(taskStore.get(task).owner, null);
  });

  test('a regular inbox message takes priority over the board', () => {
    const t = spawn('dave');
    const task = freshId();
    taskStore.add({ id: task, subject: 'work', status: 'pending' });
    bus.sendToTeammate(t.id, 'change of plans');

    const res = bus.autonomousPoll(t.id);
    assert.strictEqual(res.action, 'message');
    assert.strictEqual(res.messages[0].message, 'change of plans');
    assert.strictEqual(taskStore.get(task).owner, null, 'board untouched while a message is pending');
  });

  test('two teammates polling the same board self-distribute the tasks', () => {
    const a = spawn('alice');
    const b = spawn('bob');
    const t1 = freshId();
    const t2 = freshId();
    taskStore.add({ id: t1, subject: 'one', status: 'pending', createdAt: '2024-01-01T00:00:01Z' });
    taskStore.add({ id: t2, subject: 'two', status: 'pending', createdAt: '2024-01-01T00:00:02Z' });

    const ra = bus.autonomousPoll(a.id);
    const rb = bus.autonomousPoll(b.id);
    assert.strictEqual(ra.action, 'claimed');
    assert.strictEqual(rb.action, 'claimed');
    assert.notStrictEqual(ra.task.id, rb.task.id, 'no double-claim');
    assert.strictEqual(taskStore.get(ra.task.id).owner, a.id);
    assert.strictEqual(taskStore.get(rb.task.id).owner, b.id);
  });
});
