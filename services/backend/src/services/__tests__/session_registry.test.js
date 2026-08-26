'use strict';

/**
 * session_registry 单元测试:多实例会话 / 订阅 / 租约生命周期。
 * 时钟注入,租约到期由假时钟精确驱动,不依赖 sleep。
 */

const registryModule = require('../session_registry');

const { CODES } = registryModule;

function harness(over = {}) {
  const clock = { t: 1_000_000 };
  const registry = registryModule.createRegistry({
    now: () => clock.t,
    leaseTtlMs: 1000,
    sessionIdleMs: 5000,
    ...over,
  });

  return { clock, registry, advance: (ms) => (clock.t += ms) };
}

function withSessions(registry, ids) {
  for (const id of ids) {
    registry.registerSession({ sessionId: id, editorId: `editor-${id}`, instanceId: `inst-${id}` });
  }
}

describe('session_registry 会话注册', () => {
  test('注册返回规范化记录，editorId / instanceId 有默认回填', () => {
    const { registry } = harness();
    const result = registry.registerSession({ sessionId: 's-1' });

    expect(result.ok).toBe(true);
    expect(result.value.editorId).toBe('s-1');
    expect(result.value.instanceId).toBe('local');
    expect(result.value.authenticated).toBe(true);
  });

  test('sessionId 非法 / 超长被拒', () => {
    const { registry } = harness();

    expect(registry.registerSession({ sessionId: '' }).error.code).toBe(CODES.INVALID_SESSION_ID);
    expect(registry.registerSession({ sessionId: '  ' }).error.code).toBe(CODES.INVALID_SESSION_ID);
    expect(registry.registerSession({ sessionId: 42 }).error.code).toBe(CODES.INVALID_SESSION_ID);
    expect(registry.registerSession({ sessionId: 'x'.repeat(200) }).error.code).toBe(
      CODES.INVALID_SESSION_ID
    );
  });

  test('重复注册幂等:保留 createdAt 与订阅，刷新 lastSeen', () => {
    const { registry, advance } = harness();

    registry.registerSession({ sessionId: 's-1' });
    registry.subscribe('s-1', ['docs/a.md']);
    advance(200);

    const again = registry.registerSession({ sessionId: 's-1', editorId: 'renamed' });

    expect(again.value.paths).toEqual(['docs/a.md']);
    expect(again.value.editorId).toBe('renamed');
    expect(again.value.lastSeen).toBeGreaterThan(again.value.createdAt);
  });

  test('会话数量超限被拒（边界校验）', () => {
    const { registry } = harness({ maxSessions: 2 });

    expect(registry.registerSession({ sessionId: 'a' }).ok).toBe(true);
    expect(registry.registerSession({ sessionId: 'b' }).ok).toBe(true);

    const denied = registry.registerSession({ sessionId: 'c' });

    expect(denied.error.code).toBe(CODES.SESSION_LIMIT);
    expect(denied.error.message).toContain('2/2');

    // 已存在的会话仍可重复注册（不占新配额）
    expect(registry.registerSession({ sessionId: 'a' }).ok).toBe(true);
  });

  test('未认证会话的认证判定', () => {
    const { registry } = harness();

    registry.registerSession({ sessionId: 's-1', authenticated: false });

    expect(registry.isAuthenticated('s-1')).toBe(false);
    expect(registry.isAuthenticated('unknown')).toBe(false);

    registry.registerSession({ sessionId: 's-1', authenticated: true });

    expect(registry.isAuthenticated('s-1')).toBe(true);
  });
});

describe('session_registry 订阅', () => {
  test('订阅 / 重复订阅 / 订阅者查询', () => {
    const { registry } = harness();

    withSessions(registry, ['s-1', 's-2']);

    const first = registry.subscribe('s-1', ['docs/a.md', 'docs/b.md']);

    expect(first.value.subscribed).toEqual(['docs/a.md', 'docs/b.md']);
    expect(first.value.total).toBe(2);

    const second = registry.subscribe('s-1', ['docs/a.md', 'docs/c.md']);

    expect(second.value.alreadySubscribed).toEqual(['docs/a.md']);
    expect(second.value.subscribed).toEqual(['docs/c.md']);

    registry.subscribe('s-2', ['docs/a.md']);

    expect(registry.subscribersOf('docs/a.md').value).toEqual(['s-1', 's-2']);
    expect(registry.subscribersOf('docs/c.md').value).toEqual(['s-1']);
    expect(registry.subscribersOf('docs/none.md').value).toEqual([]);
    expect(registry.subscribersOf('').value).toEqual([]);
  });

  test('未注册会话 / 未认证会话不得订阅', () => {
    const { registry } = harness();

    expect(registry.subscribe('ghost', ['docs/a.md']).error.code).toBe(CODES.UNKNOWN_SESSION);

    registry.registerSession({ sessionId: 's-1', authenticated: false });

    expect(registry.subscribe('s-1', ['docs/a.md']).error.code).toBe(
      CODES.UNAUTHENTICATED_SESSION
    );
  });

  test('空 paths 被拒；订阅数量超限被拒', () => {
    const { registry } = harness({ maxPathsPerSession: 2 });

    withSessions(registry, ['s-1']);

    expect(registry.subscribe('s-1', []).error.code).toBe(CODES.SUBSCRIBE_FORBIDDEN);
    expect(registry.subscribe('s-1', [null, 7]).error.code).toBe(CODES.SUBSCRIBE_FORBIDDEN);
    expect(registry.subscribe('s-1', ['a', 'b']).ok).toBe(true);

    const denied = registry.subscribe('s-1', ['c']);

    expect(denied.error.code).toBe(CODES.SUBSCRIBE_LIMIT);
  });

  test('未认证会话不出现在订阅者列表里', () => {
    const { registry } = harness();

    withSessions(registry, ['s-1']);
    registry.subscribe('s-1', ['docs/a.md']);
    registry.registerSession({ sessionId: 's-1', authenticated: false });

    expect(registry.subscribersOf('docs/a.md').value).toEqual([]);
  });

  test('取消订阅幂等', () => {
    const { registry } = harness();

    withSessions(registry, ['s-1']);
    registry.subscribe('s-1', ['docs/a.md']);

    expect(registry.unsubscribe('s-1', ['docs/a.md']).value.removed).toEqual(['docs/a.md']);
    expect(registry.unsubscribe('s-1', ['docs/a.md']).value.removed).toEqual([]);
    expect(registry.unsubscribe('ghost', ['docs/a.md']).error.code).toBe(CODES.UNKNOWN_SESSION);
  });
});

describe('session_registry 编辑租约', () => {
  test('申请 → 查询当前编辑者 → 释放', () => {
    const { registry, clock } = harness();

    withSessions(registry, ['s-1']);

    const lease = registry.acquireLease({ path: 'docs/a.md', sessionId: 's-1' });

    expect(lease.ok).toBe(true);
    expect(lease.value.editorId).toBe('editor-s-1');
    expect(lease.value.expiresAt).toBe(clock.t + 1000);
    expect(lease.value.renewals).toBe(0);

    expect(registry.editorOf('docs/a.md').value.sessionId).toBe('s-1');

    expect(registry.releaseLease({ path: 'docs/a.md', sessionId: 's-1' }).value.released).toBe(true);
    expect(registry.editorOf('docs/a.md').value).toBeNull();
  });

  test('被他人持有且未过期 → LEASE_HELD，且给出持有者与剩余时间', () => {
    const { registry, advance } = harness();

    withSessions(registry, ['s-1', 's-2']);
    registry.acquireLease({ path: 'docs/a.md', sessionId: 's-1' });
    advance(300);

    const denied = registry.acquireLease({ path: 'docs/a.md', sessionId: 's-2' });

    expect(denied.ok).toBe(false);
    expect(denied.error.code).toBe(CODES.LEASE_HELD);
    expect(denied.error.holderSessionId).toBe('s-1');
    expect(denied.error.holderEditorId).toBe('editor-s-1');
    expect(denied.error.message).toContain('700 毫秒');
  });

  test('同一会话重复申请 = 续期(幂等)，acquiredAt 不变', () => {
    const { registry, advance } = harness();

    withSessions(registry, ['s-1']);

    const first = registry.acquireLease({ path: 'docs/a.md', sessionId: 's-1' });

    advance(400);

    const again = registry.acquireLease({ path: 'docs/a.md', sessionId: 's-1' });

    expect(again.value.acquiredAt).toBe(first.value.acquiredAt);
    expect(again.value.expiresAt).toBeGreaterThan(first.value.expiresAt);
    expect(again.value.renewals).toBe(1);
  });

  test('租约到期后可被他人抢占（惰性过期，不依赖 sweep）', () => {
    const { registry, advance } = harness();

    withSessions(registry, ['s-1', 's-2']);
    registry.acquireLease({ path: 'docs/a.md', sessionId: 's-1' });
    advance(1001);

    expect(registry.editorOf('docs/a.md').value).toBeNull();

    const taken = registry.acquireLease({ path: 'docs/a.md', sessionId: 's-2' });

    expect(taken.ok).toBe(true);
    expect(taken.value.sessionId).toBe('s-2');
  });

  test('非持有者不得续期 / 释放 —— 不静默改写别人的租约', () => {
    const { registry } = harness();

    withSessions(registry, ['s-1', 's-2']);
    registry.acquireLease({ path: 'docs/a.md', sessionId: 's-1' });

    expect(registry.renewLease({ path: 'docs/a.md', sessionId: 's-2' }).error.code).toBe(
      CODES.LEASE_NOT_HELD
    );
    expect(registry.releaseLease({ path: 'docs/a.md', sessionId: 's-2' }).error.code).toBe(
      CODES.LEASE_NOT_HELD
    );
    expect(registry.editorOf('docs/a.md').value.sessionId).toBe('s-1');
  });

  test('未注册 / 未认证会话不得申请租约', () => {
    const { registry } = harness();

    expect(registry.acquireLease({ path: 'docs/a.md', sessionId: 'ghost' }).error.code).toBe(
      CODES.UNKNOWN_SESSION
    );

    registry.registerSession({ sessionId: 's-1', authenticated: false });

    expect(registry.acquireLease({ path: 'docs/a.md', sessionId: 's-1' }).error.code).toBe(
      CODES.UNAUTHENTICATED_SESSION
    );
  });

  test('空 path 被拒；释放不存在的租约不算错误', () => {
    const { registry } = harness();

    withSessions(registry, ['s-1']);

    expect(registry.acquireLease({ path: '', sessionId: 's-1' }).error.code).toBe(
      CODES.SUBSCRIBE_FORBIDDEN
    );
    expect(registry.releaseLease({ path: 'docs/none.md', sessionId: 's-1' }).value.released).toBe(
      false
    );
  });

  test('心跳把持有的每条租约都往后推(基于活动的超时)', () => {
    const { registry, advance } = harness();

    withSessions(registry, ['s-1']);
    registry.acquireLease({ path: 'docs/a.md', sessionId: 's-1' });
    registry.acquireLease({ path: 'docs/b.md', sessionId: 's-1' });

    advance(900);

    const beat = registry.heartbeat('s-1');

    expect(beat.value.renewedPaths.sort()).toEqual(['docs/a.md', 'docs/b.md']);

    advance(900);

    // 累计 1800ms > TTL 1000ms，但因为中途心跳过，租约仍在。
    expect(registry.editorOf('docs/a.md').value.sessionId).toBe('s-1');
    expect(registry.heartbeat('ghost').error.code).toBe(CODES.UNKNOWN_SESSION);
  });
});

describe('session_registry 断线与清扫', () => {
  test('断线立即释放全部租约与订阅，不等 TTL', () => {
    const { registry } = harness();

    withSessions(registry, ['s-1', 's-2']);
    registry.subscribe('s-1', ['docs/a.md', 'docs/b.md']);
    registry.subscribe('s-2', ['docs/a.md']);
    registry.acquireLease({ path: 'docs/a.md', sessionId: 's-1' });
    registry.acquireLease({ path: 'docs/b.md', sessionId: 's-1' });

    const dropped = registry.dropSession('s-1');

    expect(dropped.value.existed).toBe(true);
    expect(dropped.value.releasedPaths).toEqual(['docs/a.md', 'docs/b.md']);
    expect(dropped.value.unsubscribed).toEqual(['docs/a.md', 'docs/b.md']);
    expect(registry.editorOf('docs/a.md').value).toBeNull();
    expect(registry.subscribersOf('docs/a.md').value).toEqual(['s-2']);
    expect(registry.isAuthenticated('s-1')).toBe(false);
  });

  test('断线后同一文件可立刻被另一实例接手编辑', () => {
    const { registry } = harness();

    withSessions(registry, ['s-1', 's-2']);
    registry.acquireLease({ path: 'docs/a.md', sessionId: 's-1' });
    registry.dropSession('s-1');

    expect(registry.acquireLease({ path: 'docs/a.md', sessionId: 's-2' }).ok).toBe(true);
  });

  test('丢弃未知会话不抛，标记 existed=false', () => {
    const { registry } = harness();
    const dropped = registry.dropSession('ghost');

    expect(dropped.ok).toBe(true);
    expect(dropped.value.existed).toBe(false);
  });

  test('清扫回收过期租约与空闲会话（空闲超时，不是固定硬 kill）', () => {
    const { registry, advance } = harness();

    withSessions(registry, ['s-1', 's-2']);
    registry.acquireLease({ path: 'docs/a.md', sessionId: 's-1' });
    registry.subscribe('s-2', ['docs/b.md']);

    advance(1500);

    const first = registry.sweep();

    expect(first.value.expiredLeases).toEqual([
      { path: 'docs/a.md', sessionId: 's-1', editorId: 'editor-s-1' },
    ]);
    expect(first.value.idleSessions).toEqual([]);

    advance(4000);

    const second = registry.sweep();

    expect(second.value.idleSessions.sort()).toEqual(['s-1', 's-2']);
    expect(registry.stats().value).toEqual({ sessions: 0, leases: 0, subscriptions: 0 });
  });

  test('持续活动的会话永不被清扫掉', () => {
    const { registry, advance } = harness();

    withSessions(registry, ['s-1']);
    registry.acquireLease({ path: 'docs/a.md', sessionId: 's-1' });

    for (let i = 0; i < 20; i++) {
      advance(800);
      registry.heartbeat('s-1');
      registry.sweep();
    }

    expect(registry.stats().value.sessions).toBe(1);
    expect(registry.editorOf('docs/a.md').value.sessionId).toBe('s-1');
  });

  test('统计给出会话 / 租约 / 订阅三项', () => {
    const { registry } = harness();

    withSessions(registry, ['s-1', 's-2']);
    registry.subscribe('s-1', ['docs/a.md', 'docs/b.md']);
    registry.subscribe('s-2', ['docs/a.md']);
    registry.acquireLease({ path: 'docs/a.md', sessionId: 's-1' });

    expect(registry.stats().value).toEqual({ sessions: 2, leases: 1, subscriptions: 3 });
  });
});

describe('session_registry 快照与恢复(跨实例 IoC port)', () => {
  test('快照 → 恢复后会话、订阅、租约都在', () => {
    const source = harness();

    withSessions(source.registry, ['s-1', 's-2']);
    source.registry.subscribe('s-1', ['docs/a.md']);
    source.registry.acquireLease({ path: 'docs/a.md', sessionId: 's-1' });

    const snap = source.registry.snapshot();

    expect(snap.value.schema).toBe('khy-file-sync-registry/1');

    const target = harness({ now: () => source.clock.t });
    const restored = target.registry.restore(JSON.parse(JSON.stringify(snap.value)));

    expect(restored.ok).toBe(true);
    expect(restored.value.sessions).toBe(2);
    expect(restored.value.leases).toBe(1);
    expect(restored.value.droppedLeases).toBe(0);
    expect(target.registry.subscribersOf('docs/a.md').value).toEqual(['s-1']);
    expect(target.registry.editorOf('docs/a.md').value.editorId).toBe('editor-s-1');
  });

  test('恢复时丢弃已过期租约', () => {
    const source = harness();

    withSessions(source.registry, ['s-1']);
    source.registry.acquireLease({ path: 'docs/a.md', sessionId: 's-1' });

    const snap = source.registry.snapshot();

    source.advance(5000);

    const restored = source.registry.restore(snap.value);

    expect(restored.value.droppedLeases).toBe(1);
    expect(restored.value.leases).toBe(0);
    expect(source.registry.editorOf('docs/a.md').value).toBeNull();
  });

  test('坏快照返回结构化错误而非抛异常', () => {
    const { registry } = harness();

    expect(registry.restore(null).error.code).toBe(CODES.INVALID_SNAPSHOT);
    expect(registry.restore({}).error.code).toBe(CODES.INVALID_SNAPSHOT);
    expect(registry.restore({ schema: 'other/9' }).error.code).toBe(CODES.INVALID_SNAPSHOT);
    expect(registry.restore('nope').error.code).toBe(CODES.INVALID_SNAPSHOT);
  });

  test('恢复时对脏数据做边界校验：坏会话与坏租约被跳过', () => {
    const { registry, clock } = harness();
    const restored = registry.restore({
      schema: 'khy-file-sync-registry/1',
      at: clock.t,
      sessions: [
        { sessionId: 'ok-1', paths: ['docs/a.md'] },
        { sessionId: '' },
        { sessionId: 'x'.repeat(500) },
        null,
      ],
      leases: [
        { path: 'docs/a.md', sessionId: 'ok-1', expiresAt: clock.t + 1000 },
        { path: '', sessionId: 'ok-1', expiresAt: clock.t + 1000 },
        { path: 'docs/b.md', sessionId: 'ok-1' },
      ],
    });

    expect(restored.ok).toBe(true);
    expect(restored.value.sessions).toBe(1);
    expect(restored.value.leases).toBe(1);
    expect(restored.value.droppedLeases).toBe(2);
  });

  test('恢复时订阅路径数量被截到上限', () => {
    const { registry, clock } = harness({ maxPathsPerSession: 2 });
    const restored = registry.restore({
      schema: 'khy-file-sync-registry/1',
      at: clock.t,
      sessions: [{ sessionId: 's-1', paths: ['a', 'b', 'c', 'd'] }],
      leases: [],
    });

    expect(restored.ok).toBe(true);
    expect(registry.stats().value.subscriptions).toBe(2);
  });
});
