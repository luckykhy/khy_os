'use strict';

// toolHeaderCap — per-key arg-summary length cap SSOT (刀22).
// 对齐 CC 的按工具头展示:Bash `command` 头按 MAX_COMMAND_DISPLAY_CHARS=160,
// 其余 key 保留 Khy legacy 60(多数 ≥ CC per-tool 上限,不降级)。门控
// KHY_TOOL_HEADER_CAP 默认开;关 → 每个 key 恒 60 字节回退。
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_COMMAND_DISPLAY_CHARS,
  LEGACY_ARG_CAP,
  toolHeaderCapEnabled,
  argDisplayCap,
} = require('../../src/cli/toolHeaderCap');

function withGate(value, fn) {
  const saved = process.env.KHY_TOOL_HEADER_CAP;
  if (value === undefined) delete process.env.KHY_TOOL_HEADER_CAP;
  else process.env.KHY_TOOL_HEADER_CAP = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.KHY_TOOL_HEADER_CAP;
    else process.env.KHY_TOOL_HEADER_CAP = saved;
  }
}

test('常量对齐 CC:命令头 160、legacy 60', () => {
  assert.equal(MAX_COMMAND_DISPLAY_CHARS, 160); // CC BashTool/UI.tsx
  assert.equal(LEGACY_ARG_CAP, 60);
});

test('门控开(默认):command/cmd → 160,其余 key → 60', () => {
  withGate(undefined, () => {
    assert.equal(argDisplayCap('command'), 160);
    assert.equal(argDisplayCap('cmd'), 160);
    assert.equal(argDisplayCap('pattern'), 60); // grep:Khy 60 > CC 50 不降级
    assert.equal(argDisplayCap('query'), 60);
    assert.equal(argDisplayCap('url'), 60);
    assert.equal(argDisplayCap('prompt'), 60);
    assert.equal(argDisplayCap('description'), 60);
    assert.equal(argDisplayCap('file_path'), 60);
  });
});

test('门控关:每个 key 恒 60(byte-identical legacy)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    withGate(off, () => {
      assert.equal(argDisplayCap('command'), 60); // 唯一发散点回退
      assert.equal(argDisplayCap('cmd'), 60);
      assert.equal(argDisplayCap('pattern'), 60);
      assert.equal(argDisplayCap('query'), 60);
      assert.equal(toolHeaderCapEnabled(), false);
    });
  }
});

test('门控梯:大小写/空白/真值不当关', () => {
  assert.equal(toolHeaderCapEnabled({}), true);                  // 未设 → 默认开
  assert.equal(toolHeaderCapEnabled({ KHY_TOOL_HEADER_CAP: '' }), true);
  assert.equal(toolHeaderCapEnabled({ KHY_TOOL_HEADER_CAP: '1' }), true);
  assert.equal(toolHeaderCapEnabled({ KHY_TOOL_HEADER_CAP: 'on' }), true);
  assert.equal(toolHeaderCapEnabled({ KHY_TOOL_HEADER_CAP: '  OFF  ' }), false);
  assert.equal(toolHeaderCapEnabled({ KHY_TOOL_HEADER_CAP: 'No' }), false);
  assert.equal(toolHeaderCapEnabled({ KHY_TOOL_HEADER_CAP: '0' }), false);
});

test('唯一发散点:仅 command/cmd 两态不同,其余 key 两态恒 60', () => {
  for (const key of ['pattern', 'query', 'url', 'prompt', 'description', 'file_path', 'anything']) {
    const on = withGate(undefined, () => argDisplayCap(key));
    const off = withGate('0', () => argDisplayCap(key));
    assert.equal(on, off);   // 非命令 key 两态一致
    assert.equal(on, 60);
  }
  for (const key of ['command', 'cmd']) {
    assert.equal(withGate(undefined, () => argDisplayCap(key)), 160);
    assert.equal(withGate('0', () => argDisplayCap(key)), 60);
  }
});
