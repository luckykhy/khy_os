'use strict';

/**
 * routeFact — 「上下显示不一致」的根治设施（2026-09-17 事故）。
 *
 * 事故现场：页脚显示 `agnes-3.0-flash`，报错却写 `windsurf [unavailable]`。
 * 根因是三处显示各自推导、无人负责一致性：
 *   ① 页脚模型名 ← getActiveAdapter().activeModel（会**绕开**不可用钉选通道）
 *   ② 页脚通道名 ← process.env.GATEWAY_PREFERRED_ADAPTER（读的是「声明」）
 *   ③ 报错正文   ← generate() 的 allAttempts（**死在**同名通道上）
 *
 * 本叶子把「意图/解析/实际/成功」固化成单一真源，消费方只读不推导。
 */

const rf = require('../../src/services/gateway/routeFact');

/** 构造 env 快照的便捷函数（避免污染真实 process.env）。 */
function envOf(overrides = {}) {
  return { ...overrides };
}

describe('routeFact — 常量与谓词', () => {
  test("'auto' 哨兵值不算钉选（否则页脚会恒显告警）", () => {
    expect(rf.isPinnedAdapter('auto')).toBe(false);
    expect(rf.isPinnedAdapter('AUTO')).toBe(false);
    expect(rf.isPinnedAdapter('')).toBe(false);
    expect(rf.isPinnedAdapter(null)).toBe(false);
    expect(rf.isPinnedAdapter(undefined)).toBe(false);
    expect(rf.isPinnedAdapter('  ')).toBe(false);
  });

  test('真实通道名算钉选', () => {
    expect(rf.isPinnedAdapter('windsurf')).toBe(true);
    expect(rf.isPinnedAdapter(' api ')).toBe(true);
  });

  test("strict 仅当显式 'false' 时为假（与 aiChatCore.js:734 逐字同义）", () => {
    // 未设置 → strict（这是刻意的默认，必须如实反映，否则页脚会漏掉硬失败风险）
    expect(rf.isStrictPinned(envOf())).toBe(true);
    expect(rf.isStrictPinned(envOf({ GATEWAY_PREFERRED_STRICT: '' }))).toBe(true);
    expect(rf.isStrictPinned(envOf({ GATEWAY_PREFERRED_STRICT: 'true' }))).toBe(true);
    expect(rf.isStrictPinned(envOf({ GATEWAY_PREFERRED_STRICT: 'FALSE' }))).toBe(false);
    expect(rf.isStrictPinned(envOf({ GATEWAY_PREFERRED_STRICT: 'false' }))).toBe(false);
  });
});

describe('routeFact — 事故现场复现', () => {
  // 本次事故的精确输入：env 钉 windsurf + strict；实际尝试 windsurf 且失败。
  const accidentEnv = envOf({
    GATEWAY_PREFERRED_ADAPTER: 'windsurf',
    GATEWAY_PREFERRED_MODEL: 'claude-3.5-sonnet',
    GATEWAY_PREFERRED_STRICT: 'true',
  });
  const accidentResult = {
    success: false,
    content: '真实失败原因:\n- windsurf [unavailable]: Windsurf IDE unavailable',
    provider: 'none',
    adapter: 'none',
    preferredAdapter: 'windsurf',
    actualAdapter: 'windsurf',
    errorType: 'unavailable',
    error: 'windsurf unavailable',
  };

  test('三处显示读到同一事实：请求通道与尝试通道同为 windsurf', () => {
    const fact = rf.buildRouteFact(accidentResult, {
      env: accidentEnv,
      pinnedUnavailable: true,
    });

    expect(fact.requested.adapter).toBe('windsurf');
    expect(fact.attempted.adapter).toBe('windsurf');
    expect(fact.outcome).toBe('failed');
    expect(fact.served).toBeNull();
    expect(fact.strictPinned).toBe(true);
    expect(fact.pinnedUnavailable).toBe(true);
  });

  test('一致性断言自洽（strict 硬钉 + 不可用 → 必 failed）', () => {
    const fact = rf.buildRouteFact(accidentResult, {
      env: accidentEnv,
      pinnedUnavailable: true,
    });
    expect(rf._assertCoherent(fact)).toEqual([]);
  });

  test('label 显示为「钉选通道 ✗ → 失败」，不再谎称 agnes 在服务', () => {
    const fact = rf.buildRouteFact(accidentResult, {
      env: accidentEnv,
      pinnedUnavailable: true,
    });
    const label = rf.formatRouteFactLabel(fact);
    expect(label).toContain('windsurf');
    expect(label).toContain('✗');
  });
});

describe('routeFact — 一致性不变式', () => {
  test('outcome=ok 但 served 为空 → 报违规', () => {
    const problems = rf._assertCoherent({
      outcome: 'ok',
      served: null,
      strictPinned: false,
      pinnedUnavailable: false,
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join()).toContain('served 为空');
  });

  test('outcome=failed 但 served 非空 → 报违规', () => {
    const problems = rf._assertCoherent({
      outcome: 'failed',
      served: { adapter: 'api', model: 'x' },
      strictPinned: false,
      pinnedUnavailable: false,
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join()).toContain('served 非空');
  });

  test('strict 硬钉 + 不可用 却报了成功 → 报违规', () => {
    const problems = rf._assertCoherent({
      outcome: 'ok',
      served: { adapter: 'api', model: 'x' },
      strictPinned: true,
      pinnedUnavailable: true,
    });
    expect(problems.length).toBeGreaterThan(0);
  });

  test('合法 outcome 之外的字符串 → 报违规', () => {
    const problems = rf._assertCoherent({
      outcome: 'partial',
      served: null,
      strictPinned: false,
      pinnedUnavailable: false,
    });
    expect(problems.join()).toContain('outcome 非法');
  });

  test('断言器永不抛（诊断设施不该成为故障源）', () => {
    expect(() => rf._assertCoherent(null)).not.toThrow();
    expect(() => rf._assertCoherent(undefined)).not.toThrow();
    expect(() => rf._assertCoherent('garbage')).not.toThrow();
    expect(() => rf._assertCoherent(123)).not.toThrow();
  });
});

describe('routeFact — 成功与回退路径', () => {
  test('成功：served 即实际通道，label 无告警标记', () => {
    const fact = rf.buildRouteFact(
      { success: true, adapter: 'api', actualAdapter: 'api', model: 'agnes-3.0-flash' },
      { env: envOf({ GATEWAY_PREFERRED_ADAPTER: 'api' }) }
    );
    expect(fact.outcome).toBe('ok');
    expect(fact.served.adapter).toBe('api');
    expect(rf._assertCoherent(fact)).toEqual([]);
    expect(rf.formatRouteFactLabel(fact)).toContain('agnes-3.0-flash');
  });

  test('回退成功：意图 windsurf，实际 api → label 用 → 表达回退', () => {
    const fact = rf.buildRouteFact(
      { success: true, adapter: 'api', actualAdapter: 'api', model: 'agnes-3.0-flash' },
      { env: envOf({ GATEWAY_PREFERRED_ADAPTER: 'windsurf' }) }
    );
    expect(fact.requested.adapter).toBe('windsurf');
    expect(fact.served.adapter).toBe('api');
    const label = rf.formatRouteFactLabel(fact);
    expect(label).toContain('windsurf →');
    expect(label).not.toContain('✗');
  });

  test('auto 模式：不产生「意图≠实际」的虚假告警', () => {
    const fact = rf.buildRouteFact(
      { success: true, adapter: 'api', actualAdapter: 'api', model: 'agnes-3.0-flash' },
      { env: envOf({ GATEWAY_PREFERRED_ADAPTER: 'auto' }) }
    );
    expect(fact.strictPinned).toBe(false);
    expect(fact.pinnedUnavailable).toBe(false);
    expect(rf.formatRouteFactLabel(fact)).not.toContain('→');
  });
});

describe('routeFact — 健壮性（绝不抛、绝不改入参）', () => {
  test('result 为 null/undefined/非对象 → 降级为失败快照', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      const fact = rf.buildRouteFact(bad, { env: envOf() });
      expect(fact.outcome).toBe('failed');
      expect(fact.served).toBeNull();
      expect(fact.attempted.adapter).toBe('');
    }
  });

  test('buildRouteFact 不修改传入的 result（调用方可能在多处复用）', () => {
    const original = { success: true, adapter: 'api', actualAdapter: 'api', model: 'm' };
    const snapshot = JSON.stringify(original);
    rf.buildRouteFact(original, { env: envOf() });
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  test('buildRouteFact 不读 process.env（env 必须由调用方注入）', () => {
    const old = process.env.GATEWAY_PREFERRED_ADAPTER;
    process.env.GATEWAY_PREFERRED_ADAPTER = 'should-be-ignored';
    try {
      const fact = rf.buildRouteFact({ success: true, adapter: 'api', actualAdapter: 'api' }, {});
      expect(fact.requested.adapter).toBe('');
    } finally {
      if (old === undefined) {
        delete process.env.GATEWAY_PREFERRED_ADAPTER;
      } else {
        process.env.GATEWAY_PREFERRED_ADAPTER = old;
      }
    }
  });

  test('createEmptyRouteFact 保证消费方永远有对象可读', () => {
    const fact = rf.createEmptyRouteFact(envOf({ GATEWAY_PREFERRED_ADAPTER: 'windsurf' }));
    expect(fact.outcome).toBe('failed');
    expect(fact.served).toBeNull();
    expect(typeof fact.requested).toBe('object');
    expect(typeof fact.attempted).toBe('object');
  });

  test('formatRouteFactLabel 对畸形输入不抛', () => {
    expect(() => rf.formatRouteFactLabel(null)).not.toThrow();
    expect(() => rf.formatRouteFactLabel({})).not.toThrow();
    expect(() => rf.formatRouteFactLabel({ reason: 'boom' })).not.toThrow();
  });

  test('at 可显式注入以保证确定性', () => {
    const fact = rf.buildRouteFact({ success: true }, { env: envOf(), at: 1234 });
    expect(fact.at).toBe(1234);
  });
});
