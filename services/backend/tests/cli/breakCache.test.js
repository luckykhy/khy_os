'use strict';

// break-cache 契约测试:纯叶子(scope/nonce/聚合/措辞)+ 薄壳 state(marker 消费往返)。
// 对齐 CC /break-cache 背后逻辑:前缀注入 nonce → 缓存哈希失效。零网络。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const leaf = require('../../src/cli/breakCache');

// ── 纯叶子 ──
test('isEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(leaf.isEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(leaf.isEnabled({ KHY_BREAK_CACHE: off }), false, `应关: ${off}`);
  }
});

test('parseScope:对齐 CC 各形归一', () => {
  assert.strictEqual(leaf.parseScope([]), 'once');
  assert.strictEqual(leaf.parseScope(['once']), 'once');
  assert.strictEqual(leaf.parseScope(['always']), 'always');
  assert.strictEqual(leaf.parseScope(['off']), 'off');
  assert.strictEqual(leaf.parseScope(['status']), 'status');
  assert.strictEqual(leaf.parseScope(['--clear']), 'clear');
  assert.strictEqual(leaf.parseScope(['clear']), 'clear');
  assert.strictEqual(leaf.parseScope(['ALWAYS']), 'always');
  assert.strictEqual(leaf.parseScope(['garbage']), 'unknown');
});

test('buildNonceComment:HTML 注释 + 换行,now/rand 注入 → 确定性 + 唯一性', () => {
  const a = leaf.buildNonceComment(1000, 'abcdef01');
  assert.strictEqual(a, '<!-- khy-break-cache 1000-abcdef01 -->\n');
  // 不同 rand → 不同串(=不同哈希 → 缓存击穿)
  assert.notStrictEqual(a, leaf.buildNonceComment(1000, 'deadbeef'));
  // 非法字符剔除 + 非数 now 守卫
  assert.match(leaf.buildNonceComment('x', 'a/b!c'), /khy-break-cache 0-abc -->/);
});

test('aggregateStats:聚合追加日志(对齐 CC readStats),容错坏行', () => {
  const log = [
    JSON.stringify({ at: 't1', kind: 'once' }),
    'GARBAGE LINE',
    JSON.stringify({ at: 't2', kind: 'always_on' }),
    JSON.stringify({ at: 't3', kind: 'once' }),
  ].join('\n');
  const s = leaf.aggregateStats(log);
  assert.strictEqual(s.totalBreaks, 2, 'two once events');
  assert.strictEqual(s.lastBreakAt, 't3', 'last event timestamp');
  assert.strictEqual(s.alwaysModeEnabled, true, 'last always event is always_on');
  // 空 → 安全默认
  assert.deepStrictEqual(leaf.aggregateStats(''), { totalBreaks: 0, lastBreakAt: null, alwaysModeEnabled: false });
});

test('aggregateStats:always_off 后 alwaysModeEnabled=false', () => {
  const log = [
    JSON.stringify({ at: 't1', kind: 'always_on' }),
    JSON.stringify({ at: 't2', kind: 'always_off' }),
  ].join('\n');
  assert.strictEqual(leaf.aggregateStats(log).alwaysModeEnabled, false);
});

test('formatters:措辞含关键信息', () => {
  assert.match(leaf.formatStatus({ totalBreaks: 5, lastBreakAt: 'X' }, true, false), /已就绪/);
  assert.match(leaf.formatAlways('/p/always'), /持久缓存击穿/);
  assert.match(leaf.formatOnce({ totalBreaks: 3 }, '/p/marker'), /一次性缓存击穿/);
  assert.match(leaf.USAGE_TEXT, /break-cache/);
});

// ── 薄壳 state:marker 消费往返 ──
test('state:once → 网关消费注入一次 nonce 后删除 marker(一次性)', () => {
  // 独立数据根,避免污染真实 ~/.khy
  const tmp = fs.mkdtempSync(require('os').tmpdir() + '/bc-test-');
  const saved = process.env.KHY_DATA_HOME;
  const savedGate = process.env.KHY_BREAK_CACHE;
  process.env.KHY_DATA_HOME = tmp;
  delete process.env.KHY_BREAK_CACHE; // 默认开
  // 清模块缓存,让 dataHome 重新解析 KHY_DATA_HOME
  for (const k of Object.keys(require.cache)) {
    if (/breakCacheState|dataHome/.test(k)) delete require.cache[k];
  }
  try {
    const state = require('../../src/services/gateway/breakCacheState');
    const { marker } = state.scheduleOnce();
    assert.ok(fs.existsSync(marker), 'marker 已写');

    // 第一次消费 → 注入 nonce 且删除 marker
    const n1 = state.consumeCacheBreakNonce(process.env);
    assert.match(n1, /khy-break-cache/, '第一次注入 nonce');
    assert.ok(!fs.existsSync(marker), '一次性:marker 已被消费删除');

    // 第二次消费 → 无 marker 无 flag → 空(不再注入)
    const n2 = state.consumeCacheBreakNonce(process.env);
    assert.strictEqual(n2, '', '一次性:第二次不再注入');
  } finally {
    if (saved === undefined) delete process.env.KHY_DATA_HOME; else process.env.KHY_DATA_HOME = saved;
    if (savedGate === undefined) delete process.env.KHY_BREAK_CACHE; else process.env.KHY_BREAK_CACHE = savedGate;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('state:always → 每次消费都注入(flag 不消费);off 清除后停止', () => {
  const tmp = fs.mkdtempSync(require('os').tmpdir() + '/bc-test2-');
  const saved = process.env.KHY_DATA_HOME;
  process.env.KHY_DATA_HOME = tmp;
  delete process.env.KHY_BREAK_CACHE;
  for (const k of Object.keys(require.cache)) {
    if (/breakCacheState|dataHome/.test(k)) delete require.cache[k];
  }
  try {
    const state = require('../../src/services/gateway/breakCacheState');
    state.enableAlways();
    assert.match(state.consumeCacheBreakNonce(process.env), /khy-break-cache/, 'always 第一次注入');
    assert.match(state.consumeCacheBreakNonce(process.env), /khy-break-cache/, 'always 第二次仍注入(flag 不消费)');
    const cleared = state.disable();
    assert.strictEqual(cleared, true, 'off 清除了 flag');
    assert.strictEqual(state.consumeCacheBreakNonce(process.env), '', 'off 后不再注入');
  } finally {
    if (saved === undefined) delete process.env.KHY_DATA_HOME; else process.env.KHY_DATA_HOME = saved;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('state:门控关 → consumeCacheBreakNonce 恒空(网关字节回退,绝不注入)', () => {
  const tmp = fs.mkdtempSync(require('os').tmpdir() + '/bc-test3-');
  const saved = process.env.KHY_DATA_HOME;
  const savedGate = process.env.KHY_BREAK_CACHE;
  process.env.KHY_DATA_HOME = tmp;
  delete process.env.KHY_BREAK_CACHE;
  for (const k of Object.keys(require.cache)) {
    if (/breakCacheState|dataHome/.test(k)) delete require.cache[k];
  }
  try {
    const state = require('../../src/services/gateway/breakCacheState');
    state.scheduleOnce(); // marker 存在
    // 但门控关 → 恒空,且不消费 marker(尊重字节回退语义)
    process.env.KHY_BREAK_CACHE = 'off';
    assert.strictEqual(state.consumeCacheBreakNonce(process.env), '', '门控关恒空');
  } finally {
    if (saved === undefined) delete process.env.KHY_DATA_HOME; else process.env.KHY_DATA_HOME = saved;
    if (savedGate === undefined) delete process.env.KHY_BREAK_CACHE; else process.env.KHY_BREAK_CACHE = savedGate;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
