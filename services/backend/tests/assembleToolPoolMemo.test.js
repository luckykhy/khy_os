'use strict';

/**
 * assembleToolPoolMemo.test —— 原生云路径工具池装配记忆
 * (Ch2「不要每轮重建可复用结构」;门 KHY_TOOL_ASSEMBLE_POOL_MEMO,node:test)。
 *
 * assembleToolPool 是 buildDirectToolDefs 每模型往返最贵的派生(2×deny + 2×profile +
 * 2×deferral 过滤 + 2×~200 工具全排序 + 合并)。验证:①门开 → 同一 (profile,注册表版本,
 * deferral,reveal 指纹) 命中缓存返同 Map 引用;②不同 profile → 不同缓存条目;③记忆结果与
 * 门关现建逐字等价(名字集合);④reveal/reset 改 _revealVersion → 键变、返新池、与门关现建
 * 一致(不返陈旧引用);⑤caller 传 denyRules 覆盖 → 不可键化,始终重建(即便门开);⑥门关
 * (0/off/false/no/OFF)→ 不写缓存、每次现建。
 */
const test = require('node:test');
const assert = require('node:assert');

const r = require('../src/tools/index.js');

function withMemo(value, fn) {
  const prev = process.env.KHY_TOOL_ASSEMBLE_POOL_MEMO;
  if (value === undefined) delete process.env.KHY_TOOL_ASSEMBLE_POOL_MEMO;
  else process.env.KHY_TOOL_ASSEMBLE_POOL_MEMO = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.KHY_TOOL_ASSEMBLE_POOL_MEMO;
    else process.env.KHY_TOOL_ASSEMBLE_POOL_MEMO = prev;
  }
}

function names(m) { return [...m.keys()].sort(); }

test('门开:同一装配上下文命中缓存(同 Map 引用),缓存计一槽', () => {
  withMemo('1', () => {
    r._resetAssemblePoolMemo();
    const a = r.assembleToolPool(undefined, 'coding');
    const b = r.assembleToolPool(undefined, 'coding');
    assert.ok(a instanceof Map);
    assert.strictEqual(a, b, '重复调用应返回同一缓存 Map 引用');
    assert.strictEqual(r._assemblePoolMemoSize(), 1);
  });
});

test('不同 profile → 不同缓存条目', () => {
  withMemo('1', () => {
    r._resetAssemblePoolMemo();
    const coding = r.assembleToolPool(undefined, 'coding');
    const full = r.assembleToolPool(undefined, 'full');
    assert.notStrictEqual(coding, full);
    assert.strictEqual(r._assemblePoolMemoSize(), 2);
  });
});

test('记忆结果与门关现建逐字等价(名字集合)', () => {
  const off = withMemo('0', () => names(r.assembleToolPool(undefined, 'coding')));
  r._resetAssemblePoolMemo();
  const on = withMemo('1', () => names(r.assembleToolPool(undefined, 'coding')));
  assert.deepStrictEqual(on, off);
});

test('reveal/reset 改指纹 → 键变、返新池、与门关现建一致', async () => {
  r.resetDeferredSession();
  const deferred = r.getDeferredTools();

  await withMemo('1', async () => {
    r._resetAssemblePoolMemo();
    const before = r.assembleToolPool(undefined, 'coding');
    const keyBefore = r._assemblePoolCacheKey('coding');

    // 挑一个被 deferral/profile 过滤掉的 deferred 工具来触发 reveal。
    const hidden = [...deferred.keys()].find((n) => !before.has(n));
    if (hidden) {
      await r.ensureTool(hidden);
      const keyAfter = r._assemblePoolCacheKey('coding');
      assert.notStrictEqual(keyBefore, keyAfter, 'reveal 后缓存键必须变化');

      const after = r.assembleToolPool(undefined, 'coding');
      assert.notStrictEqual(after, before, 'reveal 后不得返回陈旧 Map 引用');

      // 与门关现建的真源逐字比对(同一 reveal 状态)。
      const off = withMemo('0', () => names(r.assembleToolPool(undefined, 'coding')));
      assert.deepStrictEqual(names(after), off);
    }

    // reset 也必须改指纹。
    const kBefore = r._assemblePoolCacheKey('coding');
    r.resetDeferredSession();
    const kAfter = r._assemblePoolCacheKey('coding');
    assert.notStrictEqual(kBefore, kAfter, 'reset 后缓存键必须变化');
  });
});

test('caller 传 denyRules 覆盖 → 始终重建、绝不写缓存(即便门开)', () => {
  withMemo('1', () => {
    r._resetAssemblePoolMemo();
    const a = r.assembleToolPool([], 'coding');
    const b = r.assembleToolPool([], 'coding');
    assert.notStrictEqual(a, b, 'denyRules 覆盖路径应每次重建');
    assert.strictEqual(r._assemblePoolMemoSize(), 0, 'denyRules 覆盖不应写入缓存');
  });
});

test('门关(0/off/false/no/OFF):不写缓存、每次现建新 Map', () => {
  for (const v of ['0', 'off', 'false', 'no', 'OFF']) {
    withMemo(v, () => {
      r._resetAssemblePoolMemo();
      const a = r.assembleToolPool(undefined, 'coding');
      const b = r.assembleToolPool(undefined, 'coding');
      assert.notStrictEqual(a, b, `门=${v} 时应每次现建新 Map`);
      assert.strictEqual(r._assemblePoolMemoSize(), 0, `门=${v} 时不应写入缓存`);
    });
  }
});
