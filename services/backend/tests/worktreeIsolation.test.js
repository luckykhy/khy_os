'use strict';

/**
 * Tests for the s18 fix: worktree isolation �?binding a task to its own git
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

describe('s18 �?validateName path-traversal hardening', () => {
  test('accepts normal and nested names', () => {
    for (const ok of ['feature-login', 'a.b_c-1', 'feature/login', wt.generateWorktreeName()]) {
      expect(wt.validateName(ok)).toBe(true);
    }
  });

  test('rejects traversal, empty segments, and illegal input', () => {
    for (const bad of ['', '.', '..', '../etc', 'a/../b', 'a//b', 'foo bar', null, 'x'.repeat(65)]) {
      expect(wt.validateName(bad)).toBe(false);
    }
  });
});

describe('s18 �?_taskStore.bindWorktree (binding never changes status)', () => {
  test('writes the worktree field and leaves status pending', () => {
    const id = freshId();
    taskStore.add({ id, subject: 'refactor auth', status: 'pending' });

    const r = taskStore.bindWorktree(id, 'auth-refactor');
    expect(r.ok).toBe(true);
    expect(r.task.worktree).toBe('auth-refactor');
    expect(r.task.status).toBe('pending');
    expect(taskStore.get(id).status).toBe('pending');
    expect(taskStore.get(id).worktree).toBe('auth-refactor');
  });

  test('rejects a path-traversal worktree name', () => {
    const id = freshId();
    taskStore.add({ id, subject: 's', status: 'pending' });
    const r = taskStore.bindWorktree(id, '../escape');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_name');
    expect(taskStore.get(id).worktree).toBe(null);
  });

  test('reports not_found for an unknown task', () => {
    const r = taskStore.bindWorktree('no-such-task', 'wt');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_found');
  });

  test('a bound task is still claimable through the normal board flow', () => {
    const id = freshId();
    taskStore.add({ id, subject: 'iso work', status: 'pending' });
    taskStore.bindWorktree(id, 'iso-1');
    const res = taskStore.claimNext('alice');
    expect(res.ok).toBe(true);
    expect(res.task.id).toBe(id);
    expect(res.task.worktree).toBe('iso-1');
    expect(res.task.status).toBe('in_progress');
  });
});

describe('s18 �?teammateBus.autonomousPoll cwd-switch bridge', () => {
  test('claiming a worktree-bound task surfaces its absolute path', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'wt-worker', task: 'work the board' });
    const id = freshId();
    taskStore.add({ id, subject: 'isolated', status: 'pending' });
    taskStore.bindWorktree(id, 'd-bridge');

    const res = bus.autonomousPoll(t.id);
    expect(res.action).toBe('claimed');
    expect(res.task.worktree).toBe('d-bridge');
    expect(res.worktreePath).toBeTruthy();
    expect(path.isAbsolute(res.worktreePath)).toBeTruthy();
    expect(res.worktreePath.endsWith(path.join('.khy', 'worktrees', 'd-bridge'))).toBeTruthy();
  });

  test('an unbound task yields no worktree path', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'plain', task: 'work' });
    const id = freshId();
    taskStore.add({ id, subject: 'plain task', status: 'pending' });

    const res = bus.autonomousPoll(t.id);
    expect(res.action).toBe('claimed');
    expect(res.worktreePath).toBe(undefined);
  });
});

// ── Lifecycle against a real, throwaway git repo ────────────────────────────
const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeGit = gitOk ? describe : describe.skip;

describeGit('s18 �?worktree lifecycle + events.jsonl audit (temp repo)', () => {
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
    expect(created.name).toBe('build-iso');
    expect(created.branch).toBe('khy-worktree/build-iso');
    expect(fs.existsSync(created.path)).toBeTruthy();

    // Task bound (status unchanged) via the create+bind path.
    expect(taskStore.get(taskId).worktree).toBe('build-iso');
    expect(taskStore.get(taskId).status).toBe('pending');

    const listed = wt.listWorktrees(repo).map((w) => w.path);
    expect(listed.some((p) => p.endsWith(path.join('.khy', 'worktrees', 'build-iso')))).toBeTruthy();

    const events = wt.readEvents(repo);
    const createEvt = events.find((e) => e.type === 'create' && e.worktree === 'build-iso');
    expect(createEvt).toBeTruthy();
    expect(createEvt.taskId).toBe(taskId);

    // cleanup
    wt.removeWorktree(created.path, { force: true });
  });

  test('remove refuses while there are uncommitted changes, force overrides', () => {
    const created = wt.createWorktree({ name: 'dirty-wt', cwd: repo });
    fs.writeFileSync(path.join(created.path, 'scratch.txt'), 'wip\n');

    const refused = wt.removeWorktree(created.path);
    expect(refused.removed).toBe(false);
    expect(Array.isArray(refused.uncommittedChanges) && refused.uncommittedChanges.length > 0).toBeTruthy();
    expect(fs.existsSync(created.path)).toBeTruthy();

    const forced = wt.removeWorktree(created.path, { force: true });
    expect(forced.removed).toBe(true);
    expect(!fs.existsSync(created.path)).toBeTruthy();

    const events = wt.readEvents(repo);
    expect(events.some((e) => e.type === 'remove' && e.worktree === 'dirty-wt')).toBeTruthy();
  });

  test('keepWorktree leaves the tree intact and logs a keep event', () => {
    const created = wt.createWorktree({ name: 'keep-wt', cwd: repo });
    const kept = wt.keepWorktree('keep-wt', { cwd: repo });
    expect(kept.kept).toBe(true);
    expect(kept.branch).toBe('khy-worktree/keep-wt');
    expect(fs.existsSync(created.path)).toBeTruthy();

    expect(wt.readEvents(repo).some((e) => e.type === 'keep' && e.worktree === 'keep-wt')).toBeTruthy();

    wt.removeWorktree(created.path, { force: true });
  });

  test('createWorktree rejects a path-traversal name before touching git', () => {
    expect(() => wt.createWorktree({ name: '../escape', cwd: repo })).toThrow();
  });
});

