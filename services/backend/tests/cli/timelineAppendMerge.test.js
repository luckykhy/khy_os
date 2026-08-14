'use strict';

/**
 * timelineAppendMerge 单测(纯叶子 + useQueryBridge LIVE wiring,node:test)。
 *
 * 关键不变量:
 *  - 门控:默认 on;off/0/false/no 关(CANON)。
 *  - 输出**逐字节等价**历史 `[...timeline.slice(0,-1), merged]`:ON 与 OFF 产出 deepEqual 数组,
 *    且尾段文本正确合并、前缀段引用保持不变(下游按段身份 memo 不受影响)。
 *  - 空 chunk → 原样返回传入引用(===)。
 *  - 尾段非同型 / 空时间线 → 追加新段。
 *  - **单次分配证据**:ON 路径不调用 Array.prototype.slice(0,-1)(用 spy 断言尾合并只 slice() 一次)。
 *  - 坏输入(非数组 timeline)安全:不抛,回退历史写法。
 *  - LIVE wiring:useQueryBridge.js 经 timelineAppendMerge.appendMergingLast('text'/'thinking')。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const leaf = require('../../src/cli/tui/timelineAppendMerge');

const ON = {};
const OFF = { KHY_TIMELINE_APPEND_SINGLE_ALLOC: 'off' };

// 历史内联参考实现(逐字节 oracle)。
function refAppend(timeline, text, type) {
  if (!text) return timeline;
  const last = timeline[timeline.length - 1];
  if (last && last.type === type) {
    return [...timeline.slice(0, -1), { type, text: last.text + text }];
  }
  return [...timeline, { type, text }];
}

test('isEnabled: default-on, CANON off-words', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_TIMELINE_APPEND_SINGLE_ALLOC: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(leaf.isEnabled({ KHY_TIMELINE_APPEND_SINGLE_ALLOC: off }), false, `off=${off}`);
  }
  assert.deepEqual(leaf.OFF_VALUES, ['0', 'false', 'off', 'no']);
});

test('空 chunk → 原样返回传入引用', () => {
  const tl = [{ type: 'text', text: 'a' }];
  assert.equal(leaf.appendMergingLast(tl, '', 'text', ON), tl, 'ON 空 chunk 同引用');
  assert.equal(leaf.appendMergingLast(tl, '', 'text', OFF), tl, 'OFF 空 chunk 同引用');
  assert.equal(leaf.appendMergingLast(tl, undefined, 'text', ON), tl);
});

test('尾段同型合并:ON/OFF 输出逐字节等价历史实现', () => {
  const base = [{ type: 'tool', tool: { name: 'x' } }, { type: 'text', text: 'Hel' }];
  const on = leaf.appendMergingLast(base, 'lo', 'text', ON);
  const off = leaf.appendMergingLast(base, 'lo', 'text', OFF);
  const ref = refAppend(base, 'lo', 'text');
  assert.deepEqual(on, ref, 'ON == 历史');
  assert.deepEqual(off, ref, 'OFF == 历史');
  assert.deepEqual(on, off, 'ON == OFF');
  // 尾段合并正确。
  assert.deepEqual(on[on.length - 1], { type: 'text', text: 'Hello' });
  assert.equal(on.length, 2);
});

test('尾段同型合并:前缀段引用保持不变(下游 memo 不受影响)', () => {
  const prefixTool = { type: 'tool', tool: { name: 'x' } };
  const base = [prefixTool, { type: 'text', text: 'Hel' }];
  const on = leaf.appendMergingLast(base, 'lo', 'text', ON);
  assert.equal(on[0], prefixTool, 'ON 前缀 tool 段同引用');
  const off = leaf.appendMergingLast(base, 'lo', 'text', OFF);
  assert.equal(off[0], prefixTool, 'OFF 前缀 tool 段同引用');
});

test('尾段非同型 → 追加新段(text 追在 tool 后)', () => {
  const base = [{ type: 'tool', tool: { name: 'x' } }];
  const on = leaf.appendMergingLast(base, 'hi', 'text', ON);
  assert.deepEqual(on, refAppend(base, 'hi', 'text'));
  assert.equal(on.length, 2);
  assert.deepEqual(on[1], { type: 'text', text: 'hi' });
});

test('空时间线 → 追加首段', () => {
  assert.deepEqual(leaf.appendMergingLast([], 'hi', 'text', ON), [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(leaf.appendMergingLast([], 'think', 'thinking', ON), [{ type: 'thinking', text: 'think' }]);
});

test('thinking 尾段合并同样逐字节等价', () => {
  const base = [{ type: 'thinking', text: 'foo' }];
  const on = leaf.appendMergingLast(base, 'bar', 'thinking', ON);
  assert.deepEqual(on, refAppend(base, 'bar', 'thinking'));
  assert.deepEqual(on[0], { type: 'thinking', text: 'foobar' });
});

test('thinking 与 text 不互相合并(尾段 text 时追加 thinking 新段)', () => {
  const base = [{ type: 'text', text: 'answer' }];
  const on = leaf.appendMergingLast(base, 'reasoning', 'thinking', ON);
  assert.deepEqual(on, refAppend(base, 'reasoning', 'thinking'));
  assert.equal(on.length, 2);
  assert.deepEqual(on[1], { type: 'thinking', text: 'reasoning' });
});

test('单次分配证据:ON 尾合并不调用 slice(0,-1)(只 slice() 一次全量)', () => {
  // 用带 spy 的数组子类观测 slice 调用参数。
  const calls = [];
  const base = [{ type: 'text', text: 'Hel' }];
  const spied = base.slice(); // 普通数组
  const origSlice = spied.slice.bind(spied);
  spied.slice = function (...args) { calls.push(args); return origSlice(...args); };
  const on = leaf.appendMergingLast(spied, 'lo', 'text', ON);
  // ON 尾合并路径:恰调用一次 slice()(无参),不调用 slice(0,-1)。
  assert.equal(calls.length, 1, `slice 调用一次(got ${calls.length})`);
  assert.deepEqual(calls[0], [], 'slice() 无参(全量复制),非 slice(0,-1)');
  assert.deepEqual(on[on.length - 1], { type: 'text', text: 'Hello' });

  // OFF 路径:调用 slice(0,-1)(历史双分配)。
  const calls2 = [];
  const spied2 = base.slice();
  const origSlice2 = spied2.slice.bind(spied2);
  spied2.slice = function (...args) { calls2.push(args); return origSlice2(...args); };
  leaf.appendMergingLast(spied2, 'lo', 'text', OFF);
  assert.ok(calls2.some((a) => a.length === 2 && a[0] === 0 && a[1] === -1), 'OFF 走 slice(0,-1) 历史双分配');
});

test('坏输入:非数组 timeline 不抛,回退历史写法', () => {
  let out;
  assert.doesNotThrow(() => { out = leaf.appendMergingLast(null, 'hi', 'text', ON); });
  assert.deepEqual(out, [{ type: 'text', text: 'hi' }]);
  assert.doesNotThrow(() => { out = leaf.appendMergingLast(undefined, 'x', 'thinking', ON); });
  assert.deepEqual(out, [{ type: 'thinking', text: 'x' }]);
});

test('流式多 chunk 累积:ON 逐 chunk 与历史 reducer 逐字节等价', () => {
  const chunks = ['He', 'llo', ', ', 'wor', 'ld'];
  let tlOn = [{ type: 'tool', tool: { name: 'seed' } }];
  let tlRef = [{ type: 'tool', tool: { name: 'seed' } }];
  for (const c of chunks) {
    tlOn = leaf.appendMergingLast(tlOn, c, 'text', ON);
    tlRef = refAppend(tlRef, c, 'text');
  }
  assert.deepEqual(tlOn, tlRef);
  assert.deepEqual(tlOn[tlOn.length - 1], { type: 'text', text: 'Hello, world' });
  assert.equal(tlOn.length, 2, '整段流式合并为单个尾 text 段');
});

test('LIVE wiring: useQueryBridge.js routes tlAppendText/tlAppendThinking through timelineAppendMerge', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/cli/tui/hooks/useQueryBridge.js'), 'utf8');
  assert.ok(/require\(['"]\.\.\/timelineAppendMerge['"]\)/.test(src), 'requires timelineAppendMerge leaf');
  assert.ok(/_timelineAppendMerge\.appendMergingLast\(timeline,\s*text,\s*'text',\s*process\.env\)/.test(src),
    'tlAppendText delegates with type "text"');
  assert.ok(/_timelineAppendMerge\.appendMergingLast\(timeline,\s*text,\s*'thinking',\s*process\.env\)/.test(src),
    'tlAppendThinking delegates with type "thinking"');
  // 历史内联双分配表达式应已从两函数移除(避免残留旧路径)。
  assert.ok(!/timeline\.slice\(0,\s*-1\),\s*\{\s*type:\s*'text'/.test(src), 'tlAppendText 旧内联双分配已移除');
  assert.ok(!/timeline\.slice\(0,\s*-1\),\s*\{\s*type:\s*'thinking'/.test(src), 'tlAppendThinking 旧内联双分配已移除');
});
