'use strict';

// taskLineStyle — 常驻任务面板每行 Ink 样式 SSOT(刀23)。
// 对齐 CC TaskListV2.tsx::TaskItem 的 strikethrough={isCompleted}:已完成(✓)行
// 划线。门控 KHY_TASK_STRIKETHROUGH 默认开;关 → 不加 strikethrough,逐字节回退
// 历史 _iconStyle(仅 color/bold/dimColor)。
const test = require('node:test');
const assert = require('node:assert/strict');

const { taskStrikethroughEnabled, taskLineStyle } = require('../../src/cli/tui/ink-components/taskLineStyle');

function withGate(value, fn) {
  const saved = process.env.KHY_TASK_STRIKETHROUGH;
  if (value === undefined) delete process.env.KHY_TASK_STRIKETHROUGH;
  else process.env.KHY_TASK_STRIKETHROUGH = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.KHY_TASK_STRIKETHROUGH;
    else process.env.KHY_TASK_STRIKETHROUGH = saved;
  }
}

test('门控开(默认):completed(✓)行 = green+dim+strikethrough', () => {
  withGate(undefined, () => {
    assert.deepEqual(taskLineStyle('✓ #1 写测试'), {
      color: 'green', dimColor: true, strikethrough: true,
    });
  });
});

test('门控开:其余状态样式不变(仅 completed 受影响)', () => {
  withGate(undefined, () => {
    assert.deepEqual(taskLineStyle('→ #2 跑构建'), { color: 'cyan', bold: true });
    assert.deepEqual(taskLineStyle('✗ #3 失败'), { color: 'red' });
    assert.deepEqual(taskLineStyle('○ #4 待办'), { dimColor: true });
    assert.deepEqual(taskLineStyle('plain V1 row'), {});
  });
});

test('门控关:completed 逐字节回退 legacy(无 strikethrough)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    withGate(off, () => {
      assert.deepEqual(taskLineStyle('✓ #1 写测试'), { color: 'green', dimColor: true });
      assert.equal(taskStrikethroughEnabled(), false);
      // 其余状态两态恒等
      assert.deepEqual(taskLineStyle('→ x'), { color: 'cyan', bold: true });
      assert.deepEqual(taskLineStyle('○ y'), { dimColor: true });
    });
  }
});

test('门控梯:大小写/空白/真值不当关', () => {
  assert.equal(taskStrikethroughEnabled({}), true);                          // 未设 → 默认开
  assert.equal(taskStrikethroughEnabled({ KHY_TASK_STRIKETHROUGH: '' }), true);
  assert.equal(taskStrikethroughEnabled({ KHY_TASK_STRIKETHROUGH: '1' }), true);
  assert.equal(taskStrikethroughEnabled({ KHY_TASK_STRIKETHROUGH: 'on' }), true);
  assert.equal(taskStrikethroughEnabled({ KHY_TASK_STRIKETHROUGH: '  OFF  ' }), false);
  assert.equal(taskStrikethroughEnabled({ KHY_TASK_STRIKETHROUGH: 'No' }), false);
  assert.equal(taskStrikethroughEnabled({ KHY_TASK_STRIKETHROUGH: '0' }), false);
});

test('唯一发散点:仅 completed(✓)两态不同,其余状态两态恒等', () => {
  for (const line of ['→ a', '✗ b', '○ c', 'raw']) {
    const on = withGate(undefined, () => taskLineStyle(line));
    const off = withGate('0', () => taskLineStyle(line));
    assert.deepEqual(on, off); // 非 completed 行两态一致
  }
  const compOn = withGate(undefined, () => taskLineStyle('✓ done'));
  const compOff = withGate('0', () => taskLineStyle('✓ done'));
  assert.equal(compOn.strikethrough, true);
  assert.equal(compOff.strikethrough, undefined); // 唯一发散点
});

test('行首前导空白容忍(trimStart 后取首字符)', () => {
  withGate(undefined, () => {
    assert.equal(taskLineStyle('   ✓ 缩进的已完成行').strikethrough, true);
  });
});
