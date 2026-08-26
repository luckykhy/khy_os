'use strict';

/**
 * mergeSnapshot 回归测试:跨进程共享注册表的并集语义。
 *
 * restore() 是「清空后重建」,只适合单实例重启;多实例并发时清空会把本进程正活着的
 * 会话抹掉。mergeSnapshot() 只做并集,这里守住四条事实:
 *   1. peer 的会话与订阅被纳入,subscribersOf 能看见其他实例的订阅者;
 *   2. 同 sessionId 冲突时按 lastSeen 取新,但**本实例自己的会话以内存为准**;
 *   3. 租约冲突按 expiresAt 取晚者,过期的外部租约直接丢弃;
 *   4. 坏快照返回结构化错误,绝不抛。
 */

const registryModule = require('../session_registry');

function harness(opts = {}) {
  const clock = { t: 1_000_000 };
  const registry = registryModule.createRegistry({
    now: () => clock.t,
    leaseTtlMs: 1000,
    sessionIdleMs: 5000,
    ...opts,
  });

  return { clock, registry };
}

// 造一份「另一实例」的快照:开一个独立注册表填数据,再 snapshot 出来。
function peerSnapshot(build, opts = {}) {
  const { clock, registry } = harness(opts);

  build({ clock, registry });

  const snap = registry.snapshot();

  expect(snap.ok).toBe(true);

  return snap.value;
}

describe('mergeSnapshot:并集而非覆盖', () => {
  test('peer 的会话与订阅被纳入,本地已有会话不被清空', () => {
    const { registry } = harness();

    registry.registerSession({ sessionId: 'local-1', editorId: 'alice', instanceId: 'A' });
    registry.subscribe('local-1', ['docs/a.md']);

    const snap = peerSnapshot(({ registry: peer }) => {
      peer.registerSession({ sessionId: 'peer-1', editorId: 'bob', instanceId: 'B' });
      peer.subscribe('peer-1', ['docs/a.md', 'docs/b.md']);
    });

    const merged = registry.mergeSnapshot(snap, { ownInstanceId: 'A' });

    expect(merged.ok).toBe(true);
    expect(merged.value.sessionsAdded).toBe(1);

    // 本地会话仍在,peer 会话也在。
    expect(registry.stats().value.sessions).toBe(2);

    // 关键收益:扇出时能看见 peer 实例的订阅者。
    expect(registry.subscribersOf('docs/a.md').value).toEqual(['local-1', 'peer-1']);
    expect(registry.subscribersOf('docs/b.md').value).toEqual(['peer-1']);
  });

  test('同 sessionId 冲突:lastSeen 更新的一份胜出', () => {
    const { clock, registry } = harness();

    registry.registerSession({ sessionId: 'dup', editorId: 'old-name', instanceId: 'A' });

    // peer 的副本更新(时钟更靠后),且改了 editorId。
    const snap = peerSnapshot(({ clock: peerClock, registry: peer }) => {
      peerClock.t = 1_009_000;
      peer.registerSession({ sessionId: 'dup', editorId: 'new-name', instanceId: 'B' });
    });

    clock.t = 1_009_500;

    const merged = registry.mergeSnapshot(snap, { ownInstanceId: 'A' });

    expect(merged.ok).toBe(true);
    expect(merged.value.sessionsUpdated).toBe(1);
    expect(registry.editorOf('nope').value).toBeNull(); // 无租约回 null 而非报错
    expect(registry.subscribersOf('docs/x.md').value).toEqual([]);
  });

  test('本实例自己的会话不被快照里的旧副本回退', () => {
    const { clock, registry } = harness();

    // 快照先拍(此时 paths 为空),之后本地才订阅 —— 快照是「旧副本」。
    const snap = peerSnapshot(({ registry: peer }) => {
      peer.registerSession({ sessionId: 'mine', editorId: 'alice', instanceId: 'A' });
    });

    clock.t = 1_008_000;
    registry.registerSession({ sessionId: 'mine', editorId: 'alice', instanceId: 'A' });
    registry.subscribe('mine', ['docs/live.md']);

    const merged = registry.mergeSnapshot(snap, { ownInstanceId: 'A' });

    expect(merged.ok).toBe(true);
    expect(merged.value.sessionsUpdated).toBe(0);

    // 订阅没被旧快照抹掉 —— 这正是 restore() 会搞错、mergeSnapshot 必须守住的点。
    expect(registry.subscribersOf('docs/live.md').value).toEqual(['mine']);
  });

  test('ownInstanceId 缺省时退化为纯 lastSeen 比较(不崩)', () => {
    const { registry } = harness();

    const snap = peerSnapshot(({ registry: peer }) => {
      peer.registerSession({ sessionId: 'p', editorId: 'bob', instanceId: 'B' });
    });

    expect(registry.mergeSnapshot(snap).ok).toBe(true);
    expect(registry.stats().value.sessions).toBe(1);
  });
});

describe('mergeSnapshot:租约合并', () => {
  test('peer 的活租约被接纳,editorOf 可查到跨实例编辑者', () => {
    const { registry } = harness();

    const snap = peerSnapshot(({ registry: peer }) => {
      peer.registerSession({ sessionId: 'peer-1', editorId: 'bob', instanceId: 'B' });
      expect(peer.acquireLease({ path: 'docs/a.md', sessionId: 'peer-1' }).ok).toBe(true);
    });

    const merged = registry.mergeSnapshot(snap, { ownInstanceId: 'A' });

    expect(merged.value.leasesAdopted).toBe(1);

    const holder = registry.editorOf('docs/a.md');

    expect(holder.ok).toBe(true);
    expect(holder.value.sessionId).toBe('peer-1');
    expect(holder.value.instanceId).toBe('B');
  });

  test('本地活租约不被 expiresAt 更早的外部租约顶掉', () => {
    const { registry } = harness();

    registry.registerSession({ sessionId: 'local-1', editorId: 'alice', instanceId: 'A' });
    registry.acquireLease({ path: 'docs/a.md', sessionId: 'local-1' });

    // peer 的租约更早到期(时钟更靠前)。
    const snap = peerSnapshot(({ clock: peerClock, registry: peer }) => {
      peerClock.t = 999_500;
      peer.registerSession({ sessionId: 'peer-1', editorId: 'bob', instanceId: 'B' });
      peer.acquireLease({ path: 'docs/a.md', sessionId: 'peer-1' });
    });

    registry.mergeSnapshot(snap, { ownInstanceId: 'A' });

    expect(registry.editorOf('docs/a.md').value.sessionId).toBe('local-1');
  });

  test('已过期的外部租约直接丢弃,计入 dropped', () => {
    const { clock, registry } = harness();

    const snap = peerSnapshot(({ registry: peer }) => {
      peer.registerSession({ sessionId: 'peer-1', editorId: 'bob', instanceId: 'B' });
      peer.acquireLease({ path: 'docs/stale.md', sessionId: 'peer-1' });
    });

    // 走过 TTL(1000ms)之后才合并。
    clock.t = 1_002_000;

    const merged = registry.mergeSnapshot(snap, { ownInstanceId: 'A' });

    expect(merged.value.leasesAdopted).toBe(0);
    expect(merged.value.dropped).toBeGreaterThanOrEqual(1);
    expect(registry.editorOf('docs/stale.md').value).toBeNull();
  });
});

describe('mergeSnapshot:删除墓碑(并集表达不了「已删除」)', () => {
  test('peer 的删除墓碑驱逐我已接纳的副本,并释放其租约', () => {
    const { registry } = harness();

    const before = peerSnapshot(({ registry: peer }) => {
      peer.registerSession({ sessionId: 'peer-1', editorId: 'bob', instanceId: 'B' });
      peer.acquireLease({ path: 'docs/a.md', sessionId: 'peer-1' });
    });

    registry.mergeSnapshot(before, { ownInstanceId: 'A' });
    expect(registry.editorOf('docs/a.md').value.sessionId).toBe('peer-1');

    // peer 侧断线:新快照里带着墓碑。
    const after = peerSnapshot(({ registry: peer }) => {
      peer.registerSession({ sessionId: 'peer-1', editorId: 'bob', instanceId: 'B' });
      peer.acquireLease({ path: 'docs/a.md', sessionId: 'peer-1' });
      peer.dropSession('peer-1');
    });

    const merged = registry.mergeSnapshot(after, { ownInstanceId: 'A' });

    expect(merged.ok).toBe(true);
    expect(merged.value.sessionsRemoved).toBe(1);
    expect(registry.stats().value.sessions).toBe(0);
    // 租约随会话一起消失,否则断线的编辑者会永久占着文件。
    expect(registry.editorOf('docs/a.md').value).toBeNull();
  });

  test('墓碑挡住同一快照里的旧会话记录', () => {
    const { registry } = harness();

    const snap = peerSnapshot(({ registry: peer }) => {
      peer.registerSession({ sessionId: 'gone', editorId: 'bob', instanceId: 'B' });
      peer.dropSession('gone');
    });

    // 把已删除的会话塞回 sessions 数组,模拟第三个实例写回的旧副本。
    snap.sessions.push({
      sessionId: 'gone',
      editorId: 'bob',
      instanceId: 'C',
      lastSeen: 1_000_000,
      paths: ['docs/zombie.md'],
    });

    const merged = registry.mergeSnapshot(snap, { ownInstanceId: 'A' });

    expect(merged.ok).toBe(true);
    expect(registry.stats().value.sessions).toBe(0);
    expect(registry.subscribersOf('docs/zombie.md').value).toEqual([]);
  });

  test('墓碑之后重连的会话不被驱逐', () => {
    const { clock, registry } = harness();

    const snap = peerSnapshot(({ registry: peer }) => {
      peer.registerSession({ sessionId: 'reconnect', editorId: 'bob', instanceId: 'B' });
      peer.dropSession('reconnect');
    });

    // 墓碑打在 1_000_000,本地在之后才重连 —— 这是活着的重连,不是旧副本。
    clock.t = 1_004_000;
    registry.registerSession({ sessionId: 'reconnect', editorId: 'bob', instanceId: 'A' });
    registry.subscribe('reconnect', ['docs/live.md']);

    const merged = registry.mergeSnapshot(snap, { ownInstanceId: 'A' });

    expect(merged.value.sessionsRemoved).toBe(0);
    expect(registry.subscribersOf('docs/live.md').value).toEqual(['reconnect']);
  });

  test('会话不存在的租约不被接纳(不留无人可释放的持有者)', () => {
    const { registry } = harness();

    const merged = registry.mergeSnapshot({
      schema: registryModule.SCHEMA,
      sessions: [],
      leases: [
        { path: 'docs/orphan.md', sessionId: 'nobody', expiresAt: 1_000_900, instanceId: 'B' },
      ],
    });

    expect(merged.ok).toBe(true);
    expect(merged.value.leasesAdopted).toBe(0);
    expect(registry.editorOf('docs/orphan.md').value).toBeNull();
  });

  test('墓碑随快照外传,过了空闲窗口后被清理(不无界增长)', () => {
    const { clock, registry } = harness();

    registry.registerSession({ sessionId: 's-1', editorId: 'alice', instanceId: 'A' });
    registry.dropSession('s-1');

    expect(registry.snapshot().value.removals).toEqual([
      { sessionId: 's-1', removedAt: 1_000_000 },
    ]);

    // sessionIdleMs 是 5000:走过之后没人还持有副本,墓碑必须自己消失。
    clock.t = 1_006_000;
    registry.sweep();

    expect(registry.snapshot().value.removals).toEqual([]);
  });

  test('restore 也遵守墓碑(重启后不复活已删除会话)', () => {
    const { registry } = harness();

    const snap = peerSnapshot(({ registry: peer }) => {
      peer.registerSession({ sessionId: 'dead', editorId: 'bob', instanceId: 'B' });
      peer.acquireLease({ path: 'docs/dead.md', sessionId: 'dead' });
      peer.dropSession('dead');
    });

    snap.sessions.push({ sessionId: 'dead', instanceId: 'B', lastSeen: 1_000_000, paths: [] });
    snap.leases.push({
      path: 'docs/dead.md',
      sessionId: 'dead',
      instanceId: 'B',
      expiresAt: 1_000_900,
    });

    const restored = registry.restore(snap);

    expect(restored.ok).toBe(true);
    expect(registry.stats().value.sessions).toBe(0);
    expect(registry.editorOf('docs/dead.md').value).toBeNull();
  });
});

describe('mergeSnapshot:fail-soft 与边界', () => {
  test.each([
    ['null', null],
    ['非对象', 42],
    ['缺 schema', { sessions: [] }],
    ['schema 不匹配', { schema: 'khy-file-sync-registry/999', sessions: [] }],
  ])('%s → INVALID_SNAPSHOT,不抛', (_label, bad) => {
    const { registry } = harness();
    let result;

    expect(() => {
      result = registry.mergeSnapshot(bad);
    }).not.toThrow();

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(registryModule.CODES.INVALID_SNAPSHOT);
    expect(result.error.message).toContain(registryModule.SCHEMA);
  });

  test('脏数据(坏 sessionId / 坏 path / 非数组)被跳过而非污染注册表', () => {
    const { registry } = harness();

    const merged = registry.mergeSnapshot({
      schema: registryModule.SCHEMA,
      sessions: [{ sessionId: '' }, { sessionId: '   ' }, { sessionId: 42 }, null],
      leases: [{ path: '' }, { path: 'docs/a.md' }, { path: 'docs/b.md', sessionId: 'x' }],
    });

    expect(merged.ok).toBe(true);
    expect(merged.value.sessionsAdded).toBe(0);
    expect(merged.value.leasesAdopted).toBe(0);
    expect(registry.stats().value).toEqual({ sessions: 0, leases: 0, subscriptions: 0 });
  });

  test('maxSessions 上限在合并路径同样生效', () => {
    const { registry } = harness({ maxSessions: 2 });

    registry.registerSession({ sessionId: 'a', instanceId: 'A' });

    const snap = peerSnapshot(({ registry: peer }) => {
      peer.registerSession({ sessionId: 'b', instanceId: 'B' });
      peer.registerSession({ sessionId: 'c', instanceId: 'B' });
      peer.registerSession({ sessionId: 'd', instanceId: 'B' });
    });

    const merged = registry.mergeSnapshot(snap, { ownInstanceId: 'A' });

    expect(merged.ok).toBe(true);
    expect(registry.stats().value.sessions).toBe(2);
    expect(merged.value.dropped).toBeGreaterThanOrEqual(1);
  });

  test('SCHEMA 常量对外导出,且与 snapshot 产物一致', () => {
    const { registry } = harness();

    expect(registryModule.SCHEMA).toBe('khy-file-sync-registry/1');
    expect(registry.snapshot().value.schema).toBe(registryModule.SCHEMA);
    expect(registry.SCHEMA).toBe(registryModule.SCHEMA);
  });
});
