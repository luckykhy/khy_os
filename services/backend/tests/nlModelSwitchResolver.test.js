'use strict';

/**
 * nlModelSwitchResolver — 纯叶子单测(node:test)。
 *
 * 覆盖:门控默认开/显式关、三重同现闸门(切换词 + 模型域词 + 已知厂商)、厂商别名、
 * 具体模型 ID 抽取、坏输入不抛、filterModelChoices 过滤、resolveDirectPick 唯一命中。
 * 全合成输入,零 IO。
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../src/cli/nlModelSwitchResolver');

const ON = {}; // 无门控键 → 默认开
const OFF = { KHY_NL_MODEL_SWITCH: '0' };

test('isEnabled: 默认开;显式 0/false/off/no 关', () => {
  assert.strictEqual(leaf.isEnabled({}), true);
  assert.strictEqual(leaf.isEnabled({ KHY_NL_MODEL_SWITCH: '' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
    assert.strictEqual(leaf.isEnabled({ KHY_NL_MODEL_SWITCH: v }), false, `should disable on ${v}`);
  }
  assert.strictEqual(leaf.isEnabled({ KHY_NL_MODEL_SWITCH: '1' }), true);
});

test('resolve: 「切换模型到 deepseek」→ {vendor:deepseek, model:\'\'}', () => {
  assert.deepStrictEqual(leaf.resolve('切换模型到 deepseek', ON), { vendor: 'deepseek', model: '' });
});

test('resolve: 具体模型「切换模型到 deepseek-reasoner」→ 带 model', () => {
  assert.deepStrictEqual(
    leaf.resolve('切换模型到 deepseek-reasoner', ON),
    { vendor: 'deepseek', model: 'deepseek-reasoner' },
  );
});

test('resolve: CJK 别名「换成智谱的模型」→ glm', () => {
  const r = leaf.resolve('帮我换成智谱的模型', ON);
  assert.ok(r && r.vendor === 'glm', 'should map 智谱 → glm');
});

test('resolve: 英文「switch model to deepseek」→ deepseek', () => {
  const r = leaf.resolve('please switch model to deepseek', ON);
  assert.ok(r && r.vendor === 'deepseek');
});

test('resolve: 未知厂商「切换模型到 foobar」→ null(不猜)', () => {
  assert.strictEqual(leaf.resolve('切换模型到 foobar', ON), null);
});

test('resolve: 缺模型域词「切换到 deepseek」→ null', () => {
  assert.strictEqual(leaf.resolve('切换到 deepseek', ON), null);
});

test('resolve: 缺切换动作词「deepseek 模型很好」→ null', () => {
  assert.strictEqual(leaf.resolve('deepseek 模型很好用', ON), null);
});

test('resolve: 门控关 → 恒 null(逐字节回退发给模型)', () => {
  assert.strictEqual(leaf.resolve('切换模型到 deepseek', OFF), null);
});

test('resolve: 坏输入(null/非串/超长)绝不抛 → null', () => {
  assert.strictEqual(leaf.resolve(null, ON), null);
  assert.strictEqual(leaf.resolve(undefined, ON), null);
  assert.strictEqual(leaf.resolve(12345, ON), null);
  assert.strictEqual(leaf.resolve({}, ON), null);
  assert.strictEqual(leaf.resolve('切换模型到 deepseek ' + 'x'.repeat(600), ON), null);
});

test('resolve: 裸厂商名不误当模型 ID(单段无分隔符)', () => {
  const r = leaf.resolve('切换模型到 deepseek', ON);
  assert.strictEqual(r.model, '', '单段 deepseek 是厂商名不是 model id');
});

// ── filterModelChoices ───────────────────────────────────────────────────────
const CHOICES = [
  { name: 'A', value: { adapter: 'deepseek', model: 'deepseek-chat' }, disabled: false },
  { name: 'B', value: { adapter: 'deepseek', model: 'deepseek-reasoner' }, disabled: false },
  { name: 'C', value: { adapter: 'trae', model: 'deepseek-v3' }, disabled: false },
  { name: 'D', value: { adapter: 'openai', model: 'gpt-4o' }, disabled: false },
  { name: 'E', value: { adapter: 'relay', model: null }, disabled: false },
];

test('filterModelChoices: vendor=deepseek 纳入官方+trae 的 deepseek-v3,剔除 gpt-4o', () => {
  const f = leaf.filterModelChoices(CHOICES, 'deepseek');
  const models = f.map((c) => c.value.model);
  assert.ok(models.includes('deepseek-chat'));
  assert.ok(models.includes('deepseek-reasoner'));
  assert.ok(models.includes('deepseek-v3'), 'trae 的 deepseek-v3 也算 deepseek 一个供应商');
  assert.ok(!models.includes('gpt-4o'));
});

test('filterModelChoices: vendor=openai 命中 gpt-4o(gpt token)', () => {
  const f = leaf.filterModelChoices(CHOICES, 'openai');
  assert.deepStrictEqual(f.map((c) => c.value.model), ['gpt-4o']);
});

test('filterModelChoices: 空 vendor / 无命中 → []', () => {
  assert.deepStrictEqual(leaf.filterModelChoices(CHOICES, ''), []);
  assert.deepStrictEqual(leaf.filterModelChoices(CHOICES, 'anthropic'), []);
  assert.deepStrictEqual(leaf.filterModelChoices(null, 'deepseek'), []);
  assert.deepStrictEqual(leaf.filterModelChoices([], 'deepseek'), []);
});

test('filterModelChoices: modelHint 精确匹配排前(不剔除其它)', () => {
  const f = leaf.filterModelChoices(CHOICES, 'deepseek', 'deepseek-reasoner');
  assert.strictEqual(f[0].value.model, 'deepseek-reasoner', '精确命中排第一');
  assert.strictEqual(f.length, 3, '其它 deepseek 项仍保留');
});

// ── resolveDirectPick ────────────────────────────────────────────────────────
test('resolveDirectPick: 唯一精确命中 → 返回该 value', () => {
  const f = leaf.filterModelChoices(CHOICES, 'deepseek', 'deepseek-reasoner');
  assert.deepStrictEqual(
    leaf.resolveDirectPick(f, 'deepseek-reasoner'),
    { adapter: 'deepseek', model: 'deepseek-reasoner' },
  );
});

test('resolveDirectPick: 两条同名 → null(交给选择器)', () => {
  const dup = [
    { name: 'X', value: { adapter: 'deepseek', model: 'deepseek-chat' }, disabled: false },
    { name: 'Y', value: { adapter: 'relay', model: 'deepseek-chat' }, disabled: false },
  ];
  assert.strictEqual(leaf.resolveDirectPick(dup, 'deepseek-chat'), null);
});

test('resolveDirectPick: 无 hint → null;disabled 不计', () => {
  const f = leaf.filterModelChoices(CHOICES, 'deepseek');
  assert.strictEqual(leaf.resolveDirectPick(f, ''), null);
  const dis = [{ name: 'Z', value: { adapter: 'deepseek', model: 'deepseek-chat' }, disabled: true }];
  assert.strictEqual(leaf.resolveDirectPick(dis, 'deepseek-chat'), null);
});
