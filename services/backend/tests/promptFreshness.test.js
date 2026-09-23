'use strict';

/**
 * promptFreshness.test.js — 新鲜度戳叶子单测([DESIGN-ARCH-098] P1,修 CONCERNS.staleKey)
 *
 *   node --test services/backend/tests/promptFreshness.test.js
 *
 * 覆盖:门控默认开 / 时间桶语义 / stat 戳 / 技能指纹的顺序无关性 / 拼键 / 全程 fail-soft。
 * 关键性质:本叶子**纯且确定性**(时间由调用方传入,不用 Date.now()),因此可确定性重放。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const F = require('../src/constants/promptFreshness');

describe('promptFreshness — 门控', () => {
  test('KHY_PROMPT_FRESH_KEYS 默认开(缺陷修复)', () => {
    assert.equal(F.isFreshKeysEnabled({}), true);
  });

  test('显式关闭后为关(逐字节回退旧键)', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      assert.equal(F.isFreshKeysEnabled({ KHY_PROMPT_FRESH_KEYS: v }), false, `值 ${v}`);
    }
  });
});

describe('promptFreshness — git 状态戳', () => {
  test('时间桶随 now 变化(保证最坏情况下也会刷新,不再永久冻结)', () => {
    const base = { indexMtimeMs: 1, headMtimeMs: 2, ttlMs: 30000 };
    const a = F.gitStatusStamp({ ...base, nowMs: 0 });
    const b = F.gitStatusStamp({ ...base, nowMs: 30000 });
    const c = F.gitStatusStamp({ ...base, nowMs: 29999 });
    assert.notEqual(a, b); // 跨桶 → 变
    assert.equal(a, c); // 同桶 → 不变
  });

  test('.git 的 mtime 变化立即改变戳(捕获 add / 切分支 / commit)', () => {
    const opts = { nowMs: 1000, ttlMs: 30000 };
    assert.notEqual(
      F.gitStatusStamp({ ...opts, indexMtimeMs: 111, headMtimeMs: 222 }),
      F.gitStatusStamp({ ...opts, indexMtimeMs: 999, headMtimeMs: 222 })
    );
  });

  test('ttlMs=0 → 不启用时间桶(键只由 mtime 决定)', () => {
    const opts = { indexMtimeMs: 1, headMtimeMs: 2, ttlMs: 0 };
    assert.equal(F.gitStatusStamp({ ...opts, nowMs: 0 }), F.gitStatusStamp({ ...opts, nowMs: 9e12 }));
    assert.match(F.gitStatusStamp({ ...opts, nowMs: 0 }), /off$/);
  });

  test('两个 mtime 都不存在(非 git 目录)→ 空串,让调用方回退旧键', () => {
    assert.equal(F.gitStatusStamp({}), '');
    assert.equal(F.gitStatusStamp(null), '');
    assert.equal(F.gitStatusStamp({ indexMtimeMs: -1, headMtimeMs: -1, ttlMs: 0 }), '');
    // 只要有一个 mtime 存在,即使 ttl=0 也应产出戳(仅为关掉时间桶,不是「无信息」)
    assert.equal(F.gitStatusStamp({ indexMtimeMs: 5, headMtimeMs: -1, ttlMs: 0 }), '5|-1|off');
  });

  test('默认桶宽 30s;env 可覆盖', () => {
    assert.equal(F.gitStampTtlMs({}), 30000);
    assert.equal(F.gitStampTtlMs({ KHY_PROMPT_GIT_STAMP_TTL_MS: '5000' }), 5000);
    assert.equal(F.gitStampTtlMs({ KHY_PROMPT_GIT_STAMP_TTL_MS: '0' }), 0);
    assert.equal(F.gitStampTtlMs({ KHY_PROMPT_GIT_STAMP_TTL_MS: 'x' }), 30000);
  });
});

describe('promptFreshness — stat 戳', () => {
  test('按 path:mtime:size 拼接,顺序敏感(以路径为序)', () => {
    assert.equal(
      F.stampFromStats([
        { path: '/a', mtimeMs: 1, size: 10 },
        { path: '/b', mtimeMs: 2, size: 20 },
      ]),
      '/a:1:10|/b:2:20'
    );
  });

  test('缺 mtime/size → -1 占位(仍能感知路径集合变化)', () => {
    assert.equal(F.stampFromStats([{ path: '/a' }]), '/a:-1:-1');
  });

  test('空/坏输入 → 空串,绝不抛', () => {
    assert.equal(F.stampFromStats([]), '');
    assert.equal(F.stampFromStats(null), '');
    assert.equal(F.stampFromStats([null, { path: '' }]), '');
  });
});

describe('promptFreshness — 技能目录指纹', () => {
  test('同一技能集 → 同一指纹(与顺序无关)', () => {
    const a = F.skillCatalogStamp([
      { id: 'x', description: 'dx' },
      { id: 'y', description: 'dy' },
    ]);
    const b = F.skillCatalogStamp([
      { id: 'y', description: 'dy' },
      { id: 'x', description: 'dx' },
    ]);
    assert.equal(a, b);
  });

  test('装/卸技能改变指纹', () => {
    const one = F.skillCatalogStamp([{ id: 'x', description: 'dx' }]);
    const two = F.skillCatalogStamp([
      { id: 'x', description: 'dx' },
      { id: 'y', description: 'dy' },
    ]);
    assert.notEqual(one, two);
  });

  test('仅改 description 也改变指纹(目录展示的就是描述)', () => {
    assert.notEqual(
      F.skillCatalogStamp([{ id: 'x', description: 'aa' }]),
      F.skillCatalogStamp([{ id: 'x', description: 'bb' }])
    );
  });

  test('空集 → none;坏输入 → none', () => {
    assert.equal(F.skillCatalogStamp([]), 'none');
    assert.equal(F.skillCatalogStamp(null), 'none');
  });
});

describe('promptFreshness — 拼键与哈希', () => {
  test('combineStamp 跳过空值', () => {
    assert.equal(F.combineStamp(['a', '', null, undefined, 'b']), 'a|b');
    assert.equal(F.combineStamp([]), '');
    assert.equal(F.combineStamp(null), '');
  });

  test('hashString 确定性且区分输入', () => {
    assert.equal(F.hashString('abc'), F.hashString('abc'));
    assert.notEqual(F.hashString('abc'), F.hashString('abd'));
    assert.match(F.hashString('anything'), /^[0-9a-f]{8}$/);
  });
});
