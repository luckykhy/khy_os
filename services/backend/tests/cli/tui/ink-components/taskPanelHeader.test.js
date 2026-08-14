'use strict';

/**
 * 刀28 — taskPanelHeader:常驻任务清单面板头行按状态计数(对齐 CC TaskListV2.tsx
 * isStandalone 头行 `{N} tasks ({done} done, [{ip} in progress, ]{open} open)`)。
 * 诚实红线:计数覆盖全量(可见 + 隐藏);任一行无法识别图标 / 隐藏数与隐藏行不一致 /
 * 门控关 → 返 ''(调用方回退静态标题 `任务清单`)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  taskPanelHeaderEnabled,
  buildTaskPanelHeader,
} = require('../../../../src/cli/tui/ink-components/taskPanelHeader');

// 行首图标与 taskPanelLines.panelStatusIcon 写入的一致:✓ 完成 / → 进行中 / ○ 待办 / ✗ 错误。
const C = (d) => `✓ ${d}`;
const P = (d) => `○ ${d}`;
const I = (d) => `→ ${d}`;
const E = (d) => `✗ ${d}`;

describe('taskPanelHeaderEnabled — 门控梯', () => {
  test('默认(unset)开', () => {
    assert.equal(taskPanelHeaderEnabled({}), true);
  });
  test('=0/false/off/no 关', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      assert.equal(taskPanelHeaderEnabled({ KHY_TASK_PANEL_HEADER: v }), false);
    }
  });
  test('其余值开', () => {
    assert.equal(taskPanelHeaderEnabled({ KHY_TASK_PANEL_HEADER: '1' }), true);
    assert.equal(taskPanelHeaderEnabled({ KHY_TASK_PANEL_HEADER: 'yes' }), true);
  });
});

describe('buildTaskPanelHeader — CC 头行计数(standalone,无隐藏)', () => {
  const ON = { KHY_TASK_PANEL_HEADER: '1' };

  test('完成总在 + 进行中(>0) + 待办总在', () => {
    const lines = [C('a'), I('b'), P('c'), P('d')];
    assert.equal(buildTaskPanelHeader({ lines }, ON), '任务清单（共 4 项:1 完成、1 进行中、2 待办）');
  });

  test('进行中为 0 → 不出现该段(对齐 CC inProgressCount>0)', () => {
    const lines = [C('a'), P('b'), P('c')];
    assert.equal(buildTaskPanelHeader({ lines }, ON), '任务清单（共 3 项:1 完成、2 待办）');
  });

  test('完成/待办为 0 仍展示(对齐 CC done/open 总在)', () => {
    const lines = [I('a')];
    assert.equal(buildTaskPanelHeader({ lines }, ON), '任务清单（共 1 项:0 完成、1 进行中、0 待办）');
  });

  test('khy 诚实扩展:error(✗)仅 >0 才出现', () => {
    const lines = [C('a'), E('b'), P('c')];
    assert.equal(buildTaskPanelHeader({ lines }, ON), '任务清单（共 3 项:1 完成、1 待办、1 错误）');
  });

  test('全完成', () => {
    const lines = [C('a'), C('b')];
    assert.equal(buildTaskPanelHeader({ lines }, ON), '任务清单（共 2 项:2 完成、0 待办）');
  });
});

describe('buildTaskPanelHeader — coordinated 模式(可见 + 隐藏全量计数)', () => {
  const ON = { KHY_TASK_PANEL_HEADER: '1' };

  test('计数覆盖可见 lines + 隐藏 hiddenLines', () => {
    const lines = [I('visible-ip'), P('visible-pending')];
    const hiddenLines = [C('h1'), C('h2'), P('h3')];
    const out = buildTaskPanelHeader({ lines, hidden: 3, hiddenLines }, ON);
    // total=5:完成2 进行中1 待办2
    assert.equal(out, '任务清单（共 5 项:2 完成、1 进行中、2 待办）');
  });

  test('诚实红线:hidden>0 但 hiddenLines 长度不符 → 回退空(绝不少计)', () => {
    const lines = [C('a')];
    assert.equal(buildTaskPanelHeader({ lines, hidden: 3, hiddenLines: [P('x')] }, ON), '');
    assert.equal(buildTaskPanelHeader({ lines, hidden: 2, hiddenLines: undefined }, ON), '');
  });

  test('hidden=0 + 无 hiddenLines → 仅按可见计数', () => {
    const lines = [C('a'), P('b')];
    assert.equal(buildTaskPanelHeader({ lines, hidden: 0 }, ON), '任务清单（共 2 项:1 完成、1 待办）');
  });
});

describe('buildTaskPanelHeader — 诚实回退 / 防呆', () => {
  const ON = { KHY_TASK_PANEL_HEADER: '1' };

  test('任一行行首非已知图标 → 回退空(绝不静默归类)', () => {
    assert.equal(buildTaskPanelHeader({ lines: [C('a'), '?? mystery'] }, ON), '');
    assert.equal(buildTaskPanelHeader({ lines: ['- bare bullet'] }, ON), '');
  });

  test('隐藏行有未知图标 → 回退空', () => {
    const lines = [C('a')];
    assert.equal(buildTaskPanelHeader({ lines, hidden: 1, hiddenLines: ['x weird'] }, ON), '');
  });

  test('空清单 → 空(调用方本就 return null)', () => {
    assert.equal(buildTaskPanelHeader({ lines: [] }, ON), '');
    assert.equal(buildTaskPanelHeader({}, ON), '');
  });

  test('门控关 → 空(调用方回退静态标题)', () => {
    const off = { KHY_TASK_PANEL_HEADER: '0' };
    assert.equal(buildTaskPanelHeader({ lines: [C('a'), P('b')] }, off), '');
  });

  test('默认(unset env)开 → 产标题', () => {
    assert.equal(buildTaskPanelHeader({ lines: [C('a')] }, {}), '任务清单（共 1 项:1 完成、0 待办）');
  });

  test('防呆:非对象 opts → 空不抛', () => {
    assert.equal(buildTaskPanelHeader(null, ON), '');
    assert.equal(buildTaskPanelHeader('foo', ON), '');
    assert.equal(buildTaskPanelHeader(42, ON), '');
  });

  test('total === lines.length + hidden(诚实总数)', () => {
    const lines = [C('a'), I('b')];
    const hiddenLines = [P('c'), P('d'), C('e')];
    const out = buildTaskPanelHeader({ lines, hidden: 3, hiddenLines }, ON);
    assert.match(out, /共 5 项/);
  });
});
