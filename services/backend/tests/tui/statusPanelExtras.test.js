'use strict';

// statusPanelExtras 叶子契约测试(node:test)。
// 覆盖:门控开关、model(+adapter 后缀/友好名注入)、account、git ahead-behind 后缀、
// 门控关/坏输入 → 三片全空、绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const { statusPanelDetailEnabled, buildStatusPanelExtras } = require('../../src/cli/statusPanelExtras');

test('门控默认开(unset/空/未知),{0,false,off,no} 关', () => {
  assert.strictEqual(statusPanelDetailEnabled({}), true);
  assert.strictEqual(statusPanelDetailEnabled({ KHY_STATUS_PANEL_DETAIL: '' }), true);
  assert.strictEqual(statusPanelDetailEnabled({ KHY_STATUS_PANEL_DETAIL: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(statusPanelDetailEnabled({ KHY_STATUS_PANEL_DETAIL: off }), false, JSON.stringify(off));
  }
});

test('buildStatusPanelExtras: model 套友好名 + adapter 后缀', () => {
  const labelFn = (m) => (m === 'claude-opus-4-8' ? 'Opus 4.8' : m);
  const r = buildStatusPanelExtras(
    { lastModel: 'claude-opus-4-8', lastAdapter: 'relay' },
    { formatModelLabel: labelFn },
    {},
  );
  assert.strictEqual(r.model, 'Opus 4.8/relay');
});

test('buildStatusPanelExtras: adapter 等于模型名/友好名时不加后缀', () => {
  const r1 = buildStatusPanelExtras({ lastModel: 'gpt-4o', lastAdapter: 'gpt-4o' }, {}, {});
  assert.strictEqual(r1.model, 'gpt-4o');
  const labelFn = (m) => 'Sonnet';
  const r2 = buildStatusPanelExtras({ lastModel: 'x', lastAdapter: 'Sonnet' }, { formatModelLabel: labelFn }, {});
  assert.strictEqual(r2.model, 'Sonnet');
});

test('buildStatusPanelExtras: 无 lastModel → model 为 null', () => {
  const r = buildStatusPanelExtras({ lastAdapter: 'relay' }, {}, {});
  assert.strictEqual(r.model, null);
});

test('buildStatusPanelExtras: 缺省 labelFn 恒等(raw slug)', () => {
  const r = buildStatusPanelExtras({ lastModel: 'claude-opus-4-8' }, {}, {});
  assert.strictEqual(r.model, 'claude-opus-4-8');
});

test('buildStatusPanelExtras: labelFn 抛出 → 回退 raw model,不冒泡', () => {
  const r = buildStatusPanelExtras(
    { lastModel: 'm' },
    { formatModelLabel: () => { throw new Error('boom'); } },
    {},
  );
  assert.strictEqual(r.model, 'm');
});

test('buildStatusPanelExtras: account 取 accountEmail', () => {
  assert.strictEqual(buildStatusPanelExtras({ accountEmail: 'a@b.com' }, {}, {}).account, 'a@b.com');
  assert.strictEqual(buildStatusPanelExtras({ accountEmail: '   ' }, {}, {}).account, null);
  assert.strictEqual(buildStatusPanelExtras({}, {}, {}).account, null);
});

test('buildStatusPanelExtras: git ahead/behind 后缀(镜像 /hud 面板措辞)', () => {
  assert.strictEqual(buildStatusPanelExtras({ git: { ahead: 2, behind: 1 } }, {}, {}).gitSuffix, ' +2 ahead -1 behind');
  assert.strictEqual(buildStatusPanelExtras({ git: { ahead: 3, behind: 0 } }, {}, {}).gitSuffix, ' +3 ahead');
  assert.strictEqual(buildStatusPanelExtras({ git: { ahead: 0, behind: 4 } }, {}, {}).gitSuffix, ' -4 behind');
  assert.strictEqual(buildStatusPanelExtras({ git: {} }, {}, {}).gitSuffix, '');
  // 负数/非有限 → 视为 0(不产后缀)
  assert.strictEqual(buildStatusPanelExtras({ git: { ahead: -1, behind: NaN } }, {}, {}).gitSuffix, '');
});

test('buildStatusPanelExtras: 门控关 → 三片全空(逐字节回退刀94前)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    const r = buildStatusPanelExtras(
      { lastModel: 'claude-opus-4-8', accountEmail: 'a@b.com', git: { ahead: 2, behind: 1 } },
      { formatModelLabel: (m) => 'Opus 4.8' },
      { KHY_STATUS_PANEL_DETAIL: off },
    );
    assert.deepStrictEqual(r, { model: null, account: null, gitSuffix: '' }, off);
  }
});

test('buildStatusPanelExtras: 坏输入 → 三片全空(绝不抛)', () => {
  const empty = { model: null, account: null, gitSuffix: '' };
  assert.deepStrictEqual(buildStatusPanelExtras(null, {}, {}), empty);
  assert.deepStrictEqual(buildStatusPanelExtras(undefined, {}, {}), empty);
  assert.deepStrictEqual(buildStatusPanelExtras('nope', {}, {}), empty);
  assert.deepStrictEqual(buildStatusPanelExtras(42, {}, {}), empty);
  assert.doesNotThrow(() => buildStatusPanelExtras({ git: 'bad', lastModel: 5 }, {}, {}));
});

test('buildStatusPanelExtras: 三片齐全的完整形态', () => {
  const r = buildStatusPanelExtras(
    { lastModel: 'claude-opus-4-8', lastAdapter: 'relay', accountEmail: 'me@x.io', git: { ahead: 1, behind: 2 } },
    { formatModelLabel: (m) => 'Opus 4.8' },
    {},
  );
  assert.deepStrictEqual(r, { model: 'Opus 4.8/relay', account: 'me@x.io', gitSuffix: ' +1 ahead -2 behind' });
});
