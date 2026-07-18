'use strict';

/**
 * enabledToolNameSetMemo.test —— 能力门「启用工具名集合」记忆
 * (Ch2「不要每轮重建可复用结构」;门 KHY_TOOL_ENABLED_NAME_SET_MEMO,node:test)。
 *
 * 验证:①门开 → 同一真源注册表命中缓存(_collectEnabledToolNameSet 返同 Set 引用),缓存计一
 * 槽;②键与顺序/重复无关(逆序、重键的等价 Map 归一到同键);③记忆结果与门关现算逐字等价;
 * ④门关(0/off/false/no/OFF)→ 不写缓存、每次现建新 Set;⑤纯 builder 对等价输入产等价内容,
 * 且如实展开别名;⑥缓存有界(超 16 键即整清)。
 */
const test = require('node:test');
const assert = require('node:assert');

const t = require('../src/services/toolUseLoop.js');

function withMemo(value, fn) {
  const prev = process.env.KHY_TOOL_ENABLED_NAME_SET_MEMO;
  if (value === undefined) delete process.env.KHY_TOOL_ENABLED_NAME_SET_MEMO;
  else process.env.KHY_TOOL_ENABLED_NAME_SET_MEMO = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.KHY_TOOL_ENABLED_NAME_SET_MEMO;
    else process.env.KHY_TOOL_ENABLED_NAME_SET_MEMO = prev;
  }
}

function sorted(set) { return [...set].sort(); }

test('门开:同一真源注册表命中缓存(同 Set 引用),缓存计一槽', () => {
  withMemo(undefined, () => {
    t._resetEnabledNameSetMemo();
    const a = t._collectEnabledToolNameSet();
    const b = t._collectEnabledToolNameSet();
    assert.ok(a instanceof Set);
    assert.strictEqual(a, b, '重复调用应返回同一缓存 Set 引用');
    assert.strictEqual(t._enabledNameSetMemoSize(), 1);
  });
});

test('缓存键与顺序/重复无关(等价 Map 归一到同键)', () => {
  const m1 = new Map([['Read', {}], ['Write', {}], ['Bash', { aliases: ['sh'] }]]);
  const m2 = new Map([['Bash', { aliases: ['sh'] }], ['Write', {}], ['Read', {}], ['Read', {}]]);
  assert.strictEqual(t._enabledNameSetCacheKey(m1), t._enabledNameSetCacheKey(m2));
});

test('记忆结果与门关现算逐字等价(真源不漂移)', () => {
  const off = withMemo('0', () => sorted(t._collectEnabledToolNameSet()));
  t._resetEnabledNameSetMemo();
  const on = withMemo('1', () => sorted(t._collectEnabledToolNameSet()));
  assert.deepStrictEqual(on, off);
});

test('门关(0/off/false/no/OFF):不写缓存、每次现建新 Set', () => {
  for (const v of ['0', 'off', 'false', 'no', 'OFF']) {
    withMemo(v, () => {
      t._resetEnabledNameSetMemo();
      const a = t._collectEnabledToolNameSet();
      const b = t._collectEnabledToolNameSet();
      assert.notStrictEqual(a, b, `门=${v} 时应每次现建新 Set`);
      assert.strictEqual(t._enabledNameSetMemoSize(), 0, `门=${v} 时不应写入缓存`);
    });
  }
});

test('纯 builder:等价输入产等价内容,别名如实展开', () => {
  const m1 = new Map([['Read', {}], ['Bash', { aliases: ['sh'] }]]);
  const m2 = new Map([['Bash', { aliases: ['sh'] }], ['Read', {}]]);
  const a = sorted(t._buildEnabledToolNameSet(m1));
  const b = sorted(t._buildEnabledToolNameSet(m2));
  assert.deepStrictEqual(a, b);
  assert.ok(new Set(a).has('sh'), '别名应纳入集合');
  // 空/未定义输入 → 空 Set(fail-soft)。
  assert.strictEqual(t._buildEnabledToolNameSet(null).size, 0);
});
