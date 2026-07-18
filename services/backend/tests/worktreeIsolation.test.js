'use strict';

/**
 * Tests for the s18 fix: worktree isolation — binding a task to its own git
 * worktree so parallel teammates work in separate directories, never clobbering
 * the same file.
 *
 * What this fix adds on top of the existing worktreeManager:
 *   - _taskStore: a `worktree` field + bindWorktree() that records "where" a
 *     task runs WITHOUT changing its status (the s18 binding invariant).
 *   - worktreeManager.validateName: path-traversal hardening (reject '.'/'..'
 *     segments) so a bound name can never escape .khy/worktrees/.
 *   - worktreeManager events.jsonl: an auditable create/remove/keep log.
 *   - worktreeManager.keepWorktree + worktreePathFor.
 *   - teammateBus.autonomousPoll: surfaces the worktree path of a claimed,
 *     worktree-bound task (the teammate cwd-switch bridge).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const wt = require('../src/services/worktreeManager');
const taskStore = require('../src/tools/_taskStore');
const bus = require('../src/tools/teammateBus');

let _n = 0;
const freshId = () => `t-s18-${process.pid}-${(_n += 1)}`;

afterEach(() => {
  try { taskStore.clear(); } catch { /* ignore */ }
  bus._resetForTest();
});

describe('s18 — validateName path-traversal hardening', () => {
  test('accepts normal and nested names', () => {
    for (const ok of ['feature-login', 'a.b_c-1', 'feature/login', wt.generateWorktreeName()]) {
      assert.strictEqual(wt.validateName(ok), true, `should accept ${ok}`);
    }
  });

  test('rejects traversal, empty segments, and illegal input', () => {
    for (const bad of ['', '.', '..', '../etc', 'a/../b', 'a//b', 'foo bar', null, 'x'.repeat(65)]) {
      assert.strictEqual(wt.validateName(bad), false, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('s18 — _taskStore.bindWorktree (binding never changes status)', () => {
  test('writes the worktree field and leaves status pending', () => {
    const id = freshId();
    taskStore.add({ id, subject: 'refactor auth', status: 'pending' });

    const r = taskStore.bindWorktree(id, 'auth-refactor');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.task.worktree, 'auth-refactor');
    assert.strictEqual(r.task.status, 'pending', 'binding must not advance status');
    assert.strictEqual(taskStore.get(id).status, 'pending');
    assert.strictEqual(taskStore.get(id).worktree, 'auth-refactor');
  });

  test('rejects a path-traversal worktree name', () => {
    const id = freshId();
    taskStore.add({ id, subject: 's', status: 'pending' });
    const r = taskStore.bindWorktree(id, '../escape');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'invalid_name');
    assert.strictEqual(taskStore.get(id).worktree, null, 'bad name never persisted');
  });

  test('reports not_found for an unknown task', () => {
    const r = taskStore.bindWorktree('no-such-task', 'wt');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not_found');
  });

  test('a bound task is still claimable through the normal board flow', () => {
    const id = freshId();
    taskStore.add({ id, subject: 'iso work', status: 'pending' });
    taskStore.bindWorktree(id, 'iso-1');
    const res = taskStore.claimNext('alice');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.task.id, id);
    assert.strictEqual(res.task.worktree, 'iso-1', 'binding survives the claim');
    assert.strictEqual(res.task.status, 'in_progress');
  });
});

describe('s18 — teammateBus.autonomousPoll cwd-switch bridge', () => {
  test('claiming a worktree-bound task surfaces its absolute path', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'wt-worker', task: 'work the board' });
    const id = freshId();
    taskStore.add({ id, subject: 'isolated', status: 'pending' });
    taskStore.bindWorktree(id, 'd-bridge');

    const res = bus.autonomousPoll(t.id);
    assert.strictEqual(res.action, 'claimed');
    assert.strictEqual(res.task.worktree, 'd-bridge');
    assert.ok(res.worktreePath, 'a worktree-bound task yields a path');
    assert.ok(path.isAbsolute(res.worktreePath));
    assert.ok(res.worktreePath.endsWith(path.join('.khy', 'worktrees', 'd-bridge')));
  });

  test('an unbound task yields no worktree path', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'plain', task: 'work' });
    const id = freshId();
    taskStore.add({ id, subject: 'plain task', status: 'pending' });

    const res = bus.autonomousPoll(t.id);
    assert.strictEqual(res.action, 'claimed');
    assert.strictEqual(res.worktreePath, undefined);
  });
});

// ── Lifecycle against a real, throwaway git repo ────────────────────────────
const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeGit = gitOk ? describe : describe.skip;

describeGit('s18 — worktree lifecycle + events.jsonl audit (temp repo)', () => {
  let repo;

  const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wt-'));
    git(['init', '-q']);
    git(['config', 'user.email', 'test@khy.local']);
    git(['config', 'user.name', 'khy-test']);
    git(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# tmp\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'init']);
  });

  afterAll(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('create binds the task, logs a create event, and lists the worktree', () => {
    const taskId = freshId();
    taskStore.add({ id: taskId, subject: 'isolated build', status: 'pending' });

    const created = wt.createWorktree({ name: 'build-iso', cwd: repo, taskId });
    assert.strictEqual(created.name, 'build-iso');
    assert.strictEqual(created.branch, 'khy-worktree/build-iso');
    assert.ok(fs.existsSync(created.path));

    // Task bound (status unchanged) via the create+bind path.
    assert.strictEqual(taskStore.get(taskId).worktree, 'build-iso');
    assert.strictEqual(taskStore.get(taskId).status, 'pending');

    const listed = wt.listWorktrees(repo).map((w) => w.path);
    assert.ok(listed.some((p) => p.endsWith(path.join('.khy', 'worktrees', 'build-iso'))));

    const events = wt.readEvents(repo);
    const createEvt = events.find((e) => e.type === 'create' && e.worktree === 'build-iso');
    assert.ok(createEvt, 'a create event was logged');
    assert.strictEqual(createEvt.taskId, taskId);

    // cleanup
    wt.removeWorktree(created.path, { force: true });
  });

  test('remove refuses while there are uncommitted changes, force overrides', () => {
    const created = wt.createWorktree({ name: 'dirty-wt', cwd: repo });
    fs.writeFileSync(path.join(created.path, 'scratch.txt'), 'wip\n');

    const refused = wt.removeWorktree(created.path);
    assert.strictEqual(refused.removed, false);
    assert.ok(Array.isArray(refused.uncommittedChanges) && refused.uncommittedChanges.length > 0);
    assert.ok(fs.existsSync(created.path), 'worktree preserved on refusal');

    const forced = wt.removeWorktree(created.path, { force: true });
    assert.strictEqual(forced.removed, true);
    assert.ok(!fs.existsSync(created.path));

    const events = wt.readEvents(repo);
    assert.ok(events.some((e) => e.type === 'remove' && e.worktree === 'dirty-wt'));
  });

  test('keepWorktree leaves the tree intact and logs a keep event', () => {
    const created = wt.createWorktree({ name: 'keep-wt', cwd: repo });
    const kept = wt.keepWorktree('keep-wt', { cwd: repo });
    assert.strictEqual(kept.kept, true);
    assert.strictEqual(kept.branch, 'khy-worktree/keep-wt');
    assert.ok(fs.existsSync(created.path), 'keep does not remove the worktree');

    assert.ok(wt.readEvents(repo).some((e) => e.type === 'keep' && e.worktree === 'keep-wt'));

    wt.removeWorktree(created.path, { force: true });
  });

  test('createWorktree rejects a path-traversal name before touching git', () => {
    assert.throws(() => wt.createWorktree({ name: '../escape', cwd: repo }), /Invalid worktree name/);
  });
});
