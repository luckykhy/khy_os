'use strict';

/**
 * Tests for the s12 fix: dependency-gated task starts on the AI-facing task
 * surface (_taskStore.canStart + TaskUpdate / _taskStore.update enforcement).
 *
 * Before this fix the model-facing Task tools stored `blockedBy` edges but never
 * enforced them — a task could be moved to in_progress while its upstream
 * dependencies were still pending, defeating the whole point of a task graph
 * (s12: "you can't build the roof before laying the foundation"). The fix adds a
 * `can_start`-style gate: a task may only start once every task in its
 * `blockedBy` list has completed; missing or self-referential deps count as
 * permanent blockers.
 */

const assert = require('assert');

const taskStore = require('../src/tools/_taskStore');
const TaskUpdate = require('../src/tools/TaskUpdateTool');

function freshId() {
  return 't-s12-' + (freshId._n = (freshId._n || 0) + 1);
}

describe('s12 — task dependency gate', () => {
  afterEach(() => { try { taskStore.clear(); } catch { /* ignore */ } });

  describe('_taskStore.canStart', () => {
    test('no dependencies ⇒ startable', () => {
      const id = freshId();
      taskStore.add({ id, subject: 'root', status: 'pending' });
      assert.deepStrictEqual(taskStore.canStart(id), { ok: true, blockers: [] });
    });

    test('pending dependency ⇒ blocked', () => {
      const dep = freshId();
      const id = freshId();
      taskStore.add({ id: dep, subject: 'schema', status: 'pending' });
      taskStore.add({ id, subject: 'endpoints', status: 'pending', blockedBy: [dep] });

      const gate = taskStore.canStart(id);
      assert.strictEqual(gate.ok, false);
      assert.deepStrictEqual(gate.blockers, [dep]);
    });

    test('completed dependency ⇒ startable', () => {
      const dep = freshId();
      const id = freshId();
      taskStore.add({ id: dep, subject: 'schema', status: 'pending' });
      taskStore.add({ id, subject: 'endpoints', status: 'pending', blockedBy: [dep] });
      taskStore.update(dep, { status: 'in_progress' });
      taskStore.update(dep, { status: 'completed' });

      assert.deepStrictEqual(taskStore.canStart(id), { ok: true, blockers: [] });
    });

    test('missing dependency ID is treated as a blocker', () => {
      const id = freshId();
      taskStore.add({ id, subject: 'endpoints', status: 'pending', blockedBy: ['t-does-not-exist'] });
      const gate = taskStore.canStart(id);
      assert.strictEqual(gate.ok, false);
      assert.deepStrictEqual(gate.blockers, ['t-does-not-exist']);
    });

    test('self-dependency is a permanent blocker', () => {
      const id = freshId();
      taskStore.add({ id, subject: 'loop', status: 'pending', blockedBy: [id] });
      const gate = taskStore.canStart(id);
      assert.strictEqual(gate.ok, false);
      assert.deepStrictEqual(gate.blockers, [id]);
    });

    test('reports only the still-incomplete subset of multiple deps', () => {
      const a = freshId();
      const b = freshId();
      const id = freshId();
      taskStore.add({ id: a, subject: 'a', status: 'pending' });
      taskStore.add({ id: b, subject: 'b', status: 'pending' });
      taskStore.add({ id, subject: 'c', status: 'pending', blockedBy: [a, b] });
      taskStore.update(a, { status: 'in_progress' });
      taskStore.update(a, { status: 'completed' });

      const gate = taskStore.canStart(id);
      assert.strictEqual(gate.ok, false);
      assert.deepStrictEqual(gate.blockers, [b]); // a done, b still pending
    });
  });

  describe('_taskStore.update enforcement', () => {
    test('throws when starting a blocked task', () => {
      const dep = freshId();
      const id = freshId();
      taskStore.add({ id: dep, subject: 'schema', status: 'pending' });
      taskStore.add({ id, subject: 'endpoints', status: 'pending', blockedBy: [dep] });

      assert.throws(() => taskStore.update(id, { status: 'in_progress' }),
        /blocked by incomplete dependencies/i);
    });

    test('allows starting once the blocker completes', () => {
      const dep = freshId();
      const id = freshId();
      taskStore.add({ id: dep, subject: 'schema', status: 'pending' });
      taskStore.add({ id, subject: 'endpoints', status: 'pending', blockedBy: [dep] });
      taskStore.update(dep, { status: 'in_progress' });
      taskStore.update(dep, { status: 'completed' });

      const updated = taskStore.update(id, { status: 'in_progress' });
      assert.strictEqual(updated.status, 'in_progress');
    });

    test('unblocked tasks (no deps) start normally — no regression', () => {
      const id = freshId();
      taskStore.add({ id, subject: 'standalone', status: 'pending' });
      const updated = taskStore.update(id, { status: 'in_progress' });
      assert.strictEqual(updated.status, 'in_progress');
    });
  });

  describe('TaskUpdate tool surface', () => {
    test('returns a structured rejection (not a throw) for a blocked start', async () => {
      const dep = freshId();
      const id = freshId();
      taskStore.add({ id: dep, subject: 'schema', status: 'pending' });
      taskStore.add({ id, subject: 'endpoints', status: 'pending', blockedBy: [dep] });

      const res = await TaskUpdate.execute({ id, status: 'in_progress' });
      assert.strictEqual(res.success, false);
      assert.deepStrictEqual(res.blockedBy, [dep]);
    });

    test('completing a blocker unblocks downstream and reports it', async () => {
      const dep = freshId();
      const id = freshId();
      // dep declares it blocks `id`; id declares it is blockedBy dep.
      taskStore.add({ id: dep, subject: 'schema', status: 'pending', blocks: [id] });
      taskStore.add({ id, subject: 'endpoints', status: 'pending', blockedBy: [dep] });

      await TaskUpdate.execute({ id: dep, status: 'in_progress' });
      const res = await TaskUpdate.execute({ id: dep, status: 'completed' });
      assert.strictEqual(res.success, true);
      assert.ok(Array.isArray(res.unblocked) && res.unblocked.includes(id),
        `expected ${id} reported as unblocked, got: ${JSON.stringify(res.unblocked)}`);

      // And now the downstream task can actually start.
      const start = await TaskUpdate.execute({ id, status: 'in_progress' });
      assert.strictEqual(start.success, true);
    });

    test('idempotent in_progress update on an already-running task is not re-gated', async () => {
      // A self-blocked task would normally be unstartable, but if it is somehow
      // already running, an activeForm-only refresh must not be rejected.
      const id = freshId();
      taskStore.add({ id, subject: 'work', status: 'pending' });
      taskStore.update(id, { status: 'in_progress' });
      const res = await TaskUpdate.execute({ id, status: 'in_progress', activeForm: 'Working hard' });
      assert.strictEqual(res.success, true);
    });
  });
});

describe('s12 — ownership & claim/release', () => {
  afterEach(() => { try { taskStore.clear(); } catch { /* ignore */ } });

  describe('owner DTO surfacing', () => {
    test('owner round-trips through add and is exposed by get', () => {
      const id = freshId();
      taskStore.add({ id, subject: 'root', status: 'pending', owner: 'alice' });
      assert.strictEqual(taskStore.get(id).owner, 'alice');
    });

    test('owner defaults to null and is settable / clearable via update', () => {
      const id = freshId();
      taskStore.add({ id, subject: 'root', status: 'pending' });
      assert.strictEqual(taskStore.get(id).owner, null);
      taskStore.update(id, { owner: 'bob' });
      assert.strictEqual(taskStore.get(id).owner, 'bob');
      taskStore.update(id, { owner: null });
      assert.strictEqual(taskStore.get(id).owner, null);
    });
  });

  describe('_taskStore.claim', () => {
    test('claims a free task: sets owner + moves to in_progress', () => {
      const id = freshId();
      taskStore.add({ id, subject: 'root', status: 'pending' });
      const res = taskStore.claim(id, 'alice');
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.owner, 'alice');
      assert.strictEqual(res.task.status, 'in_progress');
      assert.strictEqual(taskStore.get(id).owner, 'alice');
    });

    test('rejects a claim held by a different owner (already_claimed)', () => {
      const id = freshId();
      taskStore.add({ id, subject: 'root', status: 'pending' });
      taskStore.claim(id, 'alice');
      const res = taskStore.claim(id, 'bob');
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.reason, 'already_claimed');
      assert.strictEqual(res.owner, 'alice');
    });

    test('re-claim by the same owner is idempotent', () => {
      const id = freshId();
      taskStore.add({ id, subject: 'root', status: 'pending' });
      taskStore.claim(id, 'alice');
      const res = taskStore.claim(id, 'alice');
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.owner, 'alice');
    });

    test('rejects claiming a blocked task (reason=blocked, lists blockers)', () => {
      const dep = freshId();
      const id = freshId();
      taskStore.add({ id: dep, subject: 'schema', status: 'pending' });
      taskStore.add({ id, subject: 'endpoints', status: 'pending', blockedBy: [dep] });
      const res = taskStore.claim(id, 'alice');
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.reason, 'blocked');
      assert.deepStrictEqual(res.blockers, [dep]);
      assert.strictEqual(taskStore.get(id).owner, null); // not claimed
    });

    test('rejects claiming a completed task (already_resolved)', () => {
      const id = freshId();
      taskStore.add({ id, subject: 'root', status: 'pending' });
      taskStore.update(id, { status: 'in_progress' });
      taskStore.update(id, { status: 'completed' });
      const res = taskStore.claim(id, 'alice');
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.reason, 'already_resolved');
    });

    test('not_found for an unknown task', () => {
      assert.deepStrictEqual(taskStore.claim('t-nope', 'alice'), { ok: false, reason: 'not_found' });
    });
  });

  describe('_taskStore.release (multi-agent recovery)', () => {
    test('clears owner so another agent can reclaim', () => {
      const id = freshId();
      taskStore.add({ id, subject: 'root', status: 'pending' });
      taskStore.claim(id, 'alice');
      const rel = taskStore.release(id);
      assert.strictEqual(rel.ok, true);
      assert.strictEqual(taskStore.get(id).owner, null);
      // bob can now reclaim the (still in_progress, unowned) task
      const res = taskStore.claim(id, 'bob');
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.owner, 'bob');
    });

    test('expectedOwner mismatch is a no-op rejection', () => {
      const id = freshId();
      taskStore.add({ id, subject: 'root', status: 'pending' });
      taskStore.claim(id, 'alice');
      const rel = taskStore.release(id, 'bob');
      assert.strictEqual(rel.ok, false);
      assert.strictEqual(rel.reason, 'owner_mismatch');
      assert.strictEqual(taskStore.get(id).owner, 'alice'); // untouched
    });
  });

  describe('TaskUpdate owner surface', () => {
    test('claims by setting owner', async () => {
      const id = freshId();
      taskStore.add({ id, subject: 'root', status: 'pending' });
      const res = await TaskUpdate.execute({ id, owner: 'alice' });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.task.owner, 'alice');
    });

    test('rejects reassigning a task another owner already holds', async () => {
      const id = freshId();
      taskStore.add({ id, subject: 'root', status: 'pending', owner: 'alice' });
      const res = await TaskUpdate.execute({ id, owner: 'bob' });
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.owner, 'alice');
    });

    test('empty-string owner releases ownership', async () => {
      const id = freshId();
      taskStore.add({ id, subject: 'root', status: 'pending', owner: 'alice' });
      const res = await TaskUpdate.execute({ id, owner: '' });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.task.owner, null);
    });
  });
});

