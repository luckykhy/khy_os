'use strict';

// regionLayout.test.js — khyOS TUI 区域划分 SSOT(regionLayout.js)的契约测试。
//
// 关注点:
//   • REGION 25 个 ID 冻结(9 顶层 + 6 大区 + 10 小区),三层结构不可漂移;
//   • OWNING_OVERLAYS 6 个 key 全部存在,hideChrome 字段类型为 boolean;
//   • overlaysHidingChrome:空 → [];only-hideChrome=false → [];混合 → 只列 true;
//   • ownsLiveRegion 在 regionLayout 缺席时仍能字节级回退(modelPicker || khyosOpen)。
//
// 设计意图:这些约束是「一改全改」的护栏 —— 任何对区域顺序、覆盖层注册表的破坏
// 都必须显式更新本测试,而不是悄悄让 lint 通过。

const test = require('node:test');
const assert = require('node:assert/strict');

const rlPath = '../../../src/cli/tui/ink-components/regionLayout';
const ovPath = '../../../src/cli/tui/ink-components/overlayLiveBudget';

test('REGION:9 个顶层 ID 全部冻结且自顶向下顺序', () => {
  const { REGION } = require(rlPath);
  const topLevelKeys = ['BANNER', 'MAIN', 'SIDEBAR', 'TASK_PANEL', 'COMPLETION_MENU', 'PROMPT', 'FOOTER', 'STATUS_AREA', 'OVERLAY'];
  // 前 9 个 key 必须是顶层(顺序与渲染顺序对齐),其余是 MAIN 子区域
  const allKeys = Object.keys(REGION);
  assert.deepStrictEqual(allKeys.slice(0, topLevelKeys.length), topLevelKeys);
  assert.ok(allKeys.length > topLevelKeys.length, 'REGION 应至少包含顶层 + MAIN 子区域');
  // 同一对象不可写,改了就崩
  assert.throws(() => {
    REGION.NEW = 'new';
  });
});

test('REGION:MAIN 含 16 个子区域(6 大区 + 10 小区),三层结构,点分号命名', () => {
  const { REGION, MAIN_SUBREGIONS } = require(rlPath);
  // 大区(6)在前,小区(10)在后;顺序 = 渲染顺序
  const expectedKeys = [
    // 大区
    'MAIN_TEXT',
    'MAIN_REASONING',
    'MAIN_OUTPUT',
    'MAIN_ACTIVITY',
    'MAIN_TIP',
    'MAIN_SUBVIEW',
    // 小区
    'MAIN_REASONING_LIVE',
    'MAIN_REASONING_COMMITTED',
    'MAIN_OUTPUT_HDR',
    'MAIN_OUTPUT_VIEW',
    'MAIN_OUTPUT_INLINE',
    'MAIN_ACTIVITY_SPINNER',
    'MAIN_ACTIVITY_QUEUE',
    'MAIN_ACTIVITY_STEER',
    'MAIN_ACTIVITY_INTERRUPT',
    'MAIN_TIP_DOUBLE_PRESS',
  ];
  assert.deepStrictEqual(Object.keys(REGION).filter((k) => k.startsWith('MAIN_')), expectedKeys);
  // 所有子 ID 必须是点分号字符串,且以 'main.' 开头
  for (const key of expectedKeys) {
    const value = REGION[key];
    assert.strictEqual(typeof value, 'string', `${key} 必须是 string`);
    assert.match(value, /^main\.[a-z.-]+$/, `${key}=${value} 必须 'main.' 开头 + 仅小写/点/连字符`);
    assert.ok(!value.includes('_'), `${key} 禁止下划线(必须用点分号分层)`);
  }
  // MAIN_SUBREGIONS 数组与 REGION 中 MAIN_* 严格一一对应
  const regMainKeys = Object.keys(REGION)
    .filter((k) => k.startsWith('MAIN_') && k !== 'MAIN')
    .map((k) => REGION[k]);
  assert.deepStrictEqual([...MAIN_SUBREGIONS].sort(), regMainKeys.sort());
});

test('REGION:三层结构 — 大区值是小区值的前缀(层级可推导)', () => {
  const { REGION } = require(rlPath);
  // 大区 → 小区的层级关系:每个小区的值必须以其大区值为前缀
  const pairs = [
    ['MAIN_REASONING', 'MAIN_REASONING_LIVE'],
    ['MAIN_REASONING', 'MAIN_REASONING_COMMITTED'],
    ['MAIN_OUTPUT', 'MAIN_OUTPUT_HDR'],
    ['MAIN_OUTPUT', 'MAIN_OUTPUT_VIEW'],
    ['MAIN_OUTPUT', 'MAIN_OUTPUT_INLINE'],
    ['MAIN_ACTIVITY', 'MAIN_ACTIVITY_SPINNER'],
    ['MAIN_ACTIVITY', 'MAIN_ACTIVITY_QUEUE'],
    ['MAIN_ACTIVITY', 'MAIN_ACTIVITY_STEER'],
    ['MAIN_ACTIVITY', 'MAIN_ACTIVITY_INTERRUPT'],
    ['MAIN_TIP', 'MAIN_TIP_DOUBLE_PRESS'],
  ];
  for (const [parent, child] of pairs) {
    const pv = REGION[parent];
    const cv = REGION[child];
    assert.ok(
      cv.startsWith(pv + '.'),
      `${child}('${cv}') 必须以 ${parent}('${pv}.') 为前缀`
    );
  }
});

test('REGION:25 个 ID 全部存在且字符串唯一(顶层 + 大区 + 小区,无重复)', () => {
  const { REGION } = require(rlPath);
  const values = Object.values(REGION);
  assert.strictEqual(new Set(values).size, values.length, 'REGION 值集合必须无重复');
  // 顶层 9 + MAIN 大区 6 + MAIN 小区 10 = 25
  assert.strictEqual(values.length, 25);
});

test('TOP_LEVEL_ORDER:自顶向下区域顺序与 REGION 顶层一致', () => {
  const { TOP_LEVEL_ORDER, REGION } = require(rlPath);
  assert.deepStrictEqual(
    [...TOP_LEVEL_ORDER],
    [REGION.BANNER, REGION.MAIN, REGION.SIDEBAR, REGION.TASK_PANEL, REGION.COMPLETION_MENU, REGION.PROMPT, REGION.FOOTER, REGION.STATUS_AREA, REGION.OVERLAY]
  );
  // 同一数组不可写
  assert.throws(() => {
    TOP_LEVEL_ORDER.push('hacked');
  });
});

test('OWNING_OVERLAYS:6 个覆盖层 key 全部声明且 hideChrome 类型为 boolean', () => {
  const { OWNING_OVERLAYS } = require(rlPath);
  const expectedKeys = [
    'modelPicker',
    'khyosOpen',
    'rewindPicker',
    'rollbackPicker',
    'formFlow',
    'topologyView',
  ];
  assert.deepStrictEqual(Object.keys(OWNING_OVERLAYS).sort(), expectedKeys.sort());
  for (const key of expectedKeys) {
    const meta = OWNING_OVERLAYS[key];
    assert.strictEqual(typeof meta.hideChrome, 'boolean', `${key}.hideChrome 必须是 boolean`);
    assert.strictEqual(meta.ownsInput, true, `${key}.ownsInput 必须为 true(独占输入)`);
  }
  // modelPicker / khyosOpen 是已确认贴顶的两个,hideChrome 必须为 true
  assert.strictEqual(OWNING_OVERLAYS.modelPicker.hideChrome, true);
  assert.strictEqual(OWNING_OVERLAYS.khyosOpen.hideChrome, true);
  // 其余四个未观测贴顶,保持 false(避免推测性扩大 chrome 隐藏集)
  assert.strictEqual(OWNING_OVERLAYS.rewindPicker.hideChrome, false);
  assert.strictEqual(OWNING_OVERLAYS.rollbackPicker.hideChrome, false);
  assert.strictEqual(OWNING_OVERLAYS.formFlow.hideChrome, false);
  assert.strictEqual(OWNING_OVERLAYS.topologyView.hideChrome, false);
});

test('overlaysHidingChrome:空 flags → 空数组', () => {
  const { overlaysHidingChrome } = require(rlPath);
  assert.deepStrictEqual(overlaysHidingChrome({}), []);
  // null/undefined 入参要降级,不能崩
  assert.deepStrictEqual(overlaysHidingChrome(null), []);
  assert.deepStrictEqual(overlaysHidingChrome(undefined), []);
});

test('overlaysHidingChrome:只列 hideChrome=true 的覆盖层', () => {
  const { overlaysHidingChrome } = require(rlPath);
  assert.deepStrictEqual(overlaysHidingChrome({ modelPicker: true }), ['modelPicker']);
  assert.deepStrictEqual(overlaysHidingChrome({ khyosOpen: true }), ['khyosOpen']);
  // rewindPicker 即使挂载也不进隐藏名单
  assert.deepStrictEqual(overlaysHidingChrome({ rewindPicker: true }), []);
  // 混合:只返回 hideChrome=true 的 key
  assert.deepStrictEqual(
    overlaysHidingChrome({ khyosOpen: true, rewindPicker: true, formFlow: true }),
    ['khyosOpen']
  );
});

test('ownsLiveRegion(overlayLiveBudget)与 regionLayout.overlaysHidingChrome 判定一致', () => {
  const { overlaysHidingChrome } = require(rlPath);
  const { ownsLiveRegion, isEnabled } = require(ovPath);
  // 仅在 gate 开时验证(默认开)
  if (!isEnabled({})) {
    return;
  }
  const cases = [
    { flags: {}, expect: false },
    { flags: { modelPicker: true }, expect: true },
    { flags: { khyosOpen: true }, expect: true },
    { flags: { rewindPicker: true }, expect: false },
    { flags: { topologyView: true }, expect: false },
    { flags: { khyosOpen: true, rewindPicker: true }, expect: true },
  ];
  for (const c of cases) {
    const got = ownsLiveRegion(c.flags);
    assert.strictEqual(got, c.expect, `ownsLiveRegion(${JSON.stringify(c.flags)}) 应为 ${c.expect}`);
    // 与 regionLayout 的隐藏名单同源同口径
    const hiding = overlaysHidingChrome(c.flags);
    assert.strictEqual(got, hiding.length > 0);
  }
});

test('sidebarTopAnchorRows:WelcomeBanner 缺失/为 0 时降级为 0(永不抛)', () => {
  const { sidebarTopAnchorRows } = require(rlPath);
  // 不应抛,任何状态下都返回 ≥0 的整数
  const rows = sidebarTopAnchorRows();
  assert.ok(Number.isFinite(rows));
  assert.ok(rows >= 0);
});

test('railCols:effectiveCols.stickyCols 缺失时降级为 null(永不抛)', () => {
  const { railCols } = require(rlPath);
  // effectiveCols 可能不存在 / stickyCols 不是函数,都不应抛
  const cols = railCols();
  assert.ok(cols === null || Number.isFinite(cols));
});