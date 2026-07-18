'use strict';

// promptPrefixShape 契约测试 — 纯叶子(缓存前缀归因)。对标 Reasonix cache_shape.go
// (CaptureShape/CompareShape)。零 IO 零网络;SHA-256 是确定性哈希。
const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/constants/promptPrefixShape');

const SYS_A = 'You are khy. Static prefix. Be concise.';
const SYS_B = 'You are khy. Static prefix. Be concise. NOW: 2026-07-03 12:00'; // 时钟变了
const TOOLS = [
  { name: 'Read', description: 'read a file', input_schema: { type: 'object' } },
  { name: 'Edit', description: 'edit a file', input_schema: { type: 'object' } },
  { name: 'Bash', description: 'run a command', input_schema: { type: 'object' } },
];

test('isPrefixShapeEnabled:默认开,标准 falsy 串关', () => {
  assert.strictEqual(leaf.isPrefixShapeEnabled({}), true);
  assert.strictEqual(leaf.isPrefixShapeEnabled(undefined), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(leaf.isPrefixShapeEnabled({ KHY_CACHE_PREFIX_SHAPE: off }), false, `应关: ${off}`);
  }
});

test('captureShape:门控关 → null(逐字节回退不显示归因)', () => {
  const s = leaf.captureShape({ system: SYS_A, tools: TOOLS }, { KHY_CACHE_PREFIX_SHAPE: 'off' });
  assert.strictEqual(s, null);
});

test('captureShape:确定性——同输入同哈希;含 systemBytes/toolCount', () => {
  const s1 = leaf.captureShape({ system: SYS_A, tools: TOOLS }, {});
  const s2 = leaf.captureShape({ system: SYS_A, tools: TOOLS }, {});
  assert.deepStrictEqual(s1, s2, '同输入 → 逐字段相同(确定性)');
  assert.strictEqual(s1.toolCount, 3);
  assert.strictEqual(s1.systemBytes, Buffer.byteLength(SYS_A, 'utf8'));
  assert.match(s1.systemHash, /^[0-9a-f]{16}$/);
});

test('compareShape:首轮(prev=null)→ 无归因', () => {
  const cur = leaf.captureShape({ system: SYS_A, tools: TOOLS }, {});
  const r = leaf.compareShape(null, cur);
  assert.strictEqual(r.changed, false);
  assert.deepStrictEqual(r.reasons, []);
  assert.strictEqual(r.prefixHash, cur.prefixHash);
});

test('compareShape:系统提示变(时钟)→ reasons=[system]', () => {
  const a = leaf.captureShape({ system: SYS_A, tools: TOOLS }, {});
  const b = leaf.captureShape({ system: SYS_B, tools: TOOLS }, {});
  const r = leaf.compareShape(a, b);
  assert.deepStrictEqual(r.reasons, ['system']);
  assert.strictEqual(r.changed, true);
});

test('compareShape:工具增删 → reasons 含 tools', () => {
  const a = leaf.captureShape({ system: SYS_A, tools: TOOLS }, {});
  const b = leaf.captureShape({ system: SYS_A, tools: TOOLS.slice(0, 2) }, {});
  const r = leaf.compareShape(a, b);
  assert.ok(r.reasons.includes('tools'), '工具集变应报 tools');
  assert.ok(!r.reasons.includes('order'), '真增删不应同时报 order(tools 优先)');
});

test('compareShape:仅工具顺序抖动 → reasons=[order](归一后集合相同)', () => {
  const a = leaf.captureShape({ system: SYS_A, tools: TOOLS }, {});
  const shuffled = [TOOLS[2], TOOLS[0], TOOLS[1]]; // 同一集合,顺序不同
  const b = leaf.captureShape({ system: SYS_A, tools: shuffled }, {});
  const r = leaf.compareShape(a, b);
  assert.deepStrictEqual(r.reasons, ['order'], '仅重排 → toolsHash 同、orderHash 异 → order');
});

test('compareShape:全同 → 无变化(命中稳定前缀的理想态)', () => {
  const a = leaf.captureShape({ system: SYS_A, tools: TOOLS }, {});
  const b = leaf.captureShape({ system: SYS_A, tools: TOOLS }, {});
  const r = leaf.compareShape(a, b);
  assert.strictEqual(r.changed, false);
  assert.deepStrictEqual(r.reasons, []);
});

test('describeReasons:空 → null;有值 → 中文一行', () => {
  assert.strictEqual(leaf.describeReasons([]), null);
  assert.strictEqual(leaf.describeReasons(null), null);
  assert.match(leaf.describeReasons(['system']), /系统提示/);
  assert.match(leaf.describeReasons(['system', 'tools']), /系统提示、工具集/);
  assert.match(leaf.describeReasons(['order']), /工具顺序/);
});

test('坏输入绝不抛:非字符串 system / 非数组 tools / null 段', () => {
  assert.doesNotThrow(() => leaf.captureShape(null, {}));
  assert.doesNotThrow(() => leaf.captureShape({ system: 123, tools: 'nope' }, {}));
  assert.doesNotThrow(() => leaf.captureShape({ system: SYS_A, tools: [null, {}, { name: 'X' }] }, {}));
  const s = leaf.captureShape({ system: SYS_A, tools: [null, {}, { name: 'X' }] }, {});
  assert.strictEqual(s.toolCount, 3, 'toolCount 反映原数组长度(坏段计入长度但不进归一)');
  assert.doesNotThrow(() => leaf.compareShape('bad', 'input'));
});
