'use strict';

// contextPanelDetail 叶子契约测试(node:test)。
// 核心:/context 追加 Model / Requests / 上限来源(诚实标注)三类详情行,
// 门控关 → [] 逐字节回退(router 不追加任何行)。绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const {
  contextPanelDetailEnabled,
  buildContextDetailLines,
  buildContextIdentityLines,
} = require('../../src/cli/contextPanelDetail');

test('门控默认开(unset / 空 / 未知值),{0,false,off,no} 关', () => {
  assert.strictEqual(contextPanelDetailEnabled({}), true);
  assert.strictEqual(contextPanelDetailEnabled({ KHY_CONTEXT_PANEL_DETAIL: '' }), true);
  assert.strictEqual(contextPanelDetailEnabled({ KHY_CONTEXT_PANEL_DETAIL: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      contextPanelDetailEnabled({ KHY_CONTEXT_PANEL_DETAIL: off }),
      false,
      `${JSON.stringify(off)} 应关`,
    );
  }
});

test('门控开:全字段齐 → Model / Requests / 上限来源(适配器真值)', () => {
  const on = { KHY_CONTEXT_PANEL_DETAIL: '1' };
  const lines = buildContextDetailLines(
    { model: 'claude-opus-4-8', requestCount: 7, limitSource: 'adapter' },
    on,
  );
  assert.deepStrictEqual(lines, [
    'Model: claude-opus-4-8',
    'Requests: 7',
    '上限来源: 适配器真值',
  ]);
});

test('门控开:回退态 → 上限来源标注回退估算', () => {
  const on = { KHY_CONTEXT_PANEL_DETAIL: '1' };
  const lines = buildContextDetailLines(
    { model: 'gpt-x', requestCount: 3, limitSource: 'env-fallback' },
    on,
  );
  assert.deepStrictEqual(lines, [
    'Model: gpt-x',
    'Requests: 3',
    '上限来源: 回退估算（未取到适配器真值）',
  ]);
});

test('门控开:缺字段各自省略(model 空 / requestCount≤0 / limitSource 未知)', () => {
  const on = { KHY_CONTEXT_PANEL_DETAIL: '1' };
  // model 空 → 无 Model 行;requestCount 0 → 无 Requests 行;limitSource 未知 → 无来源行
  assert.deepStrictEqual(
    buildContextDetailLines({ model: '', requestCount: 0, limitSource: 'weird' }, on),
    [],
  );
  // 只有 requestCount
  assert.deepStrictEqual(
    buildContextDetailLines({ requestCount: 12 }, on),
    ['Requests: 12'],
  );
  // 只有 model + adapter,requestCount 缺
  assert.deepStrictEqual(
    buildContextDetailLines({ model: 'm1', limitSource: 'adapter' }, on),
    ['Model: m1', '上限来源: 适配器真值'],
  );
});

test('门控开:requestCount 畸形(负/非数/小数)稳健处理', () => {
  const on = { KHY_CONTEXT_PANEL_DETAIL: '1' };
  assert.deepStrictEqual(buildContextDetailLines({ requestCount: -5 }, on), []);
  assert.deepStrictEqual(buildContextDetailLines({ requestCount: 'NaN' }, on), []);
  assert.deepStrictEqual(buildContextDetailLines({ requestCount: 4.9 }, on), ['Requests: 4']);
  // model 去空白
  assert.deepStrictEqual(buildContextDetailLines({ model: '  m2  ' }, on), ['Model: m2']);
});

test('门控关 → [] 逐字节回退(丢全部详情行)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.deepStrictEqual(
      buildContextDetailLines(
        { model: 'claude-opus-4-8', requestCount: 7, limitSource: 'adapter' },
        { KHY_CONTEXT_PANEL_DETAIL: off },
      ),
      [],
      `门控关(${off})应返回 []`,
    );
  }
});

test('缺 stats / null 不抛(返回 [])', () => {
  const on = { KHY_CONTEXT_PANEL_DETAIL: '1' };
  assert.deepStrictEqual(buildContextDetailLines(undefined, on), []);
  assert.deepStrictEqual(buildContextDetailLines(null, on), []);
  assert.deepStrictEqual(buildContextDetailLines({}, on), []);
});

// ── 刀103:buildContextIdentityLines —— 交互中文孪生的 模型 + 上限来源(不含 Requests) ──
test('刀103 identity 门控开:model + adapter → 模型 + 上限来源(中文·无 Requests)', () => {
  const on = { KHY_CONTEXT_PANEL_DETAIL: '1' };
  assert.deepStrictEqual(
    buildContextIdentityLines({ model: 'claude-opus-4-8', requestCount: 7, limitSource: 'adapter' }, on),
    ['模型: claude-opus-4-8', '上限来源: 适配器真值'],
  );
});

test('刀103 identity 门控开:回退态 → 上限来源标注回退估算', () => {
  const on = { KHY_CONTEXT_PANEL_DETAIL: '1' };
  assert.deepStrictEqual(
    buildContextIdentityLines({ model: 'gpt-x', limitSource: 'env-fallback' }, on),
    ['模型: gpt-x', '上限来源: 回退估算（未取到适配器真值）'],
  );
});

test('刀103 identity 门控开:刻意不含 Requests(即便 requestCount 有值)', () => {
  const on = { KHY_CONTEXT_PANEL_DETAIL: '1' };
  const lines = buildContextIdentityLines({ model: 'm1', requestCount: 99, limitSource: 'adapter' }, on);
  assert.ok(!lines.some((l) => /Requests|请求次数/.test(l)), '身份行绝不含请求数(中文孪生自印)');
  assert.deepStrictEqual(lines, ['模型: m1', '上限来源: 适配器真值']);
});

test('刀103 identity 门控开:缺字段各自省略(model 空 / limitSource 未知)', () => {
  const on = { KHY_CONTEXT_PANEL_DETAIL: '1' };
  assert.deepStrictEqual(buildContextIdentityLines({ model: '', limitSource: 'weird' }, on), []);
  assert.deepStrictEqual(buildContextIdentityLines({ model: '  m2  ' }, on), ['模型: m2']);
  assert.deepStrictEqual(buildContextIdentityLines({ limitSource: 'adapter' }, on), ['上限来源: 适配器真值']);
});

test('刀103 identity 门控关 → [] 逐字节回退(两孪生不追加身份行)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.deepStrictEqual(
      buildContextIdentityLines({ model: 'claude-opus-4-8', limitSource: 'adapter' }, { KHY_CONTEXT_PANEL_DETAIL: off }),
      [],
      `门控关(${off})应返回 []`,
    );
  }
});

test('刀103 identity 缺 stats / null 不抛(返回 [])', () => {
  const on = { KHY_CONTEXT_PANEL_DETAIL: '1' };
  assert.deepStrictEqual(buildContextIdentityLines(undefined, on), []);
  assert.deepStrictEqual(buildContextIdentityLines(null, on), []);
  assert.deepStrictEqual(buildContextIdentityLines({}, on), []);
});
