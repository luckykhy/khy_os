'use strict';

/**
 * modelListTruth — 纯叶子单测。
 *
 * 覆盖用户报告的三类症状:
 *   (1) 「模型列表里频繁出现大量真实不存在的模型」—— 静态目录(builtin)/本机扫描(local)/env 逗号串
 *       (hint) 被当事实展示 → 上游权威覆盖律必须剔除。
 *   (2) 「claude sonnet3.5 / gpt5.3 code review」这类**句子片段**被正则扫描成模型 ID → 形态律必须拦。
 *   (3) 「无上游证据时」不得臆造也不得滥杀 —— 一条不剔,只打 unverified 标注。
 */

const T = require('../../../src/services/gateway/modelListTruth');

describe('modelListTruth · 形态律', () => {
  test('接受真实形状的模型 ID(含复合路由 / 冒号 tag / 斜杠路径)', () => {
    for (const id of [
      'gpt-4o',
      'gpt-5.3-codex-review',
      'claude-3.5-sonnet',
      'claude-opus-4-8::auto',
      'claude-opus-4-8::bridge',
      'qwen3.5:4b',
      'openrouter/z-ai/glm-5.2:free',
      'swe-1.6-m1.5',
      'warp-web',
      // 外围引号是 JSON/TOML 语法,不是 ID 的一部分 —— 规范化会剥掉(与全仓
      // normalizeModelIdCompact / normalizeModelIdTrimQuotes 同一约定)。
      '"gpt-4o"',
    ]) {
      expect(T.isWellFormedId(id)).toBe(true);
    }
  });

  test('拒绝句子片段 / 空白 / CJK / 引号 / URL / 超长', () => {
    for (const id of [
      'claude sonnet3.5',
      'gpt5.3 code review',
      'Oenaigpt5.3 code review',
      'Claude 3.5 Sonnet（推荐）',
      '模型-gpt-4o',
      'gpt-"4o"',
      'https://api.example.com/v1/models',
      'gpt-4o\\extra',
      'user@gpt-4o',
      'ab',
      `gpt-${'x'.repeat(120)}`,
      '',
      null,
      undefined,
    ]) {
      expect(T.isWellFormedId(id)).toBe(false);
    }
  });
});

describe('modelListTruth · 上游权威覆盖律', () => {
  test('有 remote 证据时,builtin / local / hint 一律剔除(除非是上游 id 的结构性变体)', () => {
    const models = [
      { id: 'gpt-4o', isDefault: true, discoverySource: 'remote' },
      { id: 'gpt-4o-mini', discoverySource: 'remote+local' },
      { id: 'claude-3.5-sonnet', discoverySource: 'builtin' },
      { id: 'kimi2.6', discoverySource: 'builtin' },
      { id: 'swe-1.6', discoverySource: 'local' },
      { id: 'glm-4.6', discoverySource: 'hint' },
      { id: 'gpt-4o::bridge', discoverySource: 'builtin', _baseModelId: 'gpt-4o' },
    ];
    const out = T.filterByUpstreamAuthority(models, { adapterKey: 'windsurf' });
    expect(out.authoritative).toBe(true);
    expect(out.models.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini', 'gpt-4o::bridge']);
    expect(out.dropped).toBe(4);
    expect(out.reasons).toContain('unconfirmed');
  });

  test('无 remote 证据时一条不剔,但全部打 unverified 标注(不臆造也不滥杀)', () => {
    const models = [
      { id: 'claude-opus-4-8', isDefault: true, discoverySource: 'builtin' },
      { id: 'claude-sonnet-4-6', discoverySource: 'builtin' },
      { id: 'warp-web' },
    ];
    const out = T.filterByUpstreamAuthority(models, { adapterKey: 'claude' });
    expect(out.authoritative).toBe(false);
    expect(out.models.map((m) => m.id)).toEqual([
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'warp-web',
    ]);
    expect(out.dropped).toBe(0);
    expect(out.unverifiedCount).toBe(2); // warp-web 无来源标记 → 按可信处理,不标注
    expect(out.models[0].unverified).toBe(true);
    expect(out.models[2].unverified).toBeUndefined();
  });

  test('形态非法的条目**无论有无权威**都被剔除(句子片段进不来)', () => {
    const out = T.filterByUpstreamAuthority(
      [
        { id: 'claude sonnet3.5', discoverySource: 'remote' },
        { id: 'gpt-4o', discoverySource: 'remote' },
      ],
      { adapterKey: 'api' }
    );
    expect(out.models.map((m) => m.id)).toEqual(['gpt-4o']);
    expect(out.reasons).toContain('malformed');
  });
});

describe('modelListTruth · 实测律与逃生口', () => {
  test('TTL 内探活判 failed 的模型剔除,unknown / verified 保留', () => {
    const verifyStatusOf = (adapterKey, id) => {
      if (id === 'gpt-4o-mini') return 'failed';
      if (id === 'gpt-4o') return 'verified';
      return 'unknown';
    };
    const out = T.filterByUpstreamAuthority(
      [
        { id: 'gpt-4o', isDefault: true, discoverySource: 'remote' },
        { id: 'gpt-4o-mini', discoverySource: 'remote' },
        { id: 'glm-4.6', discoverySource: 'remote' },
      ],
      { adapterKey: 'api', verifyStatusOf }
    );
    expect(out.models.map((m) => m.id)).toEqual(['gpt-4o', 'glm-4.6']);
    expect(out.reasons).toContain('verify-failed');
  });

  test('全部被剔除 → 逃生口保留默认/权威一条;该条形态亦非法 → 返回空(空是诚实的)', () => {
    const kept = T.filterByUpstreamAuthority(
      [
        { id: 'junk one', discoverySource: 'local' },
        { id: 'junk two', discoverySource: 'local' },
      ],
      { adapterKey: 'x' }
    );
    expect(kept.models).toEqual([]);

    const escaped = T.filterByUpstreamAuthority(
      [
        { id: 'gpt-4o', isDefault: true, discoverySource: 'remote' },
        { id: 'junk one', discoverySource: 'local' },
      ],
      { adapterKey: 'x' }
    );
    expect(escaped.models.map((m) => m.id)).toEqual(['gpt-4o']);
  });

  test('门控关闭 → bypassed,零剔除(逐字节回退)', () => {
    const out = T.filterByUpstreamAuthority(
      [
        { id: 'claude-3.5-sonnet', discoverySource: 'builtin' },
        { id: 'gpt-4o', discoverySource: 'remote' },
      ],
      { adapterKey: 'windsurf', env: { KHY_MODEL_LIST_TRUTH: 'off' } }
    );
    expect(out.bypassed).toBe(true);
    expect(out.dropped).toBe(0);
    expect(out.models.map((m) => m.id)).toEqual(['claude-3.5-sonnet', 'gpt-4o']);
  });

  test('绝不抛:垃圾输入 → 零剔除的安全回退', () => {
    for (const bad of [null, undefined, 42, 'nope', {}, [{}, null, 1]]) {
      expect(() => T.filterByUpstreamAuthority(bad, { adapterKey: 'x' })).not.toThrow();
    }
    expect(() => T.filterByUpstreamAuthority([{ id: 'gpt-4o' }], { verifyStatusOf: () => { throw new Error('boom'); } })).not.toThrow();
    expect(T.filterByUpstreamAuthority(null).models).toEqual([]);
  });

  test('自描述契约可被工具/文档消费', () => {
    const d = T.describeModelListTruth();
    expect(d.gate).toBe('KHY_MODEL_LIST_TRUTH');
    expect(d.defaultOn).toBe(true);
    expect(d.untrustedSources).toEqual(
      expect.arrayContaining(['builtin', 'local', 'hint'])
    );
    expect(d.authoritativeSources).toEqual(expect.arrayContaining(['remote', 'remote+local']));
  });
});
