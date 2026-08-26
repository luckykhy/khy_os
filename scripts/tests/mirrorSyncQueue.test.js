'use strict';

/**
 * mirrorSyncQueue.test.js — 镜像补推队列纯函数的契约测试。
 *
 * 守的是三件真实会出错的事：
 *   1. 断网 / 令牌过期 / 远端领先必须被分成不同的种类（决定「能否自动重试」）；
 *   2. 写盘前令牌必须被抹掉（git 报错会回显内联凭据的远端 URL）；
 *   3. 队列按 (remote, branch) 去重且累加 attempts，成功即清账（否则永远补推不完）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const queue = require('../lib/mirrorSyncQueue.js');

test('classifyPushFailure: 断网归为可自动重试的 network', () => {
  const samples = [
    'fatal: unable to access https://github.com/o/r.git/: Could not resolve host: github.com',
    'fatal: unable to access https://gitee.com/o/r.git/: Failed to connect to gitee.com port 443',
    'ssh: connect to host gitee.com port 22: Connection timed out',
    'error: RPC failed; curl 56 Recv failure: Connection reset by peer',
    'fatal: the remote end hung up unexpectedly',
  ];
  for (const sample of samples) {
    const verdict = queue.classifyPushFailure(sample);
    assert.equal(verdict.kind, queue.KIND_NETWORK, sample);
    assert.equal(verdict.retryable, true);
  }
});

test('classifyPushFailure: 令牌类失败归为 auth 并给出更新令牌的指引', () => {
  const samples = [
    'remote: Invalid username or password.\nfatal: Authentication failed for https://gitee.com/o/r.git/',
    'fatal: could not read Username for https://github.com: terminal prompts disabled',
    'remote: Permission to o/r.git denied to someone.\nfatal: unable to access: The requested URL returned error: 403',
    'remote: Support for password authentication was removed.',
    'remote: Repository not found.',
  ];
  for (const sample of samples) {
    const verdict = queue.classifyPushFailure(sample);
    assert.equal(verdict.kind, queue.KIND_AUTH, sample);
    assert.equal(verdict.retryable, true);
    assert.match(verdict.hint, /sync:mirrors:retry/);
  }
});

test('classifyPushFailure: 远端领先归为 diverged 且不自动重放', () => {
  const verdict = queue.classifyPushFailure(
    '! [rejected] main -> main (non-fast-forward)\nhint: Updates were rejected because the tip is behind',
  );
  assert.equal(verdict.kind, queue.KIND_DIVERGED);
  assert.equal(verdict.retryable, false);
  assert.match(verdict.hint, /rebase/);
});

test('classifyPushFailure: 认不出来的失败仍可重试，不会静默丢账', () => {
  assert.equal(queue.classifyPushFailure('fatal: something entirely new').kind, queue.KIND_UNKNOWN);
  assert.equal(queue.classifyPushFailure(undefined).kind, queue.KIND_UNKNOWN);
  assert.equal(queue.classifyPushFailure(null).retryable, true);
});

test('redactSecrets: URL 内联凭据与令牌样式串都不落盘', () => {
  const redacted = queue.redactSecrets(
    'fatal: unable to access https://user:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git/',
  );
  assert.ok(!redacted.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'));
  assert.ok(!redacted.includes('user:'));
  assert.match(redacted, /https:\/\/\*\*\*:\*\*\*@github\.com/);
  assert.equal(queue.redactSecrets(undefined), '');
});

test('upsertEntry: 同一 (远端, 分支) 只留一条并累加 attempts', () => {
  let state = queue.upsertEntry(null, {
    remote: 'gitee',
    branch: 'main',
    commit: 'aaa',
    kind: queue.KIND_NETWORK,
    message: 'Could not resolve host: gitee.com',
    at: '2026-08-24T01:00:00.000Z',
  });
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].attempts, 1);

  state = queue.upsertEntry(state, {
    remote: 'gitee',
    branch: 'main',
    commit: 'bbb',
    kind: queue.KIND_AUTH,
    message: 'Authentication failed',
    at: '2026-08-24T02:00:00.000Z',
  });
  assert.equal(state.entries.length, 1);
  const entry = state.entries[0];
  assert.equal(entry.attempts, 2);
  assert.equal(entry.kind, queue.KIND_AUTH, '种类刷新为最近一次失败');
  assert.equal(entry.commit, 'bbb');
  assert.equal(entry.firstFailedAt, '2026-08-24T01:00:00.000Z', '首次失败时间不被覆盖');
  assert.equal(entry.lastAttemptAt, '2026-08-24T02:00:00.000Z');
});

test('upsertEntry: 不同分支各记一条，缺字段的失败被忽略', () => {
  let state = queue.upsertEntry(null, { remote: 'gitee', branch: 'main', at: 'x' });
  state = queue.upsertEntry(state, { remote: 'gitee', branch: 'dev', at: 'x' });
  state = queue.upsertEntry(state, { remote: '', branch: 'dev', at: 'x' });
  assert.equal(state.entries.length, 2);
});

test('removeEntry: 推成功即清账，清不存在的条目不报错', () => {
  const state = queue.upsertEntry(null, { remote: 'origin', branch: 'main', at: 'x' });
  const cleared = queue.removeEntry(state, { remote: 'origin', branch: 'main' });
  assert.equal(cleared.entries.length, 0);
  assert.equal(queue.removeEntry(cleared, { remote: 'nope', branch: 'main' }).entries.length, 0);
});

test('normalizeQueue: 磁盘上的坏数据收敛成合法队列且顺手抹除令牌', () => {
  const state = queue.normalizeQueue({
    entries: [
      { remote: 'gitee', branch: 'main', attempts: 'abc', kind: 'nonsense' },
      { remote: 'gitee', branch: 'main' },
      { branch: 'orphan' },
      'garbage',
      { remote: 'origin', branch: 'main', lastError: 'https://u:glpat-abcdefghijklmnopqrst@gitee.com' },
    ],
  });
  assert.equal(state.version, queue.QUEUE_VERSION);
  assert.equal(state.entries.length, 2, '重复主键去重、残缺条目丢弃');
  assert.equal(state.entries[0].attempts, 1);
  assert.equal(state.entries[0].kind, queue.KIND_UNKNOWN);
  assert.ok(!state.entries[1].lastError.includes('glpat-abcdefghijklmnopqrst'));
  assert.equal(queue.normalizeQueue(null).entries.length, 0);
});

test('planWork: 队列欠账排在本次目标之前，同一目标不推两次', () => {
  const state = queue.upsertEntry(null, {
    remote: 'gitee',
    branch: 'main',
    kind: queue.KIND_NETWORK,
    at: 'x',
  });
  const plan = queue.planWork({
    queue: state,
    targets: [{ remote: 'gitee', branch: 'main' }, { remote: 'origin', branch: 'main' }],
  });
  assert.deepEqual(
    plan.work.map(item => `${item.remote}/${item.branch}:${item.reason}`),
    ['gitee/main:queued', 'origin/main:current'],
  );
  assert.equal(plan.held.length, 0);
});

test('planWork: diverged 默认只上报，--force 才重放', () => {
  const state = queue.upsertEntry(null, {
    remote: 'origin',
    branch: 'main',
    commit: 'aaa',
    kind: queue.KIND_DIVERGED,
    at: 'x',
  });
  const held = queue.planWork({ queue: state, targets: [] });
  assert.equal(held.work.length, 0);
  assert.equal(held.held.length, 1);

  const forced = queue.planWork({ queue: state, targets: [], force: true });
  assert.equal(forced.work.length, 1);
  assert.equal(forced.held.length, 0);
});

test('planWork: rebase 之后（本地 tip 变了）diverged 自动放行，无需 --force', () => {
  const state = queue.upsertEntry(null, {
    remote: 'origin',
    branch: 'main',
    commit: 'aaa',
    kind: queue.KIND_DIVERGED,
    at: 'x',
  });
  // tip 未变：仍然按住不放，避免刷同样的 rejected。
  assert.equal(queue.planWork({ queue: state, targets: [], tips: { main: 'aaa' } }).held.length, 1);
  // tip 变了（rebase / 新提交）：放行一次。
  const moved = queue.planWork({ queue: state, targets: [], tips: { main: 'bbb' } });
  assert.equal(moved.work.length, 1);
  assert.equal(moved.held.length, 0);
  // tip 信息缺失时保守按住，不做无依据的重放。
  assert.equal(queue.planWork({ queue: state, targets: [], tips: { other: 'bbb' } }).held.length, 1);
});

test('describeQueue: 每行都带动作、目标与进度', () => {
  const state = queue.upsertEntry(null, {
    remote: 'gitee',
    branch: 'main',
    kind: queue.KIND_AUTH,
    at: '2026-08-24T01:00:00.000Z',
  });
  const lines = queue.describeQueue(state);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[1\/1\]/);
  assert.match(lines[0], /gitee\/main/);
  assert.match(lines[0], /已尝试 1 次/);
  assert.deepEqual(queue.describeQueue(null), []);
});
