'use strict';

/**
 * knownToolNameSetMemo.test —— ToolLoopDetector 已知工具名集合记忆
 * (Ch2「不要每轮重建可复用结构」;门 KHY_TOOL_KNOWN_NAME_SET_MEMO,node:test)。
 *
 * 验证:①门开 → 同一启用工具集合命中缓存(同引用),缓存计一槽;②键与输入顺序无关
 * (逆序 Map 命中同一条目);③记忆结果与「门关现算」逐字等价(真源不漂移);④不同集合 →
 * 不同缓存条目;⑤门关(0/off/false/no/OFF)→ 不写缓存、每次现建;⑥缓存有界:超 16 个不同
 * 键即整清;⑦别名/自然语言映射如实纳入(结构自证)。
 */
const test = require('node:test');
const assert = require('node:assert');

const t = require('../src/services/toolUseLoop.js');

function withMemo(value, fn) {
  const prev = process.env.KHY_TOOL_KNOWN_NAME_SET_MEMO;
  if (value === undefined) delete process.env.KHY_TOOL_KNOWN_NAME_SET_MEMO;
  else process.env.KHY_TOOL_KNOWN_NAME_SET_MEMO = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.KHY_TOOL_KNOWN_NAME_SET_MEMO;
    else process.env.KHY_TOOL_KNOWN_NAME_SET_MEMO = prev;
  }
}

function toolMap(entries) {
  return new Map(entries.map(([name, aliases]) => [name, { aliases: aliases || [] }]));
}

const BASE = toolMap([
  ['Read', ['read_file']],
  ['Write', ['write_file']],
  ['Bash', ['shell_command']],
  ['Agent', []],
  ['Grep', ['grep']],
]);

test('门开:同一启用集合命中缓存(同引用),缓存计一槽', () => {
  withMemo(undefined, () => {
    t._resetKnownNameMemo();
    const a = t._resolveKnownToolNames(BASE);
    const b = t._resolveKnownToolNames(BASE);
    assert.strictEqual(a, b, '重复调用应返回同一缓存数组引用');
    assert.strictEqual(t._knownNameMemoSize(), 1);
  });
});

test('键与输入顺序无关(逆序 Map 命中同一条目)', () => {
  withMemo(undefined, () => {
    t._resetKnownNameMemo();
    const base = t._resolveKnownToolNames(BASE);
    const rev = t._resolveKnownToolNames(new Map([...BASE].reverse()));
    assert.strictEqual(rev, base, '逆序集合应命中同一缓存条目');
    assert.strictEqual(t._knownNameMemoSize(), 1);
  });
});

test('记忆结果与门关现算逐字等价(真源不漂移)', () => {
  const off = withMemo('0', () => t._computeKnownToolNames(BASE).slice().sort());
  t._resetKnownNameMemo();
  const on = withMemo('1', () => t._resolveKnownToolNames(BASE).slice().sort());
  assert.deepStrictEqual(on, off);
});

test('不同集合 → 不同缓存条目', () => {
  withMemo(undefined, () => {
    t._resetKnownNameMemo();
    const a = t._resolveKnownToolNames(BASE);
    const b = t._resolveKnownToolNames(toolMap([['Read', []]]));
    assert.notStrictEqual(a, b);
    assert.strictEqual(t._knownNameMemoSize(), 2);
  });
});

test('门关(0/off/false/no/OFF):不写缓存、每次现建', () => {
  for (const v of ['0', 'off', 'false', 'no', 'OFF']) {
    withMemo(v, () => {
      t._resetKnownNameMemo();
      t._resolveKnownToolNames(BASE);
      t._resolveKnownToolNames(toolMap([['Read', []]]));
      assert.strictEqual(t._knownNameMemoSize(), 0, `门=${v} 时不应写入缓存`);
    });
  }
});

test('缓存有界:超 16 个不同键即整清', () => {
  withMemo(undefined, () => {
    t._resetKnownNameMemo();
    for (let i = 0; i < 17; i++) {
      t._resolveKnownToolNames(toolMap([[`ToolMarker${i}`, []], ['Read', []]]));
    }
    assert.ok(t._knownNameMemoSize() <= 16, `缓存不得无界增长,实际=${t._knownNameMemoSize()}`);
  });
});

test('别名与自然语言映射如实纳入(结构自证)', () => {
  const names = t._computeKnownToolNames(BASE);
  const set = new Set(names);
  // 直接工具名及其归一化变体。
  assert.ok(set.has('Read'));
  assert.ok(set.has('read_file'), '别名应纳入');
  // 固定常见名列表(bash/shell_command 等)总被登记,与输入无关。
  assert.ok(set.has('shell_command'));
  assert.ok(set.has('bash'));
});
